// 本地直传——接收端状态机（HTTP 流式中继）。
// 从 LocalTransfer.vue 抽离为纯 TS 类；Vue 组件只实例化本类并通过回调更新 UI。
// 行为与原内联逻辑逐字节一致：帧协议读取、逐段消费、并发解密 + 保序写盘、段末 segend 判定结束、OPFS/落盘校验。

import { decodeFrame, FrameReader, FRAME_HDR } from './frame';
import { resolveRelayBase } from '@/transfer/room';
import { segRoom } from './segment';
import { RelayControl } from './control';
import { makeSinks, pickSaveDir } from '@/composables/filesink';
import type { FileMeta, Sink } from './types';
import { decryptChunkAsync } from '@/https/useLocalCrypto';
import { deriveKey, LOCAL_SALT, LOCAL_CHUNK_SIZE } from '@/crypto/e2ee';

export interface ReceiverCallbacks {
  onStatus: (s: string) => void;
  onRecvReady: (v: boolean) => void;
  onSenderOnline: (v: boolean) => void;
  onFiles: (files: FileMeta[]) => void;
  onProgress: (p: number) => void; // 0..1
  onFileProgress?: (progs: number[]) => void; // 逐文件进度（0..1，与 files 同序）；底层单流顺序写盘，按全局序号推导
  onSegCount: (n: number) => void;
  onReceiving: (v: boolean) => void;
  onDone?: () => void;
  onFail?: (msg: string) => void;
}

export class LocalReceiver {
  room = '';
  pass = '';
  private key = '';

  private writers: Sink[] = [];
  private fallback = false;
  private fr = new FrameReader();

  private receiving = false;
  private recvAborted = false;
  private recvAbort: AbortController | null = null;
  private ctrl: RelayControl | null = null;

  private recvBytes = 0;
  private recvTotal = 0;
  private recvChunks = 0;
  private recvTotalChunks = 0;
  private recvReceived = 0;
  private finishing = false;
  private lastProgressAt = 0;
  private recvDoneSent = false;

  private perFileChunks: number[] = [];
  private nextWriteSeq = 0;
  private readyBuf = new Map<number, { fi: number; plain: Uint8Array }>();
  private drainRunning = false;
  private pendingDone = false;
  private manifest0: FileMeta[] | null = null;
  private lastSegSeen = false;
  private segCount = 1;

  constructor(private cb: ReceiverCallbacks) {}

  setRoom(r: string) { this.room = r; }
  setPass(p: string) { this.pass = p; }

  /** 解析整条分享链接，填入房间码与密钥 */
  parseLink(text: string) {
    const s = text.trim();
    if (!s) return;
    try {
      const u = new URL(s);
      const r = u.searchParams.get('room');
      if (r) this.room = r;
      const k = new URLSearchParams(u.hash.slice(1)).get('k');
      if (k) this.pass = k;
    } catch { /* 不是合法 URL 则忽略 */ }
  }

  /** 取消当前接收并重置为初始状态 */
  cancel() {
    this.recvAborted = true;
    this.readyBuf.clear();
    for (const w of this.writers) { try { w.abort(); } catch { /* ignore */ } }
    this.writers = [];
    this.recvAborted = false;
    this.resetReceiver();
    this.cb.onReceiving(false);
    // 通知发送端"我取消了"，避免对方一直等待/重发
    if (this.ctrl?.isOpen) { try { this.ctrl.send({ type: 'cancel' }); } catch { /* ignore */ } }
    setTimeout(() => this.closeConn(), 300);
    this.cb.onStatus('已取消接收，可重新连接接收');
  }

  /** 组件卸载清理 */
  close() {
    this.closeConn();
  }

  private closeConn() {
    if (this.recvAbort) { try { this.recvAbort.abort(); } catch { /* ignore */ } this.recvAbort = null; }
    if (this.ctrl) { this.ctrl.close(); this.ctrl = null; }
    this.finishing = false;
  }

  private resetReceiver() {
    this.receiving = false;
    this.recvBytes = 0;
    this.recvTotal = 0;
    this.recvChunks = 0;
    this.recvTotalChunks = 0;
    for (const w of this.writers) { try { w.abort(); } catch { /* ignore */ } }
    this.writers = [];
    this.key = '';
    this.recvReceived = 0;
    this.lastProgressAt = 0; this.recvDoneSent = false;
    this.perFileChunks = []; this.nextWriteSeq = 0; this.readyBuf.clear(); this.drainRunning = false;
    this.pendingDone = false;
    this.finishing = false;
  }

