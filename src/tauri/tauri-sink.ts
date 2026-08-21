// Tauri 接入层：Rust 后端接管落盘，绕过 FSA 不兼容。
// 安卓三级级联：L1 MediaStore → L2 std::fs 探针 → L3 持久 SAF → 绝对兜底逐文件 SAF。
// 桌面端直写 std::fs，用户可在 App 内修改默认下载目录。
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';
import { downloadDir, homeDir, join } from '@tauri-apps/api/path';
import { open as fsOpen } from '@tauri-apps/plugin-fs';
import { isPhone } from './client';
import type { Sink as RelaySink } from '../composables/filesink';
import type { Sink as P2PSink } from '../p2p/sinks';
import type { P2PFileMeta } from '../p2p/types';
import { beginDownload, finishDownload } from './notify';
export { isTauriEnv } from './env';

// 落盘目标：要么走 Rust std::fs（有全部文件访问权限），要么走 SAF（用户手动选的文件 URI）。
export type SaveTarget =
  | { kind: 'fs'; path: string }
  | { kind: 'mediastore'; uri: string }
  | { kind: 'saf'; uri: string };
export type AnyTauriWriter = TauriFileWriter | TauriSafWriter;

// 安卓判断：用壳同步注入的设备标识，零 IPC、零异步。
// 【不可退化】旧版用 @tauri-apps/plugin-os 的 platform()，但 Rust 端未注册 → invoke 抛错
// → 安卓被当桌面 → 弹保存框 + content:// URI 喂给 Rust std::fs 必失败，下载秒挂。
function isAndroid(): boolean {
  return isPhone();
}

const DEFAULT_DIR_KEY = 'arkpulse.defaultSaveDir';
// 批量 invoke 阈值：降 IPC 往返（修 D5）。手机端取更小值——安卓 IPC 只能传文本，2MB 最稳。
function flushBytes(): number {
  return isAndroid() ? 2 * 1024 * 1024 : 4 * 1024 * 1024;
}

// content:// 是 SAF 标识，不是文件路径，绝不能交给 Rust std::fs。
function isContentUri(p: string): boolean {
  return /^content:\/\//i.test(p) || /^file:\/\//i.test(p);
}

// 二进制转 base64（分块处理，避免 4MB 一次 apply 爆调用栈）。仅安卓使用：Tauri Raw 载荷在该平台不可用。
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32KB/次，兼顾栈安全与拼接次数
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}

// 【性能铁律·不可退化】桌面必须走 invoke Raw 二进制 args（零膨胀）；写成对象形态会膨胀 3~4 倍，手机端直接打死 WebView 主线程。
// 安卓不支持 Raw，退到 base64（膨胀 1.33x）。
async function flushChunk(handle: string, data: Uint8Array): Promise<void> {
  if (isAndroid()) {
    await invoke('write_chunk_b64', [handle, bytesToBase64(data)] as any);
    return;
  }
  await invoke('write_chunk', data, { headers: { 'x-fd-handle': handle } });
}

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
  if (isContentUri(p)) return ''; // SAF URI 无「父目录」概念，写进 localStorage 会污染后续默认路径
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}

// 安卓公共下载目录：/storage/emulated/0/Download/ArkPulse。
// 【不可退化】不要用 downloadDir()——它指向 app 私有沙盒，用户根本看不到文件，权限白授。
async function androidBaseDir(): Promise<string> {
  try {
    const home = await homeDir();
    return await join(home, 'Download', 'ArkPulse');
  } catch {
    const dl = await downloadDir();
    return join(dl, 'ArkPulse').catch(() => dl);
  }
}
// 探测真实可写：Rust 侧 create_dir_all + 写探针，无「全部文件访问」权限时抛错。
async function tryResolveFs(name: string): Promise<string> {
  const dir = await androidBaseDir();
  return invoke<string>('resolve_save_path', [dir, name] as any);
}

