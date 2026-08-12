// DataChannel 层：子帧重组（接收端）、在途窗口（发送端 ack 流控）、分片发送 + DC 缓冲背压。
import { SUB_HDR, RTC_LOW } from './types';
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

function dcMaxPiece(dc: RTCDataChannel): number {
  const m = (dc as unknown as { maxMessageSize?: number }).maxMessageSize;
  const max = typeof m === 'number' && m > 1024 ? m : 256 * 1024;
  return Math.min(max, 256 * 1024);
}

// 主动轮询 DC 缓冲水位，替代 bufferedamountlow 事件 + 30s 兜底。
// 旧实现依赖事件，某些浏览器/边缘情况下事件不触发会空等整 30s 假死；
// 现改为 30ms 轮询 + 2s 硬上限，水位回落即放行，绝不空等。
function drainDc(dc: RTCDataChannel): Promise<void> {
  const ch = dc as unknown as { bufferedAmount: number };
  if (dc.readyState !== 'open' || ch.bufferedAmount <= RTC_LOW) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (dc.readyState !== 'open') { resolve(); return; }
      if (ch.bufferedAmount <= RTC_LOW) { resolve(); return; }
      if (Date.now() - start > 2000) { resolve(); return; } // 兜底 2s，绝不空等 30s
      setTimeout(tick, 30); // 30ms 主动轮询
    };
    tick();
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
