// 本地直传加解密的异步封装：主线程把明文/密文块通过 transferable 交给后台 Worker 处理，
// 自己只等 Promise 返回，主线程零阻塞（UI 不卡、发送/接收不被解密拖死）。
import LocalCryptoWorker from '@/workers/localCrypto.worker?worker';

type Pending = { resolve: (b: ArrayBuffer) => void; reject: (e: any) => void };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (!worker) {
    worker = new LocalCryptoWorker();
    worker.onmessage = (e: MessageEvent) => {
      const { id, ok, out, error } = e.data as any;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(out as ArrayBuffer);
      else p.reject(new Error(error || 'crypto worker error'));
    };
    worker.onerror = (e) => console.error('[localCrypto] worker 异常:', e);
  }
  return worker;
}

/** 加密单个明文块，返回密文 ArrayBuffer（transferable） */
export function encryptChunkAsync(buf: ArrayBuffer, keyHex: string): Promise<ArrayBuffer> {
  const w = getWorker();
  const id = ++seq;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type: 'enc', buf, keyHex }, [buf]);
  });
}

/** 解密单个密文块，返回明文 ArrayBuffer（transferable） */
export function decryptChunkAsync(buf: ArrayBuffer, keyHex: string, plainLen?: number): Promise<ArrayBuffer> {
  const w = getWorker();
  const id = ++seq;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type: 'dec', buf, keyHex, plainLen }, [buf]);
  });
}
