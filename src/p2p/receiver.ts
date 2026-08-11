// 接收端编排：connect → 收 manifest → 收 DC 子帧重组 → 解密 → 顺序写盘 → 回 ack → 完成。
// 顺序写盘用单消费者队列保证（DC 虽有序，但解密 await 并发可能乱序，故串行处理）。
import { PeerLink } from './peer';
import { SignalingClient } from './signaling';
import { fetchIceServers } from './ice';
import { readFrameHdr } from './framing';
import { Reassembler } from './channel';
import { createSink, Sink } from './sinks';
import { FRAME_HDR, P2P_CHUNK_SIZE } from './types';
import { deriveP2PKey, decryptP2PChunk, type P2PCryptoCtx } from '../crypto/p2p-crypto';
import type { ReceiverOpts, P2PState, P2PFileMeta } from './types';

export interface P2PReceiver {
  connect(): Promise<void>;
  abort(): void;
}

export function createP2PReceiver(opts: ReceiverOpts): P2PReceiver {
  let peer: PeerLink | null = null;
  let sig: SignalingClient | null = null;
  let cryptoCtx: P2PCryptoCtx | null = null;
  let sink: Sink | null = null;
  let files: P2PFileMeta[] = [];
  let totalBytes = 0;
  let perFileChunks: number[] = [];
  let totalChunks = 0;
  let recvBytes = 0;
  let lastAcked = -1;
  let finished = false;
  let senderDone = false; // 发送端已显式广播传输结束（收到 type:'done'）
  let aborted = false;
  let dc: RTCDataChannel | null = null;
  const reasm = new Reassembler();

  const ACK_EVERY = 8;
  let sinceAck = 0;

  const queue: Uint8Array[] = [];
  let draining = false;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // ── 写盘与解密彻底解耦：解密作生产者，独立 writeLoop 作消费者 ──
  // 旧瓶颈根因：drainQueue 里 `await sink.writeChunk` 把整个解密循环卡死，
  // 8MB 合并写盘 IPC 期间解密被挂起 → 磁盘 69% 空闲、均速仅 10MB/s 的梯形震荡。
  // 现在解密完立即入写队列返回，writeLoop 串行落盘，解密持续满速生产，
  // 写队列有上限(MAX_WRITE_QUEUE)反压，慢盘时暂停解密，内存有界不溢出。
  interface WriteJob { fi: number; plain: Uint8Array; position: number; seq: number; }
  const writeQueue: WriteJob[] = [];
  let writeLoopRunning = false;
  let decryptDone = false;
  const MAX_WRITE_QUEUE = 4; // 写队列上限（块数）：4×4MB ≈ 16MB，慢盘反压用

  const setState = (s: P2PState, d?: string) => opts.onState?.(s, d);

  // 收尾判定：发送端已广播结束 且 本地已收齐全部字节 → 完成。
  // 不依赖「最后一块 seq 恰好到达」的单点触发，recvBytes 到顶即兜底完成，
  // 避免最后一块在息屏重连边界丢失时两端状态不一致（发送端 done、接收端卡中间态）。
  const checkComplete = () => {
    if (senderDone && !finished && recvBytes >= totalBytes) {
      finished = true;
      setState('done');
    }
  };

  const seqOf = (fi: number, ci: number) => {
    let s = 0;
    for (let i = 0; i < fi; i++) s += perFileChunks[i] || 0;
    return s + ci;
  };

  function sendAck() {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'ack', seq: lastAcked }));
  }

  type DecryptSlot = {
    fi: number; ci: number; plainLen: number; seq: number;
    decryptP: Promise<Uint8Array> | null; // 正在解密的 promise
  };
  let decrypting: DecryptSlot | null = null; // 当前正在解密（CPU）的槽位

  // 独立写盘消费者：只串行落盘 + 更新进度/ack/完成，绝不阻塞解密生产
  async function ensureWriteLoop() {
    if (writeLoopRunning) return;
    writeLoopRunning = true;
    try {
      while (writeQueue.length || (!decryptDone && (queue.length || decrypting))) {
        if (aborted) break;
        if (writeQueue.length === 0) { await sleep(2); continue; }
        const job = writeQueue.shift()!;
        if (sink) {
          await sink.writeChunk(job.fi, job.plain, job.position);
          recvBytes += job.plain.byteLength;
          checkComplete(); // 收齐即完成（配合 senderDone 兜底，不依赖单点 seq 触发）
          if (job.seq > lastAcked) lastAcked = job.seq;
          opts.onProgress?.({ sent: 0, received: recvBytes, total: totalBytes });
          sinceAck++;
          if (sinceAck >= ACK_EVERY || job.seq >= totalChunks - 1) {
            sinceAck = 0;
            sendAck();
          }
          if (job.seq >= totalChunks - 1 && !finished) {
            finished = true;
            await sink.close();
            if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'done' }));
            setState('done');
          }
        }
      }
    } finally {
      writeLoopRunning = false;
    }
  }

  async function drainQueue() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length || decrypting) {
        if (aborted) break;

        // 1) 解密槽空、队列有帧 → 启动新解密（不 await 写盘，写完即入写队列返回）
        if (!decrypting && queue.length) {
          const f = queue.shift()!;
          const { fi, ci, plainLen } = readFrameHdr(f);
          const body = f.subarray(FRAME_HDR);
          const bodyBuf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
          const seq = seqOf(fi, ci);
          decrypting = {
            fi, ci, plainLen, seq,
            decryptP: decryptP2PChunk(new Uint8Array(bodyBuf), cryptoCtx!, plainLen).catch((e: any) => {
              setState('error', '解密失败: ' + (e?.message || String(e)));
              opts.onFail?.(e instanceof Error ? e : new Error(String(e)));
              return new Uint8Array(0); // 错误占位，后续检查长度跳过
            }),
          };
          continue; // 立刻取下一帧，让解密持续满速
        }

        // 2) 解密槽在飞 → 等完成，然后非阻塞入写队列（关键解耦点）
        if (decrypting && decrypting.decryptP !== null) {
          const buf = await decrypting.decryptP;
          const slot = decrypting;
          decrypting = null;
          const plain = buf.subarray(0, slot.plainLen);
          // 写队列反压：慢盘时暂停解密，防止内存无限堆积
          while (writeQueue.length >= MAX_WRITE_QUEUE && !aborted) await sleep(5);
          writeQueue.push({ fi: slot.fi, plain, position: slot.ci * P2P_CHUNK_SIZE, seq: slot.seq });
          void ensureWriteLoop();
          continue;
        }

        // 无数据可处理 → 极短让出
        await new Promise(r => setTimeout(r, 1));
      }
      decryptDone = true;
      void ensureWriteLoop();
    } finally {
      draining = false;
    }
  }

  function onDcOpen(d: RTCDataChannel) {
    dc = d;
    setState('connected');
    // manifest 已在 dc open 后由发送端首条字符串消息送达；reconnect 后会再次送达（幂等）
    checkComplete(); // 重连后若已收齐（senderDone 且 recvBytes 到顶）补触发完成态
  }

  async function onDcMessage(data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      let msg: any;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === 'manifest') {
        files = msg.files as P2PFileMeta[];
        totalBytes = msg.totalBytes || files.reduce((a, f) => a + f.size, 0);
        perFileChunks = files.map((f) => Math.max(1, Math.ceil(f.size / P2P_CHUNK_SIZE)));
        totalChunks = perFileChunks.reduce((a, c) => a + c, 0);
        // createSink 是同步工厂，真正的句柄创建在 sink.ready；必须等它完成再宣告开始传输，
        // 失败（如目录写权限未授予）要显式报错，不能让首帧撞上空句柄。
        sink = createSink(opts.dirHandle ?? null, files);
        try {
          await sink.ready;
        } catch (e: any) {
          const msg = e?.name === 'SecurityError'
            ? '目录写入权限未授予，请重新点击「连接接收」并在弹窗中选择目录并允许保存'
            : '创建落盘文件失败: ' + (e?.message || String(e));
          setState('error', msg);
          // 传友好消息而非原始 DOMException，避免 UI 显示晦涩英文
          opts.onFail?.(new Error(msg));
          sink = null;
          return;
        }
        setState('transferring');
      }
      else if (msg.type === 'done') {
        senderDone = true;
        checkComplete(); // 已收齐 → 立即完成；未收齐 → 维持接收态等续传补齐
      }
      return;
    }
    const frame = reasm.feed(new Uint8Array(data as ArrayBuffer));
    if (frame) {
      queue.push(frame);
      void drainQueue();
    }
  }

  async function connect(): Promise<void> {
    cryptoCtx = await deriveP2PKey(opts.pass);
    setState('signaling');
    sig = new SignalingClient({
      relayBase: opts.relayBase,
      room: opts.room,
      role: 'receiver',
      onSignal: (d) => peer?.onSignal(d),
      onReconnecting: () => setState('signaling', '信令重连中'),
      onPeerConnected: (role) => { if (role === 'sender') opts.onPeerPresent?.('sender'); },
    });
    const ice = await fetchIceServers(opts.relayBase, opts.relayBase.startsWith('https') ? 'wss' : 'ws');
    peer = new PeerLink({
      role: 'receiver',
      sendSignal: (d) => sig?.send(d),
      onDcOpen,
      onDcMessage,
      onState: (c) => {
        if (c) setState('connecting');
      },
      onPeerJoined: () => opts.onPeerJoined?.(),
    });
    sig.connect();
    peer.connect(ice);
  }

  function abort() {
    aborted = true;
    sink?.abort();
    peer?.destroy();
    sig?.close();
    setState('aborted');
  }

  return { connect, abort };
}
