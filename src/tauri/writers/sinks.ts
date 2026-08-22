// Tauri 上层 Sink：对接中转（RelaySink）/ P2P（P2PSink）接口，内部委托具体写入器。
import type { Sink as RelaySink } from '../../composables/filesink';
import type { Sink as P2PSink } from '../../p2p/sinks';
import type { P2PFileMeta } from '../../p2p/types';
import type { SaveTarget } from './shared';
import { TauriFileWriter } from './file-writer';
import { TauriSafWriter } from './saf-writer';
import { tauriBuildWriters, tauriBuildP2PWritersX3 } from './factory';
import { isX3StreamEnabled } from './shared';
import type { TauriSafStreamWriter } from './saf-stream-writer';
import { finishDownload } from '../notify';

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
  private writers: (TauriFileWriter | TauriSafWriter | TauriSafStreamWriter | null)[] = [];
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
    // 【纪律】X3 仅 P2P 专用、默认开启（P2P 优先 X3）。localStorage arkpulse.x3stream.disable='1' 才退回 L1。
    // HTTP/中转一律不碰，仍走原 tauriBuildWriters（L1）。
    const res = isX3StreamEnabled() ? await tauriBuildP2PWritersX3(this.files) : await tauriBuildWriters(this.files);
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
    // X3（safstream）路径同 L1，提示仍显示「下载/ArkPulse」，不算 usedSaf。
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
