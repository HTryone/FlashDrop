// 帧编解码：12B 逻辑帧头 + DC 子帧（[u32 totalLen][u32 offset][piece]）。
import { FRAME_HDR, SUB_HDR } from './types';

// 逻辑帧头：u16 fi | u32 ci | u32 plainLen（与 HTTP 本地直传完全一致）
export function buildFrameHdr(fi: number, ci: number, plainLen: number): Uint8Array {
  const h = new Uint8Array(FRAME_HDR);
  const dv = new DataView(h.buffer);
  dv.setUint16(0, fi);
  dv.setUint32(2, ci);
  dv.setUint32(6, plainLen);
  return h;
}

export function readFrameHdr(buf: Uint8Array): { fi: number; ci: number; plainLen: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { fi: dv.getUint16(0), ci: dv.getUint32(2), plainLen: dv.getUint32(6) };
}

// 把一段逻辑帧切成 DC 子帧：[u32 totalLen][u32 offset][piece]
export function* subFrameIter(frame: Uint8Array, maxPiece: number): IterableIterator<Uint8Array> {
  const piece = maxPiece - SUB_HDR;
  if (piece <= 0) return;
  for (let off = 0; off < frame.length; off += piece) {
    const end = Math.min(off + piece, frame.length);
    const seg = frame.subarray(off, end);
    const out = new Uint8Array(SUB_HDR + seg.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, frame.length);
    dv.setUint32(4, off);
    out.set(seg, SUB_HDR);
    yield out;
  }
}
