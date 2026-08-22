// Tauri 落盘共享层：类型 + 公共 helper。被各写入器（file-writer / saf-writer）与工厂（factory）共用。
import { invoke } from '@tauri-apps/api/core';
import { downloadDir, homeDir, join } from '@tauri-apps/api/path';
import { isPhone } from '../client';
import { log } from '../../diagnostics/logger';
import type { TauriFileWriter } from './file-writer';
import type { TauriSafWriter } from './saf-writer';
import type { TauriSafStreamWriter } from './saf-stream-writer';

export type SaveTarget =
  | { kind: 'fs'; path: string }
  | { kind: 'mediastore'; uri: string }
  | { kind: 'saf'; uri: string }
  | { kind: 'safstream'; uri: string }; // X3 专用：路径同 L1（mediastore uri），仅写盘方式不同
export type AnyTauriWriter = TauriFileWriter | TauriSafWriter | TauriSafStreamWriter;

// 安卓判断：用壳同步注入的设备标识，零 IPC、零异步。
// 【不可退化】旧版用 @tauri-apps/plugin-os 的 platform()，但 Rust 端未注册 → invoke 抛错
// → 安卓被当桌面 → 弹保存框 + content:// URI 喂给 Rust std::fs 必失败，下载秒挂。
function isAndroid(): boolean {
  return isPhone();
}

const DEFAULT_DIR_KEY = 'arkpulse.defaultSaveDir';
// 批量 invoke 阈值：降 IPC 往返（修 D5）。
// 桌面 4MB（Raw 零膨胀）；安卓同样 4MB（base64 性能已优化，2MB 过于保守）。
function flushBytes(): number {
  return 4 * 1024 * 1024;
}

// content:// 是 SAF 标识，不是文件路径，绝不能交给 Rust std::fs。
function isContentUri(p: string): boolean {
  return /^content:\/\//i.test(p) || /^file:\/\//i.test(p);
}

// 二进制转 base64（高效版：两阶段批量编码，避免 apply 栈溢出）。
// 旧实现用 String.fromCharCode.apply(null, array) 处理大 Uint8Array 时触发栈溢出，
// 改为分块循环调用 String.fromCharCode(...slice)（每块 8KB，约 8K 参数，JS 引擎默认栈上限 ~10K），
// 再 btoa 一次合成完整 base64 字符串。4MB 数据约需 512 次循环，主线程耗时 < 5ms。
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8 * 1024; // 8KB/次，控制在 JS 引擎参数栈上限内
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    // 展开操作符比 apply 更安全（无需 as unknown 转型，V8 内置优化）
    parts.push(String.fromCharCode(...bytes.subarray(i, end)));
  }
  return btoa(parts.join(''));
}

// 安卓写盘路径：走 base64（膨胀 1.33x）。Tauri 安卓不支持 InvokeBody::Raw（平台限制：WebView WebResourceRequest 不暴露请求体），故不试 Raw。
async function flushChunk(handle: string, data: Uint8Array): Promise<void> {
  if (isAndroid()) {
    await invoke('write_chunk_b64', [handle, bytesToBase64(data)] as any);
    return;
  }
  await invoke('write_chunk', data, { headers: { 'x-fd-handle': handle } });
}

// 落盘计时埋点（perf 通道）：每次后台 flush 记录耗时与吞吐，真机诊断面板可见，
// 用于验证「落盘远快于网络到达、非瓶颈」的假设（数值为实测，非推算）。
function logFlushPerf(label: string, bytes: number, ms: number): void {
  const mb = bytes / (1024 * 1024);
  const mbps = ms > 0 ? mb / (ms / 1000) : 0;
  log('info', 'perf', 'tauri-sink', `落盘 ${mb.toFixed(2)}MB 耗时 ${ms.toFixed(0)}ms · 吞吐 ${mbps.toFixed(1)} MB/s（${label}）`);
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

// X3 开关（P2P 专用）：P2P 默认优先走 X3 流式写（路径同 L1、零弹框）。
// 语义为「禁用 X3」：localStorage 置 '1' 才退回原 L1；默认不置 → 走 X3。
// HTTP/中转不受影响。
const X3_DISABLE_KEY = 'arkpulse.x3stream.disable';
export function isX3StreamEnabled(): boolean {
  return localStorage.getItem(X3_DISABLE_KEY) !== '1';
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

export {
  isAndroid,
  flushBytes,
  isContentUri,
  bytesToBase64,
  flushChunk,
  logFlushPerf,
  parentDir,
  androidBaseDir,
  tryResolveFs,
};
