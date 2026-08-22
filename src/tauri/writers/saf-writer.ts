// SAF 写入器（安卓 L1 MediaStore / L3 持久 SAF / 绝对兜底）：流式分块写入 SAF URI。
// 4MB 批量缓冲降 IPC 往返，峰值内存恒定。双缓冲落盘（同 TauriFileWriter）。
import { open as fsOpen } from '@tauri-apps/plugin-fs';
import { flushBytes, logFlushPerf } from './shared';

export class TauriSafWriter {
  private handle: any = null; // FileHandle
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
      // SAF: ContentResolver 取可写描述符，append:true 即流式落盘（已核对 tauri-plugin-fs 2.5.1）。
      this.openPromise = fsOpen(this.uri, { write: true, append: true }).then((h) => {
        this.handle = h;
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
    if (buf.length === 0) return;
    const totalLen = buf.reduce((s, c) => s + c.byteLength, 0);
    const combined = new Uint8Array(totalLen);
    let off = 0;
    for (const c of buf) {
      combined.set(c, off);
      off += c.byteLength;
    }
    try {
      await this.handle.write(combined);
    } catch (e) {
      throw new Error('落盘失败：写入所选位置出错（' + String(e) + '）');
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
          await this.timedFlush(out, 'TauriSafWriter');
        }
        if (this.closedFlag) {
          if (this.pending.length > 0) await this.timedFlush(this.pending, 'TauriSafWriter');
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
      await this.handle.close();
      this.handle = null;
    }
  }

  async abort(): Promise<void> {
    this.closedFlag = true;
    this.signalData();
    if (!this.flushStarted) this.flushDoneResolve?.();
    await this.flushDone.catch(() => {});
    if (this.handle) {
      await this.handle.close().catch(() => {});
      this.handle = null;
    }
    this.pending = [];
    this.bufLen = 0;
  }
}