// 中转：桌面弹系统保存对话框；安卓优先落系统下载目录（需 MANAGE 权限），失败走 SAF 每次选文件。
export async function tauriPickSavePath(name: string): Promise<SaveTarget | null> {
  if (isAndroid()) {
    // L1 MediaStore：固定 Download/ArkPulse，零权限零弹框（现代设备一锤定音）。
    // ⚠️ Kotlin 插件返回 JSObject {uri: "content://..."}，不可用 invoke<string>：
    //   invoke<string> 期望纯字符串，收到 JSObject 后会当 path 喂给 open_file →
    //   'invalid type: map, expected a string' 报错，下载秒挂。
    //   正确写法：invoke<{uri: string}>().then(r => r.uri)。
    try {
      const res = await invoke<{ uri: string }>('plugin:arkpulse-android-fs|mediastore_insert', { name });
      const uri = res.uri;
      beginDownload();
      return { kind: 'mediastore', uri };
    } catch {
      // L2 std::fs 探针直写（宽松 ROM / 老设备兜底）。
      try {
        const path = await tryResolveFs(name);
        setDefaultSaveDir(await androidBaseDir());
        beginDownload();
        return { kind: 'fs', path };
      } catch {
        // L3 兜底：SAF 逐文件选择器（每文件一次）。
        const uri = await save({
          title: '保存文件（未授权“全部文件访问”，请手动选择）',
          defaultPath: name,
        });
        if (!uri) return null;
        beginDownload();
        return { kind: 'saf', uri };
      }
    }
  }
  // 桌面默认落「下载目录」，不再弹保存框（用户可在 App 内改默认位置）。
  // 拿不到下载目录 / 该目录不可写时，才退回系统保存框兜底。
  const dir = (await getDefaultSaveDir()) || (await downloadDir().catch(() => '' as string));
  if (dir) {
    try {
      const finalPath = await invoke<string>('resolve_save_path', [dir, name] as any);
      setDefaultSaveDir(dir);
      return { kind: 'fs', path: finalPath };
    } catch {
      // 落到下方对话框兜底
    }
  }
  const defaultPath = dir ? await join(dir, name).catch(() => name) : name;
  // 注：join 失败时用原名兜底（上一行已处理），此处无需再 catch
  const picked = await save({ title: '保存文件', defaultPath });
  if (!picked) return null;
  // 兜底防御：任何平台上对话框若返回 content:// / file:// URI，一律走 SAF 写入器。
  // std::fs 打不开 URI，误当路径会让下载在第一次写入就失败（且错误常被误判成网络问题）。
  if (isContentUri(picked)) return { kind: 'saf', uri: picked };
  setDefaultSaveDir(parentDir(picked)); // 记住本次所在目录
  return { kind: 'fs', path: picked };
}

// 本地直传多文件 / P2P：桌面弹选文件夹对话框；安卓优先返回系统下载目录（需 MANAGE 权限），
// 失败返回 null，由 tauriBuildWriters 退化为逐文件 SAF 兜底。
export async function tauriPickSaveDir(): Promise<string | null> {
  if (isAndroid()) {
    try {
      const dir = await androidBaseDir();
      // 探测真实可写（Rust 侧 create_dir_all + 写探针）：无「全部文件访问」权限时抛错走 SAF。
      await invoke<string>('resolve_save_path', [dir, '.probe'] as any);
      setDefaultSaveDir(dir);
      return dir;
    } catch {
      return null; // 交给 tauriBuildWriters 走 SAF 逐文件
    }
  }
  // 桌面默认落「下载目录」，不再弹选文件夹框（用户可在 App 内改默认位置）。
  // 拿不到下载目录 / 该目录不可写时，才退回系统选文件夹框兜底。
  const saved = await getDefaultSaveDir();
  const dir = saved || (await downloadDir().catch(() => '' as string));
  if (dir) {
    try {
      await invoke<string>('resolve_save_path', [dir, '.probe'] as any);
      setDefaultSaveDir(dir);
      return dir;
    } catch {
      // 落到下方对话框兜底
    }
  }
  const picked = (await open({
    directory: true,
    title: '选择保存文件夹',
    defaultPath: saved || undefined,
  })) as unknown as string | null;
  if (picked) setDefaultSaveDir(picked);
  return picked ?? null;
}

