// 本地直传加解密 Worker：把 crypto-js 的同步 AES-CBC+HMAC 计算从主线程挪到后台线程，
// 避免大文件传输时主线程被占住导致界面卡顿、发送端背压卡死。
// 复用 @/crypto/e2ee 的 encryptChunk / decryptChunk，不改变线上传输格式与算法，零兼容风险。

import { encryptChunk, decryptChunk } from '@/crypto/e2ee';

interface ReqMsg {
  id: number;
  type: 'enc' | 'dec';
  buf: ArrayBuffer;
  keyHex: string;
  plainLen?: number;
}

self.onmessage = (e: MessageEvent<ReqMsg>) => {
  const { id, type, buf, keyHex, plainLen } = e.data;
  try {
    let out: Uint8Array;
    if (type === 'enc') {
      out = encryptChunk(new Uint8Array(buf), keyHex);
    } else if (type === 'dec') {
      out = decryptChunk(new Uint8Array(buf), keyHex, plainLen);
    } else {
      (self as any).postMessage({ id, ok: false, error: 'unknown type: ' + type });
      return;
    }
    // 精确长度切片再 transfer，避免把底层 buffer 多余字节传回主线程
    const exact = out.slice();
    (self as any).postMessage({ id, ok: true, out: exact.buffer }, [exact.buffer]);
  } catch (err: any) {
    (self as any).postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
