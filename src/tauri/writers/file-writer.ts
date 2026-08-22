// Tauri 文件写入器（桌面 L2 / 安卓 L2 std::fs 兜底）：双缓冲落盘。
import { invoke } from '@tauri-apps/api/core';
import { flushBytes, flushChunk, logFlushPerf } from './shared';

export class TauriFileWriter {
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

  constructor(private resolvedPath: string) {
    this.flushDone = new Promise<void>((r) => { this.flushDoneResolve = r; });
    this.notifyPromise = new Promise<void>((r) => { this.notifyResolve = r; });
  }

  ensureOpen(): Promise<void> {
    if (!this.openPromise) {
      // 错误加「落盘失败：」前缀：上层据此把它归为落盘/权限问题，
      // 不再套用「多为网络不稳定」的网络文案（那会把确定性故障说成网络波动，误导排查）。
      this.openPromise = invoke<string>('open_file', [this.resolvedPath] as any)
        .then((h) => {
          this.handle = h;
          this.startFlushLoop();
        })
        .catch((e) => {
          throw new Error('落盘失败：无法创建文件 ' + this.resolvedPath + '（' + String(e) + '）');
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
    // 仅入缓冲并立即返回，落盘在后台 flushLoop 进行，前台（解密/收包）零阻塞
    this.pending.push(data);
    this.bufLen += data.byteLength;
    if (this.bufLen >= flushBytes()) this.signalData();
    // 轻量背压：缓冲超过 2×阈值(8MB) 才短暂等待 drain，避免内存无限涨；
    // 正常磁盘下 flushLoop 持续排空，几乎不触发。
    while (this.bufLen > flushBytes() * 2 && !this.closedFlag) {
      await new Promise<void>((r) => { this.backpressureResolve = r; });
    }
  }

  /** 合并 buf 一次性落盘（清空由调用方在 swap 时处理） */
  private async flush(buf: Uint8Array[]): Promise<void> {
    if (buf.length === 0) return;
    const totalLen = buf.reduce((s, c) => s + c.byteLength, 0);
    const combined = new Uint8Array(totalLen);
    let off = 0;
    for (const c of buf) {
      combined.set(c, off);
      off += c.byteLength;
    }
    if (!this.handle) throw new Error('落盘失败：文件句柄未就绪');
    try {
      await flushChunk(this.handle, combined);
    } catch (e) {
      throw new Error('落盘失败：写入磁盘出错（' + String(e) + '）');
    }
  }

  /** 落盘计时埋点：包 flush 统计耗时与吞吐，写 perf 通道日志。 */
  private async timedFlush(buf: Uint8Array[], label: string): Promise<void> {
    const totalLen = buf.reduce((s, c) => s + c.byteLength, 0);
    const t0 = performance.now();
    await this.flush(buf);
    logFlushPerf(label, totalLen, performance.now() - t0);
  }

  /** 后台刷盘循环：持续合并落盘；close 后收尾刷剩余；退出时 resolve flushDone */
  private async flushLoop(): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    try {
      while (true) {
        if (this.bufLen >= flushBytes()) {
          // SWAP：交出当前缓冲，前台立即用新空缓冲继续收数据，落盘与接收重叠
          const out = this.pending;
          this.pending = [];
          this.bufLen = 0;
          if (this.backpressureResolve) { const r = this.backpressureResolve; this.backpressureResolve = null; r(); }
          await this.timedFlush(out, 'TauriFileWriter');
        }
        if (this.closedFlag) {
          if (this.pending.length > 0) await this.timedFlush(this.pending, 'TauriFileWriter');
          this.pending = [];
          this.bufLen = 0;
          break;
        }
        // 无达标缓冲且未关闭：等信号或 20ms 兜底重查，避免空轮询/deadlock
        await Promise.race([this.notifyPromise, sleep(20)]);
      }
    } finally {
      this.flushDoneResolve?.();
    }
  }

  async close(): Promise<void> {
    await this.ensureOpen().catch(() => {});
    this.closedFlag = true;
    this.signalData(); // 唤醒 flushLoop 走收尾分支
    if (!this.flushStarted) this.flushDoneResolve?.(); // 无数据（open 即失败）→ 直接收尾
    await this.flushDone; // 等后台把剩余缓冲全部落盘
    if (this.handle) {
      await invoke('close_file', [this.handle] as any);
      this.handle = null;
    }
  }

  async abort(): Promise<void> {
    this.closedFlag = true;
    this.signalData();
    if (!this.flushStarted) this.flushDoneResolve?.();
    await this.flushDone.catch(() => {});
    if (this.handle) {
      await invoke('abort_file', [this.handle] as any).catch(() => {});
      this.handle = null;
    }
  }
}
