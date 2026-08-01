// 帧协议编解码 + 流式读取。
// 帧格式：[4B u32 长度前缀][payload]，payload 可能是 JSON 控制帧，也可能是加密数据帧。
// 数据帧 payload：[12B 头][密文]，头布局：fi u16 / ci u32 / plainLen u32。
// HTTP 与 P2P 共用同一套帧格式（接记忆：e2ee.ts 与 HTTP 共享，禁另起 P2P 专用加密）。

export const FRAME_HDR = 12;

/** 长度前缀编码：[4B u32 长度][payload] */
export function encodeMsg(payload: Uint8Array): Uint8Array {
  const hdr = new Uint8Array(4);
  new DataView(hdr.buffer).setUint32(0, payload.length, false);
  const out = new Uint8Array(hdr.length + payload.length);
  out.set(hdr, 0);
  out.set(payload, hdr.length);
  return out;
}

/** 解析一条加密数据帧头 */
export interface DataFrame {
  fi: number;
  ci: number;
  plainLen: number;
  body: Uint8Array; // 密文体（含 IV/HMAC，由 e2ee 解密）
}

export function decodeFrame(frame: Uint8Array): DataFrame {
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const fi = dv.getUint16(0);
  const ci = dv.getUint32(2);
  const plainLen = dv.getUint32(6);
  const body = frame.subarray(FRAME_HDR);
  return { fi, ci, plainLen, body };
}

/**
 * 流式分帧读取器：持有跨「重连/重试」的剩余缓冲，按长度前缀切出完整消息。
 * 每次 fetch 得到新的 reader 用 setReader 注入，缓冲在段内跨 GET 重试保留（避免半截消息丢失）。
 */
export class FrameReader {
  private buf = new Uint8Array(0);
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  setReader(r: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = r;
  }

  reset() {
    this.buf = new Uint8Array(0);
    this.reader = null;
  }

  /** 从 reader 累积读取恰好 n 字节，返回切出的 Uint8Array，不足返回 null（EOF） */
  private async readExact(n: number): Promise<Uint8Array | null> {
    const reader = this.reader!;
    while (this.buf.length < n) {
      const { done, value } = await reader.read();
      if (done) return null;
      const tmp = new Uint8Array(this.buf.length + value.length);
      tmp.set(this.buf, 0);
      tmp.set(value, this.buf.length);
      this.buf = tmp;
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  /** 读一条长度前缀消息 [4B u32 长度][payload]；EOF 或零长度返回 null */
  async readMsg(): Promise<Uint8Array | null> {
    const hdr = await this.readExact(4);
    if (!hdr) return null;
    const len = new DataView(hdr.buffer, hdr.byteOffset, 4).getUint32(0, false);
    if (len === 0) return null;
    return await this.readExact(len);
  }
}
