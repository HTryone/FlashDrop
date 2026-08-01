// 接收端编排：connect → 收 manifest → 收 DC 子帧重组 → 解密 → 顺序写盘 → 回 ack → 完成。
// 顺序写盘用单消费者队列保证（DC 虽有序，但解密 await 并发可能乱序，故串行处理）。
import { PeerLink } from './peer';
import { SignalingClient } from './signaling';
import { fetchIceServers } from './ice';
import { readFrameHdr } from './framing';
import { Reassembler } from './channel';
import { createSink, Sink } from './sinks';
import { FRAME_HDR, P2P_CHUNK_SIZE } from './types';
import { deriveKey, LOCAL_SALT } from '@/crypto/e2ee';
import { decryptChunkAsync } from '@/composables/useLocalCrypto';
import type { ReceiverOpts, P2PState, P2PFileMeta } from './types';

export interface P2PReceiver {
  connect(): Promise<void>;
  abort(): void;
}

export function createP2PReceiver(opts: ReceiverOpts): P2PReceiver {
  let peer: PeerLink | null = null;
  let sig: SignalingClient | null = null;
  let keyHex = '';
  let sink: Sink | null = null;
  let files: P2PFileMeta[] = [];
  let totalBytes = 0;
  let perFileChunks: number[] = [];
  let totalChunks = 0;
  let recvBytes = 0;
  let lastAcked = -1;
  let finished = false;
  let aborted = false;
  let dc: RTCDataChannel | null = null;
  const reasm = new Reassembler();

  const ACK_EVERY = 8;
  let sinceAck = 0;

  const queue: Uint8Array[] = [];
  let draining = false;

  const setState = (s: P2PState, d?: string) => opts.onState?.(s, d);

  const seqOf = (fi: number, ci: number) => {
    let s = 0;
    for (let i = 0; i < fi; i++) s += perFileChunks[i] || 0;
    return s + ci;
  };

  function sendAck() {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'ack', seq: lastAcked }));
  }

  // ── 流水线并行：解密与写盘重叠 ──
  // 旧模式（串行）：decrypt(N) await → write(N) await → decrypt(N+1) → ...
  // 新模式（流水线）：start decrypt(N) → write(N-1) [I/O||CPU] → await decrypt(N) → swap
  // 对 4MB 块，crypto-js 解密耗时数 ms ~ 十 ms，与 FSA write IPC 重叠后隐藏全部 CPU 等待。
  type PipeEntry = {
    fi: number; ci: number; plainLen: number;
    seq: number;
    decryptP: Promise<ArrayBuffer> | null;  // 正在解密的 promise
    plain: Uint8Array | null;               // 已解密完待写盘的数据
  };
  let decrypting: PipeEntry | null = null;  // 当前正在解密（CPU）的槽位
  let writing: PipeEntry | null = null;     // 当前正在写盘（I/O）的槽位

  async function drainQueue() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length || decrypting || writing) {
        if (aborted) break;

        // 1) 写槽空、解密槽已就绪 → 移交写槽（写盘严格串行，避免乱序/覆盖丢块）
        if (!writing && decrypting && decrypting.plain !== null) {
          writing = decrypting;
          decrypting = null;
        }

        // 2) 解密槽空、队列有帧 → 启动新解密（与写盘重叠，隐藏 4MB 块 CPU 等待）
        if (!decrypting && queue.length) {
          const f = queue.shift()!;
          const { fi, ci, plainLen } = readFrameHdr(f);
          const body = f.subarray(FRAME_HDR);
          const bodyBuf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
          const seq = seqOf(fi, ci);
          decrypting = {
            fi, ci, plainLen, seq,
            decryptP: decryptChunkAsync(bodyBuf, keyHex, plainLen).catch((e: any) => {
              setState('error', '解密失败: ' + (e?.message || String(e)));
              opts.onFail?.(e instanceof Error ? e : new Error(String(e)));
              return new ArrayBuffer(0); // 错误占位，后续检查长度跳过
            }),
            plain: null,
          };
          continue; // 立刻取下一帧（让多个 decrypt 并行飞起来）
        }

        // 3) 写槽有数据 → 写盘（同时下一帧的解密在 Worker 里并行飞）
        if (writing) {
          const { fi, ci: ciVal, plain, seq } = writing;
          if (plain && plain.byteLength > 0 && sink) {
            const position = ciVal * P2P_CHUNK_SIZE;
            await sink.writeChunk(fi, plain, position);
            recvBytes += plain.byteLength;
            if (seq > lastAcked) lastAcked = seq;
            opts.onProgress?.({ sent: 0, received: recvBytes, total: totalBytes });
            sinceAck++;
            if (sinceAck >= ACK_EVERY || seq >= totalChunks - 1) {
              sinceAck = 0;
              sendAck();
            }
            if (seq >= totalChunks - 1 && !finished) {
              finished = true;
              await sink.close();
              if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'done' }));
              setState('done');
            }
          }
          writing = null;
          continue;
        }

        // 4) 解密槽在飞 → 等其完成
        if (decrypting && decrypting.decryptP !== null) {
          const buf = await decrypting.decryptP;
          decrypting.plain = new Uint8Array(buf);
          decrypting.decryptP = null; // 释放 promise 引用
          continue;
        }

        // 无数据可处理 → 等（正常不会走到这里）
        await new Promise(r => setTimeout(r, 1));
      }
    } finally {
      draining = false;
    }
  }

  function onDcOpen(d: RTCDataChannel) {
    dc = d;
    setState('connected');
    // manifest 已在 dc open 后由发送端首条字符串消息送达；reconnect 后会再次送达（幂等）
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
      return;
    }
    const frame = reasm.feed(new Uint8Array(data as ArrayBuffer));
    if (frame) {
      queue.push(frame);
      void drainQueue();
    }
  }

  async function connect(): Promise<void> {
    keyHex = await deriveKey(opts.pass, LOCAL_SALT);
    setState('signaling');
    sig = new SignalingClient({
      relayBase: opts.relayBase,
      room: opts.room,
      role: 'receiver',
      onSignal: (d) => peer?.onSignal(d),
      onReconnecting: () => setState('signaling', '信令重连中'),
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
