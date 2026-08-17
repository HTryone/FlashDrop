// Tauri 接入层（核心逻辑，类比前端 .ts）：Rust 后端接管落盘，绕过浏览器 FSA 不兼容。
// 对外暴露两个 Sink 实现（中转 TauriRelaySink / P2P TauriP2PSink）对接现有 Sink 抽象，
// 以及路径选择 + 默认下载目录持久化（App 内可改，存 WebView 本地）。
//
// 安卓落盘级联（v3）：L1 MediaStore(下载/ArkPulse) → L2 std::fs 探针 → L3 持久 SAF → 绝对兜底逐文件 SAF。
//   仅 L2 走 file_writer.rs 的 std::fs（原样保留作兜底），L1/L3 由独立插件 arkpulse-android-fs 接管。
//   下载完成：仅成功弹原生「确定」确认框 + 系统通知（位置文案），失败不提示；下载期间亮屏保活。
// 核心 Rust std::fs 落盘逻辑一行未改，符合架构铁律。
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

// 安卓判断：用壳在页面运行前同步注入的设备标识（window.__FLASHDROP_CLIENT__），零 IPC、零异步、不可能失败。
//
// 【不可退化】旧版用 @tauri-apps/plugin-os 的 platform() 判断，而 Rust 端从未注册该插件、
// capabilities 也无 os 权限 → invoke 必然抛错 → catch 恒返回 false → 安卓被当成桌面：
// 弹系统保存框（用户看到的「明明授权了还让我选文件夹」），且拿到的 content:// URI 被当文件路径
// 喂给 Rust std::fs → 打开必失败 → 下载秒挂、速度 0。判端一律走本函数，不要再引入平台探测插件。
function isAndroid(): boolean {
  return isPhone();
}

const DEFAULT_DIR_KEY = 'arkpulse.defaultSaveDir';
// 批量 invoke 阈值：降 IPC 往返（修 D5）。手机端取更小值——安卓 IPC 只能传文本（见 flushChunk），
// 单次载荷越大主线程编码/解析卡顿越明显，2MB 在吞吐与流畅度之间最稳。
function flushBytes(): number {
  return isAndroid() ? 2 * 1024 * 1024 : 4 * 1024 * 1024;
}

// content:// 是安卓 SAF 的文件标识，不是文件系统路径，绝不能交给 Rust std::fs。
function isContentUri(p: string): boolean {
  return /^content:\/\//i.test(p) || /^file:\/\//i.test(p);
}

// 二进制转 base64（分块处理，避免 4MB 一次 apply 爆调用栈）。
// 仅安卓路径使用：安卓 WebView 的 IPC 只能传字符串，Tauri 的二进制 Raw 载荷在该平台不可用。
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32KB/次，兼顾栈安全与拼接次数
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}

// 统一的「写一块数据到已打开句柄」：按平台选 IPC 载荷形态。
//
// 【性能铁律·不可退化】桌面必须把数据作为 invoke 的整个 args 传（走二进制 Raw，零膨胀），
// 句柄放请求头；一旦写成 invoke('write_chunk', { handle, data }) 这种对象形态，
// Tauri 的 processIpcMessage 会 JSON.stringify + Array.from(Uint8Array)，
// 4MB 二进制膨胀成 12~16MB 数字数组文本（桌面白烧 3~4 倍带宽与 CPU，
// 手机端直接打死 WebView 主线程 → 进度不动、速度显示 0、55s 看门狗超时 → 误报「网络波动」）。
// 安卓不支持 Raw（Tauri 官方限制），退到 base64（膨胀 1.33x），是该平台最优解。
async function flushChunk(handle: string, data: Uint8Array): Promise<void> {
  if (isAndroid()) {
    await invoke('write_chunk_b64', { handle, data: bytesToBase64(data) });
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

// 安卓基目录：真正的公共下载目录 /storage/emulated/0/Download/ArkPulse。
//
// 【不可退化】不要用 downloadDir()——Tauri 安卓实现是 getExternalFilesDir(DIRECTORY_DOWNLOADS)，
// 指向 app 私有沙盒 /Android/data/<包名>/files/Download：不需要任何权限，但用户在文件管理器的
// 「下载」里根本看不到文件，「全部文件访问」权限等于白授。homeDir() 在安卓是
// Environment.getExternalStorageDirectory() = /storage/emulated/0，join Download/ArkPulse
// 才是用户认知里的下载目录。取不到时才退回私有目录（至少能落地）。
async function androidBaseDir(): Promise<string> {
  try {
    const home = await homeDir();
    return await join(home, 'Download', 'ArkPulse');
  } catch {
    const dl = await downloadDir();
    return join(dl, 'ArkPulse').catch(() => dl);
  }
}
// 尝试用 Rust std::fs 在公共下载目录解析不重名路径。
// Rust 侧会 create_dir_all + 落写探针验证真实可写：未取得「全部文件访问」权限时抛错，
// 调用方据此走 SAF 兜底（旧版命令永不失败，导致兜底分支形同虚设）。
async function tryResolveFs(name: string): Promise<string> {
  const dir = await androidBaseDir();
  return invoke<string>('resolve_save_path', { dir, name });
}

// 中转：桌面弹系统保存对话框；安卓优先落系统下载目录（需 MANAGE 权限），失败走 SAF 每次选文件。
export async function tauriPickSavePath(name: string): Promise<SaveTarget | null> {
  if (isAndroid()) {
    // L1 MediaStore：固定 Download/ArkPulse，零权限零弹框（现代设备一锤定音）。
    try {
      const uri = await invoke<string>('mediastore_insert', { name });
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
  const dir = await getDefaultSaveDir();
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
      await invoke<string>('resolve_save_path', { dir, name: '.probe' });
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
        const finalPath = await invoke<string>('resolve_save_path', { dir, name: sanitize(f.name) });
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
        const uri = await invoke<string>('mediastore_insert', { name: sanitize(f.name) });
        return { kind: 'mediastore', uri } as SaveTarget;
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
            const finalPath = await invoke<string>('resolve_save_path', { dir, name: sanitize(f.name) });
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
            const uri = await invoke<string>('saf_create_child', { tree_uri: treeUri, name: sanitize(f.name) });
            return { kind: 'saf', uri } as SaveTarget;
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

// L3 持久化 SAF 目录授权：首次弹系统目录选择器选一次，takePersistableUriPermission 存系统，
// tree URI 存 localStorage 跨重启复用；之后直写子树零弹框。授权失效（被撤销/清空）则重新选。
const SAF_TREE_KEY = 'arkpulse.safTreeUri';
async function tauriResolveSafDir(): Promise<string | null> {
  const saved = localStorage.getItem(SAF_TREE_KEY);
  if (saved) {
    try {
      await invoke('saf_take_permission', { tree_uri: saved }); // 复权（重启后仍有效，失败即失效）
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
    await invoke('saf_take_permission', { tree_uri: picked });
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
      this.openPromise = invoke<string>('open_file', { path: this.resolvedPath })
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
