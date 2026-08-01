// DataChannel 层：子帧重组（接收端）、在途窗口（发送端 ack 流控）、分片发送 + DC 缓冲背压。
import { SUB_HDR, RTC_LOW, WINDOW_FRAMES } from './types';
import { subFrameIter } from './framing';

// 接收端：把二进制子帧重组成完整逻辑帧（DC 本身有序，这里兜底稳健）。
export class Reassembler {
  private total = 0;
  private received = 0;
  private buf: Uint8Array | null = null;

  feed(chunk: Uint8Array): Uint8Array | null {
    const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const total = dv.getUint32(0);
    const off = dv.getUint32(4);
    const piece = chunk.subarray(SUB_HDR);
    if (off === 0 || !this.buf || this.buf.length !== total) {
      // 新的一帧（或首片）：重置累积缓冲
      this.total = total;
      this.received = 0;
      this.buf = new Uint8Array(total);
    }
    this.buf.set(piece, off);
    this.received += piece.length;
    if (this.received >= this.total) {
      const done = this.buf;
      this.buf = null;
      this.total = 0;
      this.received = 0;
      return done;
    }
    return null;
  }
}

// 发送端在途窗口：基于接收端 ack 推进，超限则阻塞（防发送端内存爆 + 防接收端磁盘写不及）。
export class FlowWindow {
  lastAcked = -1; // 已连续确认的最高全局序号
  private waiters: Array<() => void> = [];
  // 累计超时判死：连续 N 次 waitForAck 超时未收到真实 ack → 判定连接已断
  private consecutiveTimeouts = 0;
  static readonly MAX_CONSECUTIVE_TIMEOUTS = 10;

  noteAck(seq: number) {
    this.consecutiveTimeouts = 0; // 收到真实 ack，重置超时计数
    if (seq > this.lastAcked) this.lastAcked = seq;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      try { w(); } catch { /* ignore */ }
    }
  }

  async waitIfNeeded(inflight: number, limit = WINDOW_FRAMES): Promise<void> {
    if (inflight < limit) return;
    await this.waitForAck();
  }

  // 等待下一个 ack（或 500ms 兜底），用于「全部已发待确认 / dc 未就绪」时避免空转。
  // 连续超时达 MAX_CONSECUTIVE_TIMEOUTS 次后 reject，防止慢链路/对称 NAT 下假活不报错。
  waitForAck(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let fired = false;
      const once = () => {
        if (fired) return;
        fired = true;
        resolve();
      };
      this.waiters.push(once);
      // 兜底：ack 丢失也不永久挂起，超时后重评估
      setTimeout(() => {
        if (fired) return;
        fired = true;
        this.consecutiveTimeouts++;
        if (this.consecutiveTimeouts >= FlowWindow.MAX_CONSECUTIVE_TIMEOUTS) {
          reject(new Error(
            'P2P 连接疑似断开：连续 ' + FlowWindow.MAX_CONSECUTIVE_TIMEOUTS +
            ' 次 ack 超时无响应（500ms/次）',
          ));
          return;
        }
        resolve(); // 偶尔丢 ack 正常，继续等
      }, 500);
    });
  }
}

function dcMaxPiece(dc: RTCDataChannel): number {
  const m = (dc as unknown as { maxMessageSize?: number }).maxMessageSize;
  const max = typeof m === 'number' && m > 1024 ? m : 256 * 1024;
  return Math.min(max, 256 * 1024);
}

function drainDc(dc: RTCDataChannel): Promise<void> {
  if (dc.readyState !== 'open' || (dc as unknown as { bufferedAmount: number }).bufferedAmount <= RTC_LOW) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const onLow = () => cleanup();
    const onClose = () => cleanup();
    const timer = setTimeout(() => cleanup(), 30000);
    const ch = dc as unknown as {
      bufferedAmountLowThreshold: number;
      removeEventListener: (t: string, cb: any, o?: any) => void;
      addEventListener: (t: string, cb: any, o?: any) => void;
    };
    function cleanup() {
      clearTimeout(timer);
      ch.removeEventListener('bufferedamountlow', onLow);
      ch.removeEventListener('close', onClose);
      resolve();
    }
    ch.bufferedAmountLowThreshold = RTC_LOW;
    ch.addEventListener('bufferedamountlow', onLow, { once: true });
    ch.addEventListener('close', onClose, { once: true });
  });
}

// 经 DataChannel 发一段逻辑帧（自动子帧化）；返回 false = 通道不可用。
export async function sendSubFrames(dc: RTCDataChannel, frame: Uint8Array): Promise<boolean> {
  if (dc.readyState !== 'open') return false;
  const maxPiece = dcMaxPiece(dc);
  try {
    for (const sub of subFrameIter(frame, maxPiece)) {
      const ba = (dc as unknown as { bufferedAmount: number }).bufferedAmount;
      if (ba > RTC_LOW) {
        await drainDc(dc);
        if (dc.readyState !== 'open') return false;
      }
      dc.send(sub.buffer as ArrayBuffer);
    }
    return true;
  } catch (e) {
    console.warn('[p2p] 子帧发送失败:', e);
    return false;
  }
}
