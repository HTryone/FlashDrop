// 接收端「写入落盘」抽象：安全上下文用 StreamSaver 流式写盘（不爆内存），
// 非安全上下文（手机经 http 局域网访问）Service Worker 不可用 → 降级为浏览器 Blob 下载。
// Chromium 优先走 File System Access API 直写磁盘（无 SW/iframe，避开扩展消息污染导致的崩溃）。
// 纯浏览器 API，无 Vue 依赖。

import type { FileMeta, Sink } from './types';

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
    const h = await this.handle; // getFileHandle() 返回 Promise，必须先 await 拿到真实句柄再 createWritable
    if (!this.writable) this.writable = await h.createWritable();
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
}

/** 根据文件清单 + 目录句柄，构造一组落盘 Sink（优先级：FSA > StreamSaver > Blob） */
export async function makeSinks(files: FileMeta[], dirHandle?: any): Promise<MakeSinksResult> {
  let writers: Sink[] = [];
  let fallback = false;
  if (dirHandle && !(dirHandle as any).__cancelled) {
    try {
      writers = files.map((f) => {
        const safeName = String(f.name).replace(/[\\/]/g, '_');
        return new FSAccessSink(dirHandle.getFileHandle(safeName, { create: true }));
      });
      return { writers, fallback };
    } catch {
      writers = [];
    }
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
      return { writers, fallback };
    } catch {
      /* fallthrough to Blob */
    }
  }
  fallback = true;
  writers = files.map((f) => new BlobSink(f.name));
  return { writers, fallback };
}
