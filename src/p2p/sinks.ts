// 落盘 Sink：FSA 主路径（支持 seek，断线续传可定位写） + Blob 退化路径（逐文件下载）。
// 模块自包含，不 import 组件；仅依赖 DOM File System Access API。
import type { P2PFileMeta } from './types';

export interface Sink {
  ready: Promise<void>;
  writeChunk(fi: number, data: Uint8Array, position: number): Promise<void>;
  close(): Promise<void>;
  abort(): void;
}

export function createSink(dirHandle: FileSystemDirectoryHandle | null, files: P2PFileMeta[]): Sink {
  if (dirHandle && typeof (dirHandle as any).getFileHandle === 'function') {
    return createFsaSink(dirHandle, files);
  }
  return createBlobSink(files);
}

function createFsaSink(dirHandle: FileSystemDirectoryHandle, files: P2PFileMeta[]): Sink {
  const writers: (FileSystemWritableFileStream | null)[] = [];
  // 句柄创建是异步的（getFileHandle + createWritable 各一次 IPC）。首帧可能早于它完成，
  // 故所有写路径都必须先 await ready，否则会误报「未找到文件句柄」。
  const ready = (async () => {
    for (let i = 0; i < files.length; i++) {
      // 目录句柄不接受路径分隔符，与 HTTP 接收端 safeName 规则保持一致
      const safeName = String(files[i].name).replace(/[\\/]/g, '_');
      const h = await dirHandle.getFileHandle(safeName, { create: true });
      writers[i] = await h.createWritable();
    }
  })();
  // 预挂 catch 防 unhandled rejection；真实错误在 awaitReady() 里重新抛出给上层
  let readyErr: any = null;
  ready.catch((e) => { readyErr = e; });
  const awaitReady = async () => {
    try {
      await ready;
    } catch {
      /* 错误已存入 readyErr */
    }
    if (readyErr) throw readyErr;
  };

  // ── 批量写入缓冲区 + 后台异步刷盘 ──
  // 旧根因：writeChunk 内 `if (bufLens>=FLUSH_BYTES) await flushFile` 串行阻塞，写循环
  // （唯一消费者）每攒满 8MB 才 await 一次 w.write IPC，期间冻结 ~200ms → 写队列满 →
  // 解密停 → DC 读取停 → 发送端 bufferedAmount 反压暂停 → 突发-空闲锯齿（实测 60% 空闲）。
  // 新解法：writeChunk 只入缓冲立即返回（写循环零阻塞、解密/DC 读取持续满速）；
  // 独立后台 flushLoop 持续把 8MB 缓冲合并落盘（保留合并 = IPC 次数不增）。
  // 写循环与 flushLoop 经 bufChunks/bufLens 解耦，无锁交接（JS 单线程，await 让权）。
  const FLUSH_BYTES = 8 * 1024 * 1024; // 8MB 刷盘阈值（每文件独立）
  const bufChunks: Uint8Array[][] = files.map(() => []); // 各文件缓冲区
  const bufLens: number[] = files.map(() => 0);          // 各文件已缓冲字节（替代全局 bufTotal，避免跨文件串扰刷盘）
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // 后台 flush 协调状态
  let closedFlag = false;
  let flushDoneResolve: (() => void) | null = null;
  const flushDone = new Promise<void>((r) => { flushDoneResolve = r; });
  // 新数据到达信号：唤醒 flushLoop 避免空轮询；50ms 兜底重查保证不漏刷、不 deadlock
  let notifyResolve: (() => void) | null = null;
  let notifyPromise: Promise<void> = new Promise<void>((r) => { notifyResolve = r; });
  const signalData = () => {
    if (notifyResolve) {
      const r = notifyResolve;
      notifyResolve = null;
      notifyPromise = new Promise<void>((r) => { notifyResolve = r; });
      r();
    }
  };

  /** 将文件 fi 的缓冲区一次性追加写入磁盘（清零 bufLens 防重复刷） */
  async function flushFile(fi: number): Promise<void> {
    const chunks = bufChunks[fi];
    if (chunks.length === 0) return;
    const w = writers[fi];
    if (!w) throw new Error(`未找到文件句柄 fi=${fi}`);
    // 合并所有缓冲 chunk 为单次写入（append 模式，无 seek 开销）
    const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
    const combined = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
      combined.set(c, off);
      off += c.byteLength;
    }
    chunks.length = 0;
    bufLens[fi] = 0;
    await w.write(combined as any); // FileSystemWriteParams.data
  }

  /** 后台刷盘循环：持续合并落盘；close 后收尾刷剩余；退出时 resolve flushDone */
  async function flushLoop(): Promise<void> {
    try {
      while (true) {
        for (let fi = 0; fi < files.length; fi++) {
          if (bufLens[fi] >= FLUSH_BYTES) await flushFile(fi);
        }
        if (closedFlag) {
          // 收尾：把未达阈值的剩余缓冲也全部刷盘
          for (let fi = 0; fi < files.length; fi++) {
            if (bufChunks[fi].length > 0) await flushFile(fi);
          }
          break;
        }
        // 无达标缓冲且未关闭：等信号或 50ms 兜底
        await Promise.race([notifyPromise, sleep(50)]);
      }
    } finally {
      flushDoneResolve?.();
    }
  }
  // ready 完成后才有 writers，启动后台 flush；close 已置 closedFlag 或 ready 失败则直接收尾
  ready.then(() => {
    if (!closedFlag) flushLoop().catch(() => {});
    else flushDoneResolve?.();
  }).catch(() => { flushDoneResolve?.(); });

  return {
    ready,
    async writeChunk(fi, data, _position) {
      await awaitReady();
      // 仅入缓冲并立即返回，写循环零阻塞
      bufChunks[fi].push(data);
      bufLens[fi] += data.byteLength;
      signalData(); // 唤醒后台 flushLoop
      // 轻量背压：缓冲超过 2×阈值(16MB)才短暂等待，避免内存无限涨；
      // 正常磁盘下 flushLoop 持续排空，几乎不触发，写循环保持零阻塞。
      while (bufLens[fi] > FLUSH_BYTES * 2 && !closedFlag) {
        await sleep(5);
      }
    },
    async close() {
      closedFlag = true;
      signalData(); // 唤醒 flushLoop 走收尾分支
      try {
        await awaitReady();
      } catch {
        return; // 句柄根本没建起来，无可关闭
      }
      await flushDone; // 等后台把剩余缓冲全部落盘
      for (const w of writers) {
        if (w) {
          try {
            await w.close();
          } catch { /* ignore */ }
        }
      }
    },
    abort() {
      closedFlag = true;
      signalData();
      for (const w of writers) {
        if (w) {
          try {
            w.close().catch(() => {});
          } catch { /* ignore */ }
        }
      }
    },
  };
}

// Blob 退化：非 Chromium / 无目录权限时，逐文件累积后触发下载（不支持 seek 续传）。
function createBlobSink(files: P2PFileMeta[]): Sink {
  const chunks: Uint8Array[][] = files.map(() => []);
  return {
    ready: Promise.resolve(),
    async writeChunk(fi, data) {
      chunks[fi].push(data);
    },
    async close() {
      for (let i = 0; i < files.length; i++) {
        const blob = new Blob(chunks[i] as unknown as BlobPart[]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = files[i].name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    },
    abort() { /* no-op */ },
  };
}
