// X3 写入器（P2P 专用，新增）：路径与 L1 MediaStore 完全相同（uri 来自 mediastore_insert），
// 仅写盘处理方式不同——走 saf_stream_open/append/close（Kotlin PFD FileChannel 流式 append），
// 绕开 ContentProvider openOutputStream 的事务 + 媒体索引放大。双缓冲逻辑同 TauriSafWriter。
import { invoke } from '@tauri-apps/api/core';
import { flushBytes, logFlushPerf } from './shared';

export class TauriSafStreamWriter {
  private handle: string | null = null;
  private openPromise: Promise<void> | null = null;
  private pending: Uint8Array[] = [];
  private bufLen = 0;

  // 后台双缓冲协调状态
  private closedFlag = false;
  private flushStarted = false;
  private flushDoneResolve: (() => void) | null = null;
  private flushDone: Promise<void>;
  private notifyResolve: (() => void) | null = null;
  private notifyPromise: Promise<void>;
  private backpressureResolve: (() => void) | null = null;

  constructor(private uri: string) {
    this.flushDone = new Promise<void>((r) => { this.flushDoneResolve = r; });
    this.notifyPromise = new Promise<void>((r) => { this.notifyResolve = r; });
  }

  private ensureOpen(): Promise<void> {
    if (!this.openPromise) {
      // X3：用 mediastore_insert 返回的 uri 开 PFD 流式句柄（路径与 L1 完全一致）。
      this.openPromise = invoke<{ handle: string }>('plugin:arkpulse-android-fs|saf_stream_open', { uri: this.uri })
        .then((r) => {
          this.handle = r.handle;
          this.startFlushLoop();
        });
    }
    return this.openPromise;
  }

  private startFlushLoop() {
    if (this.flushStarted) return;
    this.flushStarted = true;
    if (this.closedFlag) { this.flushDoneResolve?.(); return; }
    void this.flushLoop().catch(() => {});
  }

  private signalData() {
    if (this.notifyResolve) {
      const r = this.notifyResolve;
      this.notifyResolve = null;
      this.notifyPromise = new Promise<void>((r) => { this.notifyResolve = r; });
      r();
    }
  }

  async write(data: Uint8Array): Promise<void> {
    await this.ensureOpen();
    this.pending.push(data);
    this.bufLen += data.byteLength;
    if (this.bufLen >= flushBytes()) this.signalData();
    while (this.bufLen > flushBytes() * 2 && !this.closedFlag) {
      await new Promise<void>((r) => { this.backpressureResolve = r; });
    }
  }

  private async flush(buf: Uint8Array[]): Promise<void> {
    if (buf.length === 0 || !this.handle) return;
    const totalLen = buf.reduce((s, c) => s + c.byteLength, 0);
    const combined = new Uint8Array(totalLen);
    let off = 0;
    for (const c of buf) {
      combined.set(c, off);
      off += c.byteLength;
    }
    try {
      // base64 经 IPC（安卓不支持 InvokeBody::Raw），与 TauriSafWriter 一致。
      await invoke('plugin:arkpulse-android-fs|saf_stream_append', {
        handle: this.handle,
        bytes: bytesToBase64Safe(combined),
      });
    } catch (e) {
      throw new Error('X3 落盘失败：' + String(e));
    }
  }

  /** 落盘计时埋点：包 flush 统计耗时与吞吐，写 perf 通道日志。 */
  private async timedFlush(buf: Uint8Array[], label: string): Promise<void> {
    const totalLen = buf.reduce((s, c) => s + c.byteLength, 0);
    const t0 = performance.now();
    await this.flush(buf);
    logFlushPerf(label, totalLen, performance.now() - t0);
  }

  private async flushLoop(): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    try {
      while (true) {
        if (this.bufLen >= flushBytes()) {
          const out = this.pending;
          this.pending = [];
          this.bufLen = 0;
          if (this.backpressureResolve) { const r = this.backpressureResolve; this.backpressureResolve = null; r(); }
          await this.timedFlush(out, 'TauriSafStreamWriter');
        }
        if (this.closedFlag) {
          if (this.pending.length > 0) await this.timedFlush(this.pending, 'TauriSafStreamWriter');
          this.pending = [];
          this.bufLen = 0;
          break;
        }
        await Promise.race([this.notifyPromise, sleep(20)]);
      }
    } finally {
      this.flushDoneResolve?.();
    }
  }

  async close(): Promise<void> {
    await this.ensureOpen().catch(() => {});
    this.closedFlag = true;
    this.signalData();
    if (!this.flushStarted) this.flushDoneResolve?.();
    await this.flushDone;
    if (this.handle) {
      await invoke('plugin:arkpulse-android-fs|saf_stream_close', { handle: this.handle }).catch(() => {});
      this.handle = null;
    }
  }

  async abort(): Promise<void> {
    this.closedFlag = true;
    this.signalData();
    if (!this.flushStarted) this.flushDoneResolve?.();
    await this.flushDone.catch(() => {});
    if (this.handle) {
      await invoke('plugin:arkpulse-android-fs|saf_stream_close', { handle: this.handle }).catch(() => {});
      this.handle = null;
    }
    this.pending = [];
    this.bufLen = 0;
  }
}

// base64 编码（与 shared.ts 同实现，避免跨模块依赖新增导出）。
function bytesToBase64Safe(bytes: Uint8Array): string {
  const CHUNK = 8 * 1024;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    parts.push(String.fromCharCode(...bytes.subarray(i, end)));
  }
  return btoa(parts.join(''));
}
