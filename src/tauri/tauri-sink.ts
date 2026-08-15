// Tauri 接入层（核心逻辑，类比前端 .ts）：Rust 后端接管落盘，绕过浏览器 FSA 不兼容。
// 对外暴露两个 Sink 实现（中转 TauriRelaySink / P2P TauriP2PSink）对接现有 Sink 抽象，
// 以及路径选择 + 默认下载目录持久化（App 内可改，存 WebView 本地）。
//
// 安卓落盘策略（方案 A + 兜底）：
//   - 方案 A：开启「全部文件访问」权限后，Rust std::fs 直接写公共下载目录 /Download/FlashDrop/…
//   - 兜底：用户未授权时，逐文件用 SAF 选择器让用户手动指定保存位置（经 fs 插件写 SAF URI）。
// 核心 Rust 落盘逻辑（file_writer.rs 的 std::fs）一行未改，符合架构铁律。
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';
import { downloadDir, join } from '@tauri-apps/api/path';
import { open as fsOpen } from '@tauri-apps/plugin-fs';
import { platform } from '@tauri-apps/plugin-os';
import type { Sink as RelaySink } from '../composables/filesink';
import type { Sink as P2PSink } from '../p2p/sinks';
import type { P2PFileMeta } from '../p2p/types';
export { isTauriEnv } from './env';

// 落盘目标：要么走 Rust std::fs（有全部文件访问权限），要么走 SAF（用户手动选的文件 URI）。
export type SaveTarget = { kind: 'fs'; path: string } | { kind: 'saf'; uri: string };
export type AnyTauriWriter = TauriFileWriter | TauriSafWriter;

// 安卓判断（plugin-os 提供平台名）；非 Tauri 或桌面返回 false。
async function isAndroid(): Promise<boolean> {
  try {
    return (await platform()) === 'android';
  } catch {
    return false;
  }
}

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

// 安卓基目录：公共下载目录下的 FlashDrop 子文件夹（Rust create_dir_all 会自动建）。
async function androidBaseDir(): Promise<string> {
  const dl = await downloadDir();
  return join(dl, 'FlashDrop').catch(() => dl);
}
// 尝试用 Rust std::fs 在公共下载目录解析不重名路径；无「全部文件访问」权限会抛错，交给调用方走 SAF 兜底。
async function tryResolveFs(name: string): Promise<string> {
  const dir = await androidBaseDir();
  return invoke<string>('resolve_save_path', { dir, name });
}

// 中转：桌面弹系统保存对话框；安卓优先落系统下载目录（需 MANAGE 权限），失败走 SAF 每次选文件。
export async function tauriPickSavePath(name: string): Promise<SaveTarget | null> {
  if (await isAndroid()) {
    try {
      const path = await tryResolveFs(name);
      setDefaultSaveDir(await androidBaseDir());
      return { kind: 'fs', path };
    } catch {
      const uri = await save({
        title: '保存文件（未授权“全部文件访问”，请手动选择）',
        defaultPath: name,
      });
      return uri ? { kind: 'saf', uri } : null;
    }
  }
  const dir = await getDefaultSaveDir();
  const defaultPath = dir ? await join(dir, name).catch(() => name) : name;
  // 注：join 失败时用原名兜底（上一行已处理），此处无需再 catch
  const picked = await save({ title: '保存文件', defaultPath });
  if (picked) setDefaultSaveDir(parentDir(picked)); // 记住本次所在目录
  return picked ? { kind: 'fs', path: picked } : null;
}

// 本地直传多文件 / P2P：桌面弹选文件夹对话框；安卓优先返回系统下载目录（需 MANAGE 权限），
// 失败返回 null，由 tauriBuildWriters 退化为逐文件 SAF 兜底。
export async function tauriPickSaveDir(): Promise<string | null> {
  if (await isAndroid()) {
    try {
      const dir = await androidBaseDir();
      setDefaultSaveDir(dir);
      return dir;
    } catch {
      return null; // 交给 tauriBuildWriters 走 SAF 逐文件
    }
  }
  const dir = await getDefaultSaveDir();
  const picked = (await open({
    directory: true,
    title: '选择保存文件夹',
    defaultPath: dir || undefined,
  })) as unknown as string | null;
  if (picked) setDefaultSaveDir(picked);
  return picked ?? null;
}

