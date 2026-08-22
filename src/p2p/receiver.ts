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
  let finalized = false; // 收尾（close + done 帧）是否已执行，保证恰好一次
  let doneSent = false;  // 接收端 done 帧是否已发，避免重复
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

  // 传输完成后延迟释放连接，避免孤儿连接堆积（延迟确保 done 帧先发出）；peer.destroy/sig.close 均幂等，重复调用安全
  const scheduleCleanup = () => {
    setTimeout(() => { peer?.destroy(); sig?.close(); }, 150);
  };

  // 收尾判定：发送端已广播结束 且 本地已收齐全部字节 → 触发收尾。
  // 不再在此处直接标 done：双缓冲下必须等后台落盘 drain 才标完成（见 finalizeTransfer），
  // 否则 recvBytes 到顶≠磁盘写完，文件会被截断。
  const checkComplete = () => {
    if (senderDone && !finalized && recvBytes >= totalBytes) {
      void finalizeTransfer();
    }
  };

  // 收尾：等后台落盘 drain（sink.close 内部 await flushDone）→ 标完成 + 回 done 帧。
  // finalized 守卫保证恰好执行一次；可从 checkComplete / 写循环收尾两处触发。
  async function finalizeTransfer() {
    if (finalized || aborted) return;
    finalized = true;
    try {
      // 关键：双缓冲下 writeChunk 仅交付写入器，必须等 close 把后台缓冲全部落盘，否则文件截断
      if (sink) await sink.close();
    } catch {
      /* 落盘错误已在上层 toast，这里仅防止收尾异常阻断 done 态 */
    }
    if (!finished) finished = true;
    if (!doneSent && dc && dc.readyState === 'open') {
      doneSent = true;
      dc.send(JSON.stringify({ type: 'done' }));
    }
    setState('done');
    scheduleCleanup();
  }

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
          // 逐文件进度：底层单流顺序写盘，按 lastAcked 全局游标 + 每文件块数推导
          if (opts.onFileProgress) {
            const cursor = lastAcked + 1; // 已写入的全局 chunk 数
            const progs: number[] = [];
            let s = 0;
            for (let i = 0; i < perFileChunks.length; i++) {
              const n = perFileChunks[i] || 0;
              const written = Math.max(0, Math.min(cursor - s, n));
              progs.push(n === 0 ? 1 : written / n);
              s += n;
            }
            opts.onFileProgress(progs);
          }
          sinceAck++;
          if (sinceAck >= ACK_EVERY || job.seq >= totalChunks - 1) {
            sinceAck = 0;
            sendAck();
          }
        }
      }
      // ── 收尾：解密完成且全部字节已交付写入器 → 等落盘 drain 再标完成 ──
      if (!aborted && !finalized && decryptDone && recvBytes >= totalBytes) {
        await finalizeTransfer();
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
        opts.onFiles?.(files); // 回传文件清单（文件名/尺寸），供 UI 展示；重连幂等再次触发
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
      else if (msg.type === 'cancel') {
        remoteAbort('对方已取消发送');
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
    try {
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
        onDcClose: () => {
          // DC 被关闭（对方取消/断线）→ 立即中止，避免 infinite reconnect loop
          if (!aborted) remoteAbort('对端连接已断开');
        },
      });
      sig.connect();
      peer.connect(ice);
    } catch (e: any) {
      // 建连阶段失败（如取 ICE 失败）：释放本次新建的资源，避免信令 WS 残留自动重连形成僵尸连接。
      sig?.close();
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
    setTimeout(() => { sink?.abort(); peer?.destroy(); sig?.close(); }, 150);
    setState('aborted');
  }

  function remoteAbort(reason: string) {
    if (aborted) return;
    aborted = true;
    sink?.abort();
    peer?.destroy();
    sig?.close();
    setState('aborted', reason);
  }

  return { connect, abort };
}