// 统一构造多文件写入器（级联：L1 MediaStore → L2 std::fs → L3 持久 SAF → 绝对兜底逐文件 SAF）。
// 安卓返回 { writers, targets }；targets 用于关闭时汇总保存位置文案。桌面沿用原 L2 目录直写。
// 供「本地直传多文件」（filesink.ts）与「P2P 多文件」（TauriP2PSink）共用。
export async function tauriBuildWriters(
  files: { name: string }[],
): Promise<{ writers: AnyTauriWriter[]; targets: SaveTarget[] }> {
  const sanitize = (n: string) => String(n).replace(/[\\/]/g, '_');

  // 桌面（含 web 经 FSA，但本函数仅 isTauriEnv 内调用）：原 L2 目录直写。
  if (!isAndroid()) {
    const dir = await tauriPickSaveDir();
    if (!dir) throw new Error('未选择保存目录');
    const targets = await Promise.all(
      files.map(async (f) => {
        const finalPath = await invoke<string>('resolve_save_path', [dir, sanitize(f.name)] as any);
        return { kind: 'fs', path: finalPath } as SaveTarget;
      }),
    );
    const writers = await Promise.all(
      targets.map(async (t) => {
        const w = new TauriFileWriter((t as { path: string }).path);
        await w.ensureOpen();
        return w;
      }),
    );
    return { writers, targets };
  }

  // L1 MediaStore：批量插入 Download/ArkPulse，零弹框。
  try {
    const targets = await Promise.all(
      files.map(async (f) => {
        const res = await invoke<{ uri: string }>('plugin:arkpulse-android-fs|mediastore_insert', { name: sanitize(f.name) });
        return { kind: 'mediastore', uri: res.uri } as SaveTarget;
      }),
    );
    const writers = targets.map((t) => new TauriSafWriter((t as { uri: string }).uri));
    beginDownload();
    return { writers, targets };
  } catch {
    // L2 std::fs 探针直写（宽松 ROM / 老设备）。
    try {
      const dir = await tauriPickSaveDir();
      if (dir) {
        const targets = await Promise.all(
          files.map(async (f) => {
            const finalPath = await invoke<string>('resolve_save_path', [dir, sanitize(f.name)] as any);
            return { kind: 'fs', path: finalPath } as SaveTarget;
          }),
        );
        const writers = await Promise.all(
          targets.map(async (t) => {
            const w = new TauriFileWriter((t as { path: string }).path);
            await w.ensureOpen();
            return w;
          }),
        );
        beginDownload();
        return { writers, targets };
      }
    } catch {
      /* 落 L3 */
    }
    // L3 持久化 SAF：首次选一次文件夹，之后零弹框。
    try {
      const treeUri = await tauriResolveSafDir();
      if (treeUri) {
        const targets = await Promise.all(
          files.map(async (f) => {
            // ⚠️ Kotlin 插件返回 JSObject {uri: "content://..."}，同 L1 坑，不可 invoke<string>。
            //   此处若用 invoke<string>，SAF 路径会触发相同 'invalid type: map' 错误。
            const res = await invoke<{ uri: string }>('plugin:arkpulse-android-fs|saf_create_child', { tree_uri: treeUri, name: sanitize(f.name) });
            return { kind: 'saf', uri: res.uri } as SaveTarget;
          }),
        );
        const writers = targets.map((t) => new TauriSafWriter((t as { uri: string }).uri));
        beginDownload();
        return { writers, targets };
      }
    } catch {
      /* 落绝对兜底 */
    }
    // 绝对兜底：逐文件 SAF 选位置（每文件一次提示）。
    const uris = await Promise.all(
      files.map((f) =>
        save({ title: '保存文件（未授权“全部文件访问”）', defaultPath: sanitize(f.name) }),
      ),
    );
    if (uris.some((u) => !u)) throw new Error('用户取消了保存');
    const targets = uris.map((u) => ({ kind: 'saf', uri: u as string }) as SaveTarget);
    const writers = targets.map((t) => new TauriSafWriter((t as { uri: string }).uri));
    beginDownload();
    return { writers, targets };
  }
}