  // ============ 启动 ============
  async start() {
    if (!this.room || !this.pass) {
      this.cb.onStatus('需要房间码和口令'); return;
    }
    this.closeConn();
    this.resetReceiver();
    this.fr.reset();

    // 在用户手势内先弹目录选择器（Chromium File System Access API）；取消选择则放弃本次接收。
    const picked = await pickSaveDir();
    if (picked && (picked as any).__cancelled) {
      const errName = (picked as any).__error || '';
      this.cb.onStatus(errName
        ? `选择保存目录失败: ${errName}。请检查浏览器是否禁用了文件选择器，或换用 localhost/https 访问。`
        : '已取消选择保存目录');
      this.receiving = false;
      return;
    }
    const dirHandle = picked;
    if (dirHandle) {
      try {
        const perm = await (dirHandle as any).requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          this.cb.onStatus('需要目录读写权限才能保存文件');
          this.receiving = false;
          return;
        }
      } catch (e: any) {
        this.cb.onStatus(`目录授权失败: ${e?.message || e}`);
        this.receiving = false;
        return;
      }
    }

    try {
      this.key = await deriveKey(this.pass, LOCAL_SALT);
    } catch (e: any) {
      this.cb.onStatus(`密钥派生失败: ${e?.message || e}`); return;
    }

    this.receiving = true;
    this.cb.onReceiving(true);
    this.recvAbort = new AbortController();
    const base = resolveRelayBase();
    this.manifest0 = null;
    this.lastSegSeen = false;