// 统一构造多文件写入器：有目录权限走 Rust std::fs，否则逐文件 SAF 兜底。
// 供「本地直传多文件」（filesink.ts）与「P2P 多文件」（TauriP2PSink）共用，避免两处重复逻辑。
export async function tauriBuildWriters(files: { name: string }[]): Promise<AnyTauriWriter[]> {
  const dir = await tauriPickSaveDir();
  if (dir) {
    return Promise.all(
      files.map(async (f) => {
        const safe = String(f.name).replace(/[\\/]/g, '_');
        const finalPath = await invoke<string>('resolve_save_path', { dir, name: safe });
        const w = new TauriFileWriter(finalPath);
        await w.ensureOpen();
        return w;
      }),
    );
  }
  // 兜底：逐文件 SAF 选位置（可靠，但每文件一次提示）。任一取消则整体取消。
  const uris = await Promise.all(
    files.map((f) =>
      save({ title: '保存文件（未授权“全部文件访问”）', defaultPath: String(f.name).replace(/[\\/]/g, '_') }),
    ),
  );
  if (uris.some((u) => !u)) throw new Error('用户取消了保存');
  return uris.map((u) => new TauriSafWriter(u as string));
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
      this.openPromise = invoke<string>('open_file', { path: this.resolvedPath }).then((h) => {
        this.handle = h;
      });
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

// SAF 兜底写入器：流式分块写入 SAF 返回的文件 URI（经 fs 插件 open→write）。
// 关键点：传输分块到达即写入，仅用 4MB 批量缓冲降 IPC 往返，峰值内存恒定，大文件不会爆内存。
// 仅在「未取得全部文件访问权限（MANAGE_EXTERNAL_STORAGE）」时才走此路径——即 MANAGE 授权失败后的最后兜底。
export class TauriSafWriter {
  private handle: any = null; // FileHandle
  private openPromise: Promise<void> | null = null;
  private pending: Uint8Array[] = [];
  private bufLen = 0;

  constructor(private uri: string) {}

  private ensureOpen(): Promise<void> {
    if (!this.openPromise) {
      // SAF 返回的 content:// URI，fs 插件在安卓经 ContentResolver 取得可写文件描述符；
      // append:true 从文件尾写入，配合顺序 write 即为流式落盘（已核对 tauri-plugin-fs 2.5.1 安卓实现）。
      this.openPromise = fsOpen(this.uri, { write: true, append: true }).then((h) => {
        this.handle = h;
      });
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
    await this.handle.write(combined);
  }

  async close(): Promise<void> {
    await this.ensureOpen();
    await this.flush();
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }

  async abort(): Promise<void> {
    // 兜底路径下已落盘的文件无法简单回滚（用户手动选的位置），关闭句柄即可，丢弃未写入缓冲。
    if (this.handle) {
      await this.handle.close().catch(() => {});
      this.handle = null;
    }
    this.pending = [];
    this.bufLen = 0;
  }
}

// 中转 Sink：对接 filesink.ts 的 Sink 接口（write/close/abort）。
export class TauriRelaySink implements RelaySink {
  private writer: TauriFileWriter | TauriSafWriter;
  constructor(target: SaveTarget) {
    this.writer = target.kind === 'fs' ? new TauriFileWriter(target.path) : new TauriSafWriter(target.uri);
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
  private writers: (TauriFileWriter | TauriSafWriter | null)[] = [];
  private readyPromise: Promise<void>;
  private readyErr: any = null;

  constructor(private files: P2PFileMeta[]) {
    this.readyPromise = this.init();
    this.readyPromise.catch((e) => {
      this.readyErr = e;
    });
  }

  private async init() {
    this.writers = await tauriBuildWriters(this.files);
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
