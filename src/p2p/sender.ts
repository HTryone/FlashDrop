// 发送端编排：connect → 发 manifest → 逐文件逐块 encrypt → 经 DC 子帧发送 → ack 窗口推进 → 完成。
// 加密用 P2P 专用 WebCrypto 模块（src/p2p/p2p-crypto），与 HTTP 链路（crypto-js）完全隔离；
// 区块格式 [16B IV][ct][32B HMAC] 与 HTTP 一致，故帧头解析逻辑共用、加解密原语独立。
import { PeerLink } from './peer';
import { SignalingClient } from './signaling';
import { fetchIceServers } from './ice';
import { buildFrameHdr } from './framing';
import { sendSubFrames } from './channel';
import { FRAME_HDR, P2P_CHUNK_SIZE } from './types';
import { deriveP2PKey, encryptP2PChunk, type P2PCryptoCtx } from './p2p-crypto';
import type { SenderOpts, P2PState, P2PFileMeta } from './types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface P2PSender {
  connect(): Promise<void>;
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
    void pump();
  }

  // ── 预加密前瞻缓冲 ──
  // DC 发送当前块时，Worker 已在加密后续块，消除「等加密完才能发」的串行等待。
  // 用模块级游标 nextEncryptSeq 确保每个 seq 只加密一次（避免重复发送同一帧）。
  const PRE_ENCRYPT_AHEAD = 2;
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
        // 注意：不保留应用层在途窗口——DC 原生 bufferedAmount 背压(drainDc)已足够限速，
        // 叠加 FlowWindow 属人为冗余节流，去掉后发送端只受接收端消费速度 + 原生背压约束。
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
        } else {
          // dc 未就绪 → 等
          encQueue.unshift({ seq: next, frame });
          await sleep(20);
        }
      }
      if (!aborted) {
        finished = true;
        setState('done');
      }
    } catch (e: any) {
      if (!aborted) {
        finished = true;
        setState('error', e?.message || String(e));
        opts.onFail?.(e instanceof Error ? e : new Error(String(e)));
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
    } catch { /* ignore */ }
  }

  async function connect(): Promise<void> {
    cryptoCtx = await deriveP2PKey(opts.pass);
    setState('signaling');
    sig = new SignalingClient({
      relayBase: opts.relayBase,
      room: opts.room,
      role: 'sender',
      onSignal: (d) => peer?.onSignal(d),
      onReconnecting: () => setState('signaling', '信令重连中'),
    });
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
    });
    sig.connect();
    peer.connect(ice);
  }

  function abort() {
    aborted = true;
    peer?.destroy();
    sig?.close();
    setState('aborted');
  }

  return { connect, abort };
}
