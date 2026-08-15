// 接收端「写入落盘」抽象（公共件）：安全上下文用 StreamSaver 流式写盘（不爆内存），
// 非安全上下文（手机经 http 局域网访问）Service Worker 不可用 → 降级为浏览器 Blob 下载。
// Chromium 优先走 File System Access API 直写磁盘（无 SW/iframe，避开扩展消息污染导致的崩溃）。
// 纯浏览器 API，无 Vue 依赖。由 https/sink.ts 迁入 composables 成为全工作区共用落盘件。

import { isTauriEnv, TauriRelaySink, tauriPickSavePath, tauriBuildWriters } from '../tauri/tauri-sink';

export interface FileMeta {
  name: string;
  size: number;
}

/** 落盘 Sink：接收端写入抽象（FSA / StreamSaver / Blob 兜底） */
export interface Sink {
  write(p: Uint8Array): Promise<void> | void;
  close(): Promise<void>;
  abort(): void;
}

let _ssPromise: Promise<any> | null = null;
function ensureStreamSaver(): Promise<any> {
  if (!_ssPromise) {
    // @ts-ignore
    _ssPromise = import('streamsaver').then((m: any) => {
      const mod = m.default || m;
      try { mod.mitm = `${location.origin}/mitm.html`; } catch { /* ignore */ }
      return mod;
    });
  }
  return _ssPromise;
}

function isSecureContextForSW(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
}

// 在下载前确认 SW 已接管本页面（app 启动已在 main.ts 提前注册 /sw.js，这里只需等待 controller 就绪）。
// StreamSaver 走「SW 直连通道」而非脆弱的 mitm iframe 兜底。
async function ensureSWControlled(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  if (navigator.serviceWorker.controller) return;
  try { await navigator.serviceWorker.ready; } catch { /* ignore */ }
  if (navigator.serviceWorker.controller) return;
  await new Promise<void>((resolve) => {
    const done = () => { clearInterval(timer); resolve(); };
    const timer = setInterval(() => {
      if (navigator.serviceWorker.controller) done();
    }, 100);
    navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
    setTimeout(done, 5000); // 延长到 5s 兜底，超时则退回 mitm/blob，绝不阻塞下载
  });
}

