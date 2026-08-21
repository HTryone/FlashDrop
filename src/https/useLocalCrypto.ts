// 本地直传加解密的异步封装：主线程把明文/密文块通过 transferable 交给后台 Worker 池处理，
// 自己只等 Promise 返回，主线程零阻塞（UI 不卡、发送/接收不被解密拖死）。
// 使用 Worker 池（多个并发 Worker）并行解密，根治「接收端单 Worker 串行解密」的性能瓶颈。
import LocalCryptoWorker from '@/workers/localCrypto.worker?worker';
import { error } from '@/diagnostics/logger';

type Pending = { resolve: (b: ArrayBuffer) => void; reject: (e: any) => void };

let workers: Worker[] = [];
let poolSeq = 0;                          // 跨 Worker 全局唯一序号
const pending = new Map<number, Pending>();
const workerBusy = new Map<Worker, number>(); // 各 Worker 当前在途任务数（用于挑最空闲的）

function getPoolSize(): number {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(2, Math.min(4, hc));    // 2~4 个，兼顾吞吐与内存/调度开销
}

function ensureWorkers(): Worker[] {
  if (workers.length) return workers;
  const n = getPoolSize();
  for (let i = 0; i < n; i++) {
    const w = new LocalCryptoWorker();
    w.onmessage = (e: MessageEvent) => {
      const { id, ok, out, error } = e.data as any;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(out as ArrayBuffer);
      else p.reject(new Error(error || 'crypto worker error'));
    };
    w.onerror = (e) => {
      error('worker', 'localCrypto', 'Worker 异常', { error: String(e) });
      console.error('[localCrypto] worker 异常:', e);
    };
    workers.push(w);
    workerBusy.set(w, 0);
  }
  return workers;
}

// 挑当前在途任务最少的 Worker，均衡负载
function pickWorker(): Worker {
  const pool = ensureWorkers();
  let best = pool[0];
  let min = Infinity;
  for (const w of pool) {
    const b = workerBusy.get(w) || 0;
    if (b < min) { min = b; best = w; }
  }
  return best;
}

function dispatch(type: 'enc' | 'dec', buf: ArrayBuffer, keyHex: string, plainLen?: number): Promise<ArrayBuffer> {
  const w = pickWorker();
  const id = ++poolSeq;
  workerBusy.set(w, (workerBusy.get(w) || 0) + 1);
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, buf, keyHex, plainLen }, [buf]);
  }).finally(() => {
    workerBusy.set(w, Math.max(0, (workerBusy.get(w) || 0) - 1));
  });
}

/** 加密单个明文块，返回密文 ArrayBuffer（transferable） */
export function encryptChunkAsync(buf: ArrayBuffer, keyHex: string): Promise<ArrayBuffer> {
  return dispatch('enc', buf, keyHex);
}

/** 解密单个密文块，返回明文 ArrayBuffer（transferable） */
export function decryptChunkAsync(buf: ArrayBuffer, keyHex: string, plainLen?: number): Promise<ArrayBuffer> {
  return dispatch('dec', buf, keyHex, plainLen);
}
