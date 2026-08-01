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

  // ── 批量写入缓冲区 ──
  // 根因：同机 P2P 每 896KB 一次 w.write() IPC 调用 → NVMe 仅 20MB/s、梯形震荡。
  // 解法：同文件内顺序 chunk 合并到阈值后一次性 append 写入，减少 IPC 次数。
  // P2P 路径已升级到 4MB/块（P2P_CHUNK_SIZE），阈值设为 8MB ≈ 每 2 块一次 IPC。
  const FLUSH_BYTES = 8 * 1024 * 1024; // 8MB 刷盘阈值
  const bufChunks: Uint8Array[][] = files.map(() => []); // 各文件缓冲区
  let bufTotal = 0;                     // 全局缓冲字节数

  /** 将文件 fi 的缓冲区一次性追加写入磁盘 */
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
    bufTotal -= totalLen;
    await w.write(combined as any); // FileSystemWriteParams.data
  }

  /** 如果全局缓冲超过阈值，逐文件刷盘 */
  async function flushIfNeeded(): Promise<void> {
    if (bufTotal < FLUSH_BYTES) return;
    for (let i = 0; i < files.length; i++) {
      if (bufChunks[i].length > 0) await flushFile(i);
    }
  }

  return {
    ready,
    async writeChunk(fi, data, _position) {
      await awaitReady();
      // 缓存到对应文件的写缓冲区（不立即刷盘）
      bufChunks[fi].push(data);
      bufTotal += data.byteLength;
      // 达到阈值时批量刷盘（减少 IPC 调用频率）
      await flushIfNeeded();
    },
    async close() {
      try {
        await awaitReady();
      } catch {
        return; // 句柄根本没建起来，无可关闭
      }
      // 关闭前把剩余缓冲全部刷盘
      for (let i = 0; i < files.length; i++) {
        if (bufChunks[i].length > 0) await flushFile(i);
      }
      for (const w of writers) {
        if (w) {
          try {
            await w.close();
          } catch { /* ignore */ }
        }
      }
    },
    abort() {
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