function triggerDownload(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

class StreamSink implements Sink {
  private w: any;
  constructor(w: any) { this.w = w; }
  write(p: Uint8Array) { return this.w.write(p); }
  async close() { await this.w.close(); }
  abort() { try { this.w.abort(); } catch { /* ignore */ } }
}
class BlobSink implements Sink {
  private chunks: Uint8Array[] = [];
  constructor(private name: string) {}
  write(p: Uint8Array) { this.chunks.push(p); return Promise.resolve(); }
  async close() {
    const blob = new Blob(this.chunks as any);
    triggerDownload(blob, this.name);
    this.chunks = [];
  }
  abort() { this.chunks = []; }
}

// Chromium 专用：File System Access API 直接流式落盘，无需 SW / iframe / MessageChannel。
class FSAccessSink implements Sink {
  private writable: any = null;
  constructor(private handle: any) {}
  async write(p: Uint8Array) {
    const h = await this.handle; // makeSinks 已预解析为真实 FileSystemFileHandle
    if (!this.writable) {
      try {
        this.writable = await h.createWritable();
      } catch (e: any) {
        // 极端情况下 createWritable 仍失败（如权限被中途撤销）→ 抛类型化错误供上层识别
        throw new Error('SAVE_DIR_DENIED');
      }
    }
    await this.writable.write(p);
  }
  async close() {
    if (this.writable) { await this.writable.close(); this.writable = null; }
  }
  abort() { try { this.writable?.abort(); } catch { /* ignore */ } }
}

/** 用户手势内调用（连接接收按钮触发），拿到目录句柄；非 Chromium 返回 null 走 StreamSaver 兜底。 */
export async function pickSaveDir(): Promise<any | null> {
  const w = window as any;
  if (typeof w.showDirectoryPicker !== 'function') return null;
  try {
    const dir = await w.showDirectoryPicker();
    console.log('[recv] showDirectoryPicker ok');
    return dir;
  } catch (e: any) {
    console.log('[recv] showDirectoryPicker error:', e?.name, e?.message);
    return { __cancelled: true, __error: e?.name || String(e) };
  }
}

export interface MakeSinksResult {
  writers: Sink[];
  fallback: boolean; // 是否降级为 Blob 整文件下载
  permissionFallback?: boolean; // FSA 授权失败，已降级 StreamSaver/Blob（用户仍拿到文件）
}

/** 显式把目录句柄提权到 readwrite：部分浏览器/上下文 picker 不隐式授予，
 * 必须主动 requestPermission 才能 getFileHandle({create:true})，否则抛 SecurityError。
 * queryPermission 已 granted 则跳过，避免多余弹窗。 */
async function ensureRwPermission(dh: any): Promise<boolean> {
  if (!dh || typeof dh.requestPermission !== 'function') return true;
  try {
    if (typeof dh.queryPermission === 'function') {
      const q = await dh.queryPermission({ mode: 'readwrite' });
      if (q === 'granted') return true;
    }
    const r = await dh.requestPermission({ mode: 'readwrite' });
    return r === 'granted';
  } catch {
    return false;
  }
}

/** 根据文件清单 + 目录句柄，构造一组落盘 Sink（优先级：FSA > StreamSaver > Blob） */
export async function makeSinks(files: FileMeta[], dirHandle?: any): Promise<MakeSinksResult> {
  // ── Tauri 原生壳：Rust 后端接管落盘，绕过浏览器 FSA 不兼容（共存不替代）──
  if (isTauriEnv()) {
    // 单文件（中转 tus / 单文件本地直传）：save 对话框 → 单个 TauriRelaySink
    if (files.length <= 1) {
      const name = files[0]?.name ?? 'download';
      const target = await tauriPickSavePath(name);
      if (!target) return { writers: [], fallback: false, permissionFallback: false };
      return { writers: [new TauriRelaySink(target)], fallback: false, permissionFallback: false };
    }
    // 多文件（本地直传 HTTP 多文件）：tauriBuildWriters 统一处理「目录直写 / SAF 兜底」
    const writers = await tauriBuildWriters(files);
    if (writers.length === 0) return { writers: [], fallback: false, permissionFallback: false };
    return { writers, fallback: false, permissionFallback: false };
  }
  let writers: Sink[] = [];
  let fallback = false;
  let permissionFallback = false;
  if (dirHandle && !(dirHandle as any).__cancelled) {
    // 显式提权：消除「隐式授权不成立 → getFileHandle 抛 SecurityError」的真实用户路径
    const permOk = await ensureRwPermission(dirHandle);
    if (permOk) {
      try {
        // 预解析所有句柄并立即 await：拒绝在存入 Sink 前被标记 handled，
        // 杜绝「裸存 rejected Promise → 后续 await 时早已 unhandledrejection」的缺陷。
        const handles = await Promise.all(
          files.map((f) => {
            const safeName = String(f.name).replace(/[\\/]/g, '_');
            return dirHandle.getFileHandle(safeName, { create: true });
          }),
        );
        writers = handles.map((h: any) => new FSAccessSink(h));
        return { writers, fallback, permissionFallback };
      } catch {
        writers = [];
      }
    }
    // FSA 授权失败或句柄解析失败：标记降级后 fallthrough 到下方 StreamSaver/Blob 兜底，
    // 用户仍拿到文件。注意：此处不能提前 return 空 writers，否则上层 sink=undefined 会崩。
    permissionFallback = true;
  }
  let ss: any = null;
  if (isSecureContextForSW()) {
    try {
      await ensureSWControlled();
      ss = await ensureStreamSaver();
    } catch {
      ss = null;
    }
  }
  if (ss && ss.supported !== false) {
    try {
      writers = files.map((f) => new StreamSink(ss.createWriteStream(f.name, { size: f.size || undefined }).getWriter()));
      return { writers, fallback, permissionFallback };
    } catch {
      /* fallthrough to Blob */
    }
  }
  fallback = true;
  writers = files.map((f) => new BlobSink(f.name));
  return { writers, fallback, permissionFallback };
}
