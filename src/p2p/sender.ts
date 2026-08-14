// 发送端编排：connect → 发 manifest → 逐文件逐块 encrypt → 经 DC 子帧发送 → ack 窗口推进 → 完成。
// 加密用 P2P 专用 WebCrypto 模块（src/crypto/p2p-crypto），与 HTTP 链路（crypto-js）完全隔离；
// 区块格式 [16B IV][ct][32B HMAC] 与 HTTP 一致，故帧头解析逻辑共用、加解密原语独立。
import { PeerLink } from './peer';
import { SignalingClient } from './signaling';
import { fetchIceServers } from './ice';
import { buildFrameHdr } from './framing';
import { sendSubFrames } from './channel';
import { FRAME_HDR, P2P_CHUNK_SIZE } from './types';
import { deriveP2PKey, encryptP2PChunk, type P2PCryptoCtx } from '../crypto/p2p-crypto';
import type { SenderOpts, P2PState, P2PFileMeta } from './types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface P2PSender {
  connect(externalSig?: SignalingClient): Promise<void>;
  abort(): void;
}

export function createP2PSender(opts: SenderOpts): P2PSender {
  const files = opts.files;
  const metas: P2PFileMeta[] = files.map((f) => ({ name: f.name, size: f.size }));
  const totalBytes = files.reduce((a, f) => a + f.size, 0);

  const perFileChunks: number[] = [];
  let totalChunks = 0;
  for (const f of files) {
    const c = Math.max(1, Math.ceil(f.size / P2P_CHUNK_SIZE));
    perFileChunks.push(c);
    totalChunks += c;
  }

  let peer: PeerLink | null = null;
  let sig: SignalingClient | null = null;
  let cryptoCtx: P2PCryptoCtx | null = null;
  let dc: RTCDataChannel | null = null;
  let sentSeq = -1;
  let sentBytes = 0;
  let lastAcked = -1; // 接收端已确认的最高全局序号（仅作断线续传游标，不用于应用层流控）
  let finished = false;
  let aborted = false;
  let pumping = false;

  const setState = (s: P2PState, d?: string) => opts.onState?.(s, d);

  const seqToFileChunk = (seq: number) => {
    let s = seq;
    for (let fi = 0; fi < perFileChunks.length; fi++) {
      if (s < perFileChunks[fi]) return { fi, ci: s };
      s -= perFileChunks[fi];
    }
    const last = perFileChunks.length - 1;
    return { fi: last, ci: Math.max(0, perFileChunks[last] - 1) };
  };

  function onDcOpen(d: RTCDataChannel) {
    dc = d;
    setState('connected');
    // 每次 DC 建立都重发 manifest（含重连后新 DC），接收端幂等覆盖
    d.send(JSON.stringify({ type: 'manifest', files: metas, totalBytes }));
    // 进入发送态：DC 已开、manifest 已发，紧接着 pump() 开始逐块发数据。
    // 让 UI 顶部总状态从「待发送」切到「传输中」（区别于 signaling/connecting/connected 阶段）。
    setState('transferring');
    void pump();
  }

  // ── 预加密前瞻缓冲 ──
  // DC 发送当前块时，Worker 已在加密后续块，消除「等加密完才能发」的串行等待。
  // 用模块级游标 nextEncryptSeq 确保每个 seq 只加密一次（避免重复发送同一帧）。
  const PRE_ENCRYPT_AHEAD = 4;
  type EncryptedChunk = { seq: number; frame: Uint8Array };
  let encQueue: EncryptedChunk[] = [];  // 已加密待发送的帧队列
  let encrypting = false;               // 是否有预加密任务在跑
  let nextEncryptSeq = 0;               // 下一个该被加密的全局序号

  async function preEncrypt() {
    if (encrypting) return;
    encrypting = true;
    try {
      while (encQueue.length < PRE_ENCRYPT_AHEAD && nextEncryptSeq < totalChunks) {
        const next = nextEncryptSeq;
        const { fi, ci } = seqToFileChunk(next);
        const file = files[fi];
        const offset = ci * P2P_CHUNK_SIZE;
        const end = Math.min(offset + P2P_CHUNK_SIZE, file.size);
        const plainLen = end - offset;
        const chunkBuf = await file.slice(offset, end).arrayBuffer();
        const enc = new Uint8Array(await encryptP2PChunk(new Uint8Array(chunkBuf), cryptoCtx!));
        const hdr = buildFrameHdr(fi, ci, plainLen);
        const frame = new Uint8Array(FRAME_HDR + enc.length);
        frame.set(hdr, 0);
        frame.set(enc, FRAME_HDR);
        encQueue.push({ seq: next, frame });
        nextEncryptSeq++; // ← 游标前进，永不重复
      }
    } finally {
      encrypting = false;
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      // 启动初始预加密（加密前 PRE_ENCRYPT_AHEAD 块）
      await preEncrypt();

      while (!aborted && !finished && lastAcked < totalChunks - 1) {
        // 队列空了 → 预加密更多；全部已发则短轮询等最终 ack。
        // 注意：曾用应用层在途窗口，已移除——DC 原生 bufferedAmount 背压(drainDc)已足够限速，
        // 叠加应用层窗口属人为冗余节流，去掉后发送端只受接收端消费速度 + 原生背压约束。
        if (encQueue.length === 0) {
          await preEncrypt();
          if (encQueue.length === 0) { await sleep(10); continue; }
        }

        // 取出已加密的帧发送
        const { seq: next, frame } = encQueue.shift()!;
        if (dc && dc.readyState === 'open') {
          const ok = await sendSubFrames(dc, frame);
          if (!ok) {
            // 发送失败：放回队首，稍后重试（由 DC 原生背压重新放行）
            encQueue.unshift({ seq: next, frame });
            await sleep(20);
            continue;
          }
          sentSeq = next;
          sentBytes += next === totalChunks - 1
            ? (files[files.length - 1].size - seqToFileChunk(next).ci * P2P_CHUNK_SIZE)
            : P2P_CHUNK_SIZE;
          opts.onProgress?.({ sent: sentBytes, received: 0, total: totalBytes });

          // 后台补充预加密（不阻塞发送循环）
          void preEncrypt();
        } else if (!dc || dc.readyState === 'closed' || dc.readyState === 'closing') {
          // 对端断开（取消/掉线）且未显式收到 cancel 帧：立即中止，避免无限空转
          if (!aborted) {
            aborted = true; finished = true;
            peer?.destroy(); sig?.close();
            setState('error', '连接已断开，传输中止');
          }
          break;
        } else {
          // dc 未就绪 → 等
          encQueue.unshift({ seq: next, frame });
          await sleep(20);
        }
      }
      if (!aborted) {
        finished = true;
        // 显式广播传输结束，让接收端无论是否收齐最后一块都能进入收尾态，
        // 避免息屏重连场景下最后一块 ack 丢失导致两端状态不一致（发送端已 done、接收端卡中间态）。
        if (dc && dc.readyState === 'open') {
          try { dc.send(JSON.stringify({ type: 'done' })); } catch { /* ignore */ }
        }
        setState('done');
        // 传输完成即释放 WebRTC 连接与信令 WS，避免孤儿连接堆积（延迟确保 done 帧先发出）
        setTimeout(() => { peer?.destroy(); sig?.close(); }, 150);
      }
    } catch (e: any) {
      if (!aborted) {
        finished = true;
        setState('error', e?.message || String(e));
        opts.onFail?.(e instanceof Error ? e : new Error(String(e)));
        // 异常路径同样释放连接，避免泄漏（无待发帧，立即销毁）
        peer?.destroy(); sig?.close();
      }
    } finally {
      pumping = false;
    }
  }

  function onDcMessage(data: string | ArrayBuffer) {
    if (typeof data !== 'string') return; // 二进制都是数据子帧，sender 不收
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ack') { if (msg.seq > lastAcked) lastAcked = msg.seq; }
      else if (msg.type === 'done') finished = true;
      else if (msg.type === 'cancel') remoteAbort('对方已取消接收');
    } catch { /* ignore */ }
  }

  async function connect(externalSig?: SignalingClient): Promise<void> {
    cryptoCtx = await deriveP2PKey(opts.pass);
    setState('signaling');
    // ownSig 标记 sig 是否为本次自己创建：失败时只关 ownSig，绝不关复用的 externalSig，
    // 否则会误杀对方仍在使用的信令 WS（genRoom 时提前连好的 p2pEarlySig）。
    let ownSig = false;
    try {
      if (externalSig) {
        // 复用提前连好的信令 WS（genRoom 时已连），重新接线到本 PeerLink
        sig = externalSig;
        sig.setOnSignal((d) => peer?.onSignal(d));
      } else {
        sig = new SignalingClient({
          relayBase: opts.relayBase,
          room: opts.room,
          role: 'sender',
          onSignal: (d) => peer?.onSignal(d),
          onReconnecting: () => setState('signaling', '信令重连中'),
          onPeerConnected: (role) => { if (role === 'receiver') opts.onPeerPresent?.('receiver'); },
        });
        sig.connect();
        ownSig = true;
      }
      const ice = await fetchIceServers(opts.relayBase, opts.relayBase.startsWith('https') ? 'wss' : 'ws');
      peer = new PeerLink({
        role: 'sender',
        sendSignal: (d) => sig?.send(d),
        onDcOpen,
        onDcMessage,
        onState: (c) => {
          if (c) setState('connecting');
        },
        onReconnect: () => {
          // 重连后续传：从已确认的最高序号之后继续，不重发已落盘帧
          sentSeq = lastAcked;
        },
        onPeerJoined: () => opts.onPeerJoined?.(),
      });
      peer.connect(ice);
    } catch (e: any) {
      // 建连阶段失败（如取 ICE 失败）：释放本次新建的资源，避免信令 WS 残留自动重连形成僵尸连接。
      // peer 始终为本次新建，可安全销毁；sig 仅 ownSig 时才关，复用的 externalSig 不动。
      if (ownSig) sig?.close();
      peer?.destroy();
      throw e;
    }
  }

  function abort() {
    aborted = true;
    if (dc && dc.readyState === 'open') {
      try { dc.send(JSON.stringify({ type: 'cancel' })); } catch { /* ignore */ }
    }
    // 延迟销毁，确保 cancel 帧先经 DC 发出，对方能收到"已取消"
    setTimeout(() => { peer?.destroy(); sig?.close(); }, 150);
    setState('aborted');
  }

  function remoteAbort(reason: string) {
    if (aborted) return;
    aborted = true;
    peer?.destroy();
    sig?.close();
    setState('aborted', reason);
  }

  return { connect, abort };
}