    for (let seg = 0; ; seg++) {
      if (this.recvAborted) break;
      const ok = await this.recvSegment(base, seg, dirHandle);
      if (!ok || !this.receiving) break;
      if (this.lastSegSeen) break;
    }
  }

  // ============ 单段接收 ============
  private async recvSegment(base: string, seg: number, dirHandle: any): Promise<boolean> {
    const room = segRoom(this.room, seg);
    // 接收端 WS 是 progress 的唯一上行通道，而发送端靠 progress 推进 24MB ack 窗口：
    // WS 一旦断开且不重连，progress 停 → 发送端窗口卡死。故必须开自动重连。
    this.ctrl = new RelayControl({
      base, room, role: 'receiver',
      onMessage: (data: any) => {
        if (data && data.type === 'cancel') {
          this.recvAborted = true;
          this.cb.onReceiving(false);
          this.cb.onStatus('对方已取消发送，已重置为初始状态，可重新接收');
          this.closeConn();
        }
      },
      reconnect: true, reconnectDelay: 1000,
      shouldReconnect: () => this.receiving && !this.recvAborted,
    });
    await this.ctrl.connect();

    let resp: Response;
    try {
      resp = await fetch(`${base}/stream/${room}`, {
        signal: this.recvAbort!.signal,
        headers: { 'Accept': 'application/octet-stream' },
      });
    } catch (e: any) {
      this.cb.onStatus(`连接失败: ${e?.message || e}`);
      this.failRecv(`连接失败: ${e?.message || e}`); return false;
    }
    if (!resp.ok || !resp.body) {
      this.cb.onStatus(`连接失败: HTTP ${resp.status}`);
      this.failRecv(`连接失败: HTTP ${resp.status}`); return false;
    }

    this.cb.onSenderOnline(true);
    this.cb.onStatus(`第 ${seg + 1} 段：已连接，等待文件清单…`);
    let reader = resp.body.getReader();
    this.fr.setReader(reader);

    // 2. 读 offer（第一条消息）；跳过 DO 开场帧，读到真正的 offer(JSON) 为止。
    let offerPayload: Uint8Array | null = null;
    for (let attempt = 0; attempt < 3 && !offerPayload; attempt++) {
      if (attempt > 0) {
        reader.cancel();
        const r2 = await fetch(`${base}/stream/${room}`, { signal: this.recvAbort!.signal, headers: { 'Accept': 'application/octet-stream' } });
        if (!r2.ok || !r2.body) { this.cb.onStatus(`连接失败(重试${attempt}): HTTP ${r2.status}`); this.failRecv(`连接失败(重试${attempt}): HTTP ${r2.status}`); return false; }
        resp = r2; reader = r2.body.getReader(); this.fr.setReader(reader);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
      for (let guard = 0; guard < 8 && !offerPayload; guard++) {
        const m = await this.fr.readMsg();
        if (!m) break;
        try {
          const o = JSON.parse(new TextDecoder().decode(m));
          if (o && o.type === 'offer') offerPayload = m;
        } catch { /* 开场帧等非法 JSON，忽略继续读 */ }
      }
    }
    if (!offerPayload) { this.cb.onStatus('未收到文件清单，对方可能已断开'); this.failRecv('未收到文件清单，对方可能已断开'); return false; }
    const offer = JSON.parse(new TextDecoder().decode(offerPayload));
    if (!Array.isArray(offer.files) || offer.files.length === 0) { this.cb.onStatus('收到无效的文件清单'); this.failRecv('收到无效的文件清单'); return false; }
    const segIndex = offer.segIndex || 0;
    const segCount = offer.segCount || 1;
    let segIsLast = typeof offer.isLast === 'boolean' ? offer.isLast : segIndex >= segCount - 1;
    this.lastSegSeen = segIsLast;
    this.segCount = Math.max(segCount, seg + 1);
    this.cb.onSegCount(this.segCount);
    if (segIndex !== seg) {
      this.cb.onStatus(`段序号错乱：期望第 ${seg + 1} 段，收到第 ${segIndex + 1} 段`);
      this.failRecv(`段序号错乱：期望第 ${seg + 1} 段，收到第 ${segIndex + 1} 段`); return false;
    }

    if (seg === 0) {
      this.cb.onFiles(offer.files);
      this.recvTotal = offer.files.reduce((s: number, f: any) => s + (f.size || 0), 0);
      this.recvTotalChunks = offer.files.reduce((s: number, f: any) => s + (f.size === 0 ? 0 : Math.ceil((f.size || 0) / LOCAL_CHUNK_SIZE)), 0);
      this.perFileChunks = offer.files.map((f: any) => (f.size === 0 ? 0 : Math.ceil((f.size || 0) / LOCAL_CHUNK_SIZE)));
      this.recvChunks = 0;
      this.manifest0 = offer.files.map((f: any) => ({ name: f.name, size: f.size }));
      try {
        const r = await makeSinks(offer.files, dirHandle);
        this.writers = r.writers; this.fallback = r.fallback;
      } catch (e: any) {
        this.cb.onStatus(`初始化接收失败: ${e?.message || e}`); this.failRecv(`初始化接收失败: ${e?.message || e}`); return false;
      }
      if (this.recvTotalChunks === 0) {
        this.cb.onStatus('接收完成（无文件）');
        if (this.ctrl.isOpen) { try { this.ctrl.send({ type: 'recv-done' }); } catch { /* ignore */ } }
        await this.finishRecv();
        return true;
      }
    } else {
      const same = this.manifest0 && this.manifest0.length === offer.files.length &&
        offer.files.every((f: any, i: number) => f.name === this.manifest0![i].name && f.size === this.manifest0![i].size);
      if (!same) { this.cb.onStatus('文件清单与第 1 段不一致，传输可能损坏'); this.failRecv('文件清单与第 1 段不一致，传输可能损坏'); return false; }
    }

    this.cb.onRecvReady(true);
    if (this.ctrl.isOpen) { try { this.ctrl.send({ type: 'recv-ready' }); } catch { /* ignore */ } }
    this.cb.onStatus(segIsLast && seg === 0
      ? '开始流式接收…'
      : `第 ${seg + 1} 段：开始流式接收…${segIsLast ? '（最后一段）' : ''}`);

    // 3. 读数据帧直到 EOF
    let frameCount = 0;
    while (true) {
      if (this.recvAborted) break;
      const payload = await this.fr.readMsg();
      if (!payload) break;
      if (payload[0] === 0x7b /* { */) {
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          if (msg && msg.type === 'segend') {
            segIsLast = !!msg.isLast;
            this.lastSegSeen = segIsLast;
            continue;
          }
        } catch { /* ignore */ }
      }
      if (payload.length < FRAME_HDR) { console.log(`[recv] 跳过过短帧(${payload.length}B，疑似开场帧)`); continue; }
      this.handleDataFrame(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer);
      frameCount++;
    }
    this.pendingDone = true;
    void this.drainWrites();
    if (!segIsLast) {
      try { this.ctrl.close(); } catch { /* ignore */ }
      this.ctrl = null;
    }
    return true;
  }

  /** 接收失败：回初始状态，通知 UI 与发送端，房间码/口令保留可改 */
  private failRecv(msg: string) {
    if (this.finishing) return;
    this.receiving = false;
    this.cb.onReceiving(false);
    this.cb.onFail?.(msg);
    // 通知发送端「我接收失败」，让对方恢复「开始发送」按钮重发
    if (this.ctrl?.isOpen) { try { this.ctrl.send({ type: 'recv-error', reason: msg }); } catch { /* ignore */ } }
    this.closeConn();
    this.resetReceiver();
  }

  private async finishRecv() {
    if (this.finishing) return;
    this.finishing = true;
    let allOk = true;
    for (let fi = 0; fi < this.writers.length; fi++) {
      const w = this.writers[fi];
      if (!w) { allOk = false; continue; }
      try { await w.close(); } catch { allOk = false; }
    }
    if (this.fallback) {
      this.cb.onStatus(allOk
        ? '接收完成，浏览器已触发下载（当前为不安全连接，已降级为整文件下载；大文件建议用 localhost/https 访问以获得流式写入）'
        : '接收完成（部分文件写入失败）');
    } else {
      this.cb.onStatus(allOk
        ? '接收完成，文件已流式保存到浏览器下载目录（如未自动弹出，请查看下载管理器）'
        : '接收完成（部分文件写入失败）');
    }
    // 完成态：通知 UI 进入「接收完成」态（保留文件清单展示），并通过 onReceiving(false) 解锁按钮
    this.receiving = false;
    this.cb.onReceiving(false);
    this.cb.onDone?.();
    this.writers = [];
  }

  /** (fi, ci) → 全局递增序号 */
  private frameSeq(fi: number, ci: number): number {
    let s = 0;
    for (let i = 0; i < fi; i++) s += this.perFileChunks[i] || 0;
    return s + ci;
  }

  /** 收到一帧的入口：立即并发解密，不阻塞后续帧 */
  private handleDataFrame(data: ArrayBuffer) {
    if (this.recvAborted) return;
    const frame = new Uint8Array(data);
    if (frame.length < FRAME_HDR) { this.cb.onStatus('收到过短的数据帧'); return; }
    const { fi, ci, plainLen, body } = decodeFrame(frame);
    if (fi >= this.writers.length) {
      console.warn(`[recv] 文件索引越界: fi=${fi}, max=${this.writers.length - 1}`);
      return;
    }
    const seq = this.frameSeq(fi, ci);
    const bodyBuf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    decryptChunkAsync(bodyBuf, this.key, plainLen)
      .then((plainBuf) => {
        if (this.recvAborted) return;
        this.recvReceived += (plainBuf as ArrayBuffer).byteLength;
        this.readyBuf.set(seq, { fi, plain: new Uint8Array(plainBuf) });
        void this.drainWrites();
      })
      .catch((e: any) => {
        console.error('[recv] 解密失败:', e);
        this.cb.onStatus(`数据帧错误: ${e?.message || e}`);
      });
  }

  /** 按全局写盘游标 + 每文件块数，推导每个文件的进度（0..1），回传给 UI 做逐文件进度 */
  private emitFileProgress() {
    if (!this.cb.onFileProgress) return;
    const cursor = this.nextWriteSeq; // 已写入的全局 chunk 数
    const progs: number[] = [];
    let start = 0;
    for (let i = 0; i < this.perFileChunks.length; i++) {
      const n = this.perFileChunks[i] || 0;
      const written = Math.max(0, Math.min(cursor - start, n));
      progs.push(n === 0 ? 1 : written / n);
      start += n;
    }
    this.cb.onFileProgress(progs);
  }

  /** 串行写盘协程：按全局序号顺序写入 */
  private async drainWrites() {
    if (this.drainRunning) return;
    this.drainRunning = true;
    try {
      while (this.readyBuf.has(this.nextWriteSeq)) {
        const item = this.readyBuf.get(this.nextWriteSeq)!;
        this.readyBuf.delete(this.nextWriteSeq);
        const w = this.writers[item.fi];
        if (w) { try { await w.write(item.plain); } catch { /* ignore */ } }
        this.recvBytes += item.plain.length;
        this.cb.onProgress(this.recvTotal ? this.recvBytes / this.recvTotal : 1);
        this.emitFileProgress();
        const _now = Date.now();
        if (this.ctrl?.isOpen && _now - this.lastProgressAt >= 50) {
          this.lastProgressAt = _now;
          try { this.ctrl.send({ type: 'progress', received: this.recvBytes, total: this.recvTotal }); } catch { /* ignore */ }
        }
        this.nextWriteSeq++;
      }
      if (this.recvTotalChunks > 0 && this.nextWriteSeq >= this.recvTotalChunks) {
        if (!this.recvDoneSent) {
          this.recvDoneSent = true;
          if (this.ctrl?.isOpen) { try { this.ctrl.send({ type: 'recv-done' }); } catch { /* ignore */ } }
        }
        await this.finishRecv();
      }
    } finally {
      this.drainRunning = false;
    }
  }
}
