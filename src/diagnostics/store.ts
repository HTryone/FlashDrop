// 内存 RingBuffer + 订阅（服务 UI 实时展示）。文件落盘由 Rust 负责（§3.2 铁律：崩溃可恢复来源是文件）。
import type { DiagFilter, LogEntry } from './types';

const MAX = 2000;

type Listener = (entries: LogEntry[]) => void;

class DiagStore {
  private buf: LogEntry[] = [];
  private listeners = new Set<Listener>();
  // 自监控（§1.8）：溢出计数，避免「静默丢日志」自己挂了还不知道。
  dropped = 0;

  push(e: LogEntry) {
    this.buf.push(e);
    if (this.buf.length > MAX) {
      this.buf.splice(0, this.buf.length - MAX);
      this.dropped++;
    }
    const snapshot = this.buf.slice();
    this.listeners.forEach((l) => l(snapshot));
  }

  all(): LogEntry[] {
    return this.buf.slice();
  }

  filtered(f: DiagFilter): LogEntry[] {
    return this.buf.filter((e) => {
      if (f.level && levelRank(e.level) < levelRank(f.level)) return false;
      if (f.channel && e.channel !== f.channel) return false;
      if (f.traceId && e.traceId !== f.traceId) return false;
      if (f.keyword) {
        const hay = `${e.channel} ${e.scope} ${e.msg}`.toLowerCase();
        if (!hay.includes(f.keyword.toLowerCase())) return false;
      }
      return true;
    });
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // 崩溃恢复后由 UI 调用，注入读自文件的崩溃前事件（不进 RingBuffer 上限逻辑之外的持久区）。
  hydrate(entries: LogEntry[]) {
    entries.forEach((e) => this.buf.push(e));
    if (this.buf.length > MAX) this.buf.splice(0, this.buf.length - MAX);
  }
}

function levelRank(l: LogEntry['level']): number {
  return { debug: 0, info: 1, warn: 2, error: 3 }[l];
}

export const diagStore = new DiagStore();