// L3 持久化 SAF：首次选一次文件夹，之后零弹框。tree URI 存 localStorage 跨重启复用。
const SAF_TREE_KEY = 'arkpulse.safTreeUri';
async function tauriResolveSafDir(): Promise<string | null> {
  const saved = localStorage.getItem(SAF_TREE_KEY);
  if (saved) {
    try {
      await invoke('plugin:arkpulse-android-fs|saf_take_permission', { tree_uri: saved }); // 复权（重启后仍有效，失败即失效）
      return saved;
    } catch {
      localStorage.removeItem(SAF_TREE_KEY);
    }
  }
  const picked = (await open({
    directory: true,
    title: '选择保存文件夹（ArkPulse）',
  })) as unknown as string | null;
  if (!picked) return null;
  try {
    await invoke('plugin:arkpulse-android-fs|saf_take_permission', { tree_uri: picked });
    localStorage.setItem(SAF_TREE_KEY, picked);
    return picked;
  } catch {
    localStorage.removeItem(SAF_TREE_KEY);
    return null;
  }
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
      // 错误加「落盘失败：」前缀：上层据此把它归为落盘/权限问题，
      // 不再套用「多为网络不稳定」的网络文案（那会把确定性故障说成网络波动，误导排查）。
      this.openPromise = invoke<string>('open_file', [this.resolvedPath] as any)
        .then((h) => {
          this.handle = h;
        })
        .catch((e) => {
          throw new Error('落盘失败：无法创建文件 ' + this.resolvedPath + '（' + String(e) + '）');
        });
    }
    return this.openPromise;
  }

  async write(data: Uint8Array): Promise<void> {
    await this.ensureOpen();
    this.pending.push(data);
    this.bufLen += data.byteLength;
    if (this.bufLen >= flushBytes()) await this.flush();
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
    if (!this.handle) throw new Error('落盘失败：文件句柄未就绪');
    try {
      await flushChunk(this.handle, combined);
    } catch (e) {
      throw new Error('落盘失败：写入磁盘出错（' + String(e) + '）');
    }
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.handle) {
      await invoke('close_file', [this.handle] as any);
      this.handle = null;
    }
  }

  async abort(): Promise<void> {
    await this.flush().catch(() => {});
    if (this.handle) {
      await invoke('abort_file', [this.handle] as any).catch(() => {});
      this.handle = null;
    }
  }
}

// SAF 兜底写入器：流式分块写入 SAF URI，仅 MANAGE 授权失败后兜底。
// 关键点：4MB 批量缓冲降 IPC 往返，峰值内存恒定。
export class TauriSafWriter {
  private handle: any = null; // FileHandle
  private openPromise: Promise<void> | null = null;
  private pending: Uint8Array[] = [];
  private bufLen = 0;

  constructor(private uri: string) {}

  private ensureOpen(): Promise<void> {
    if (!this.openPromise) {
      // SAF: ContentResolver 取可写描述符，append:true 即流式落盘（已核对 tauri-plugin-fs 2.5.1）。
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
    if (this.bufLen >= flushBytes()) await this.flush();
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
    try {
      await this.handle.write(combined);
    } catch (e) {
      throw new Error('落盘失败：写入所选位置出错（' + String(e) + '）');
    }
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
    // 兜底路径：已落盘文件无法回滚，关闭句柄丢弃未写入缓冲即可。
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
  constructor(private target: SaveTarget) {
    this.writer =
      target.kind === 'fs' ? new TauriFileWriter(target.path) : new TauriSafWriter(target.uri);
  }
  write(p: Uint8Array) {
    return this.writer.write(p);
  }
  async close() {
    await this.writer.close();
    await finishDownload(true, { usedSaf: this.target.kind === 'saf', count: 1 });
  }
  abort() {
    void this.writer.abort();
    void finishDownload(false, { usedSaf: this.target.kind === 'saf', count: 1 });
  }
}

// P2P Sink：对接 p2p/sinks.ts 的 Sink 接口（ready/writeChunk/close/abort）。
// 选目录 + 逐文件开句柄放进 ready；writeChunk 直接转发到对应文件写入器。
export class TauriP2PSink implements P2PSink {
  private writers: (TauriFileWriter | TauriSafWriter | null)[] = [];
  private targets: SaveTarget[] = [];
  private readyPromise: Promise<void>;
  private readyErr: any = null;

  constructor(private files: P2PFileMeta[]) {
    this.readyPromise = this.init();
    this.readyPromise.catch((e) => {
      this.readyErr = e;
    });
  }

  private async init() {
    const res = await tauriBuildWriters(this.files);
    this.writers = res.writers;
    this.targets = res.targets;
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
    const usedSaf = this.targets.some((t) => t.kind === 'saf');
    await finishDownload(true, { usedSaf, count: this.targets.length });
  }

  abort() {
    for (const w of this.writers) {
      if (w) void w.abort();
    }
    const usedSaf = this.targets.some((t) => t.kind === 'saf');
    void finishDownload(false, { usedSaf, count: this.targets.length });
  }
}
