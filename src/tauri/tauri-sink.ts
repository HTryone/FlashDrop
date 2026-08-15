// Tauri 接入层（核心逻辑，类比前端 .ts）：Rust 后端接管落盘，绕过浏览器 FSA 不兼容。
// 对外暴露两个 Sink 实现（中转 TauriRelaySink / P2P TauriP2PSink）对接现有 Sink 抽象，
// 以及路径选择 + 默认下载目录持久化（App 内可改，存 WebView 本地）。
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';
import { downloadDir, join } from '@tauri-apps/api/path';
import type { Sink as RelaySink } from '../composables/filesink';
import type { Sink as P2PSink } from '../p2p/sinks';
import type { P2PFileMeta } from '../p2p/types';
export { isTauriEnv } from './env';

const DEFAULT_DIR_KEY = 'flashdrop.defaultSaveDir';
const FLUSH_BYTES = 4 * 1024 * 1024; // 4MB 批量 invoke，降 IPC 往返（修 D5）

// ── 默认下载目录 + App 内修改 ──
export async function getDefaultSaveDir(): Promise<string> {
  const saved = localStorage.getItem(DEFAULT_DIR_KEY);
  if (saved) return saved;
  try {
    return await downloadDir();
  } catch {
    return '';
  }
}
export function setDefaultSaveDir(dir: string): void {
  localStorage.setItem(DEFAULT_DIR_KEY, dir);
}
function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}

// 中转：系统保存对话框，返回完整文件路径或 null（用户取消）。
export async function tauriPickSavePath(name: string): Promise<string | null> {
  const dir = await getDefaultSaveDir();
  const defaultPath = dir ? await join(dir, name).catch(() => name) : name;
  const picked = await save({ title: '保存文件', defaultPath });
  if (picked) setDefaultSaveDir(parentDir(picked)); // 记住本次所在目录
  return picked ?? null;
}

// P2P：系统选择文件夹对话框，返回目录路径或 null（用户取消）。
export async function tauriPickSaveDir(): Promise<string | null> {
  const dir = await getDefaultSaveDir();
  const picked = (await open({
    directory: true,
    title: '选择保存文件夹',
    defaultPath: dir || undefined,
  })) as unknown as string | null;
  if (picked) setDefaultSaveDir(picked);
  return picked ?? null;
}

// ── 核心写入器：单文件句柄，内部 4MB 批量 invoke，避免每块一次往返 ──
export class TauriFileWriter {
  private handle: string | null = null;
  private openPromise: Promise<void> | null = null;
  private pending: Uint8Array[] = [];
  private bufLen = 0;

  constructor(private resolvedPath: string) {}

  ensureOpen(): Promise<void> {
    if (!this.openPromise) {
      this.openPromise = invoke<string>('open_file', { path: this.resolvedPath }).then(
        (h) => {
          this.handle = h;
        },
      );
    }
    return this.openPromise;
  }

  async write(data: Uint8Array): Promise<void> {
    await this.ensureOpen();
    this.pending.push(data);
    this.bufLen += data.byteLength;
    if (this.bufLen >= FLUSH_BYTES) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const combined = new Uint8Array(this.bufLen);
    let off = 0;
    for (const c of this.pending) {
      combined.set(c, off);
      off += c.byteLength;
    }
    this.pending = [];
    this.bufLen = 0;
    await invoke('write_chunk', { handle: this.handle, data: combined });
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.handle) {
      await invoke('close_file', { handle: this.handle });
      this.handle = null;
    }
  }

  async abort(): Promise<void> {
    await this.flush().catch(() => {});
    if (this.handle) {
      await invoke('abort_file', { handle: this.handle }).catch(() => {});
      this.handle = null;
    }
  }
}

// 中转 Sink：对接 filesink.ts 的 Sink 接口（write/close/abort）。
export class TauriRelaySink implements RelaySink {
  private writer: TauriFileWriter;
  constructor(path: string) {
    this.writer = new TauriFileWriter(path);
  }
  write(p: Uint8Array) {
    return this.writer.write(p);
  }
  async close() {
    await this.writer.close();
  }
  abort() {
    void this.writer.abort();
  }
}

// P2P Sink：对接 p2p/sinks.ts 的 Sink 接口（ready/writeChunk/close/abort）。
// 选目录 + 逐文件开句柄放进 ready；writeChunk 直接转发到对应文件写入器。
export class TauriP2PSink implements P2PSink {
  private writers: (TauriFileWriter | null)[] = [];
  private readyPromise: Promise<void>;
  private readyErr: any = null;

  constructor(private files: P2PFileMeta[]) {
    this.readyPromise = this.init();
    this.readyPromise.catch((e) => {
      this.readyErr = e;
    });
  }

  private async init() {
    const dir = await tauriPickSaveDir();
    if (!dir) throw new Error('用户取消了保存');
    this.writers = await Promise.all(
      this.files.map(async (f) => {
        const safe = String(f.name).replace(/[\\/]/g, '_');
        const finalPath = await invoke<string>('resolve_save_path', { dir, name: safe });
        const w = new TauriFileWriter(finalPath);
        await w.ensureOpen();
        return w;
      }),
    );
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  async writeChunk(fi: number, data: Uint8Array, _position: number) {
    await this.readyPromise;
    if (this.readyErr) throw this.readyErr;
    const w = this.writers[fi];
    if (!w) throw new Error(`未找到文件句柄 fi=${fi}`);
    await w.write(data);
  }

  async close() {
    try {
      await this.readyPromise;
    } catch {
      return; // 句柄根本没建起来，无可关闭
    }
    for (const w of this.writers) {
      if (w) await w.close();
    }
  }

  abort() {
    for (const w of this.writers) {
      if (w) void w.abort();
    }
  }
}
