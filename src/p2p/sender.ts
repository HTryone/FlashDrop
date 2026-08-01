// 发送端编排：connect → 发 manifest → 逐文件逐块 encrypt → 经 DC 子帧发送 → ack 窗口推进 → 完成。
// 复用现有 E2EE（deriveKey / encryptChunkAsync / LOCAL_CHUNK_SIZE / LOCAL_SALT），帧头与 HTTP 完全一致。
import { PeerLink } from './peer';
import { SignalingClient } from './signaling';
import { fetchIceServers } from './ice';
import { buildFrameHdr } from './framing';
import { FlowWindow, sendSubFrames } from './channel';
import { FRAME_HDR, WINDOW_FRAMES, P2P_CHUNK_SIZE } from './types';
import { deriveKey, LOCAL_SALT } from '@/crypto/e2ee';
import { encryptChunkAsync } from '@/composables/useLocalCrypto';
import type { SenderOpts, P2PState, P2PFileMeta } from './types';

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
  let keyHex = '';
  let dc: RTCDataChannel | null = null;
  let sentSeq = -1;
  let sentBytes = 0;
  let finished = false;
  let aborted = false;
  let pumping = false;
  const flow = new FlowWindow();

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
        const enc = new Uint8Array(await encryptChunkAsync(chunkBuf, keyHex));
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

      while (!aborted && !finished && flow.lastAcked < totalChunks - 1) {
        // 队列空了 → 预加密更多或等 ack
        if (encQueue.length === 0) {
          await preEncrypt();
          if (encQueue.length === 0) { await flow.waitForAck(); continue; }
        }

        // 检查在途窗口
        const inflight = sentSeq - flow.lastAcked;
        if (inflight >= WINDOW_FRAMES) {
          await flow.waitForAck();
          continue;
        }

        // 取出已加密的帧发送
        const { seq: next, frame } = encQueue.shift()!;
        if (dc && dc.readyState === 'open') {
          const ok = await sendSubFrames(dc, frame);
          if (!ok) {
            // 发送失败：放回队首，等 ack 后重试
            encQueue.unshift({ seq: next, frame });
            await flow.waitForAck();
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
          await flow.waitForAck();
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
      if (msg.type === 'ack') flow.noteAck(msg.seq);
      else if (msg.type === 'done') finished = true;
    } catch { /* ignore */ }
  }

  async function connect(): Promise<void> {
    keyHex = await deriveKey(opts.pass, LOCAL_SALT);
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
        sentSeq = flow.lastAcked;
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
