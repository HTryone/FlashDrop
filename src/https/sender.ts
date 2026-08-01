// 本地直传——发送端状态机（HTTP 流式中继）。
// 从 SendPanel.vue 的「本地直传」段抽离为纯 TS 类；Vue 组件只实例化本类并通过回调更新 UI。
// 行为与原内联逻辑逐字节一致：帧协议、按时间切段、滑动窗口 + 并发池双闸门、段末 segend/close、断线重连。

import { encodeMsg, FRAME_HDR } from './frame';
import { resolveRelayBase, segRoom, genRoomCode, SEGMENT_TIME_MS, SEGMENT_MIN_BYTES } from './room';
import { RelayControl } from './control';
import { encryptChunkAsync } from '@/composables/useLocalCrypto';
import { deriveKey, LOCAL_SALT, LOCAL_CHUNK_SIZE, randomPassphrase } from '@/crypto/e2ee';

export interface SenderCallbacks {
  onStatus: (s: string) => void;
  onPeerOnline: (v: boolean) => void;
  onProgress: (p: number) => void; // 0..1
  onSegIndex: (i: number) => void;
  onSending: (v: boolean) => void;
  onDone: () => void;
  onRoom: (room: string, link: string, passphrase: string) => void;
}

interface SegCtx {
  seg: number;
  startIdx: number;
  chunkListAll: { fi: number; ci: number; plainLen: number }[];
  filesList: { file: File }[];
  total: number;
  keyHex: string;
}

const WINDOW = 24 * 1024 * 1024; // 在途上限 24MB：并发 3 路 × 4MB 分片 = 12MB 在途，留余量防死锁
const POST_LIMIT = 4 * 1024 * 1024;
const MAX_INFLIGHT = 3;
const SOFT_MIN = 1024 * 1024;

export class LocalSender {
  room = '';
  passphrase = '';
  link = '';
  private keyHex = '';

  private sending = false;
  private done = false;
  private peerOnline = false;
  private segIndex = 0;
  private abort: AbortController | null = null;
  private ctrl: RelayControl | null = null;

  // 端到端滑动窗口状态（控制通道 onmessage 与发送流 pull 共享）
  private ackBytes = 0;
  private sentBytes = 0;
  private ackWaiters: Array<() => void> = [];
  private notifyAckWaiters() {
    const ws = this.ackWaiters;
    this.ackWaiters = [];
    for (const w of ws) { try { w(); } catch { /* ignore */ } }
  }

  // 接收端「创建下载」闸门：接收端建好下载流后才允许发数据帧
  private recvReady = false;
  private recvReadyResolve: (() => void) | null = null;
  private recvReadyPromise: Promise<void> = Promise.resolve();
  private armRecvReady() {
    if (this.recvReady) return;
    this.recvReadyPromise = new Promise<void>((res) => { this.recvReadyResolve = res; });
  }

  constructor(private cb: SenderCallbacks) {}

  // ============ 房间 / 链接 ============
  genRoom() {
    this.close();
    this.resetWindow();
    this.peerOnline = false;
    this.segIndex = 0;
    this.cb.onPeerOnline(false);
    this.cb.onSegIndex(0);
    const s = genRoomCode();
    const pass = randomPassphrase();
    this.room = s;
    this.passphrase = pass;
    this.recvReady = false;
    this.segIndex = 0;
    this.link = `${location.origin}/?tab=local&room=${s}#k=${pass}`;
    this.cb.onStatus('房间已生成，等待对方加入…');
    this.cb.onRoom(s, this.link, pass);
  }

  private resetWindow() {
    this.ackBytes = 0;
    this.sentBytes = 0;
    this.ackWaiters = [];
    this.recvReady = false;
    this.recvReadyResolve = null;
    this.recvReadyPromise = Promise.resolve();
  }

  // ============ 取消 / 关闭 ============
  cancel() {
    if (!this.sending) return;
    if (this.abort) { try { this.abort.abort(); } catch { /* ignore */ } }
    this.cb.onStatus('已取消发送，可重新传输');
    this.setSending(false);
    this.close();
  }

  close() {
    if (this.abort) { try { this.abort.abort(); } catch { /* ignore */ } this.abort = null; }
    if (this.ctrl) { this.ctrl.close(); this.ctrl = null; }
  }

  private setSending(v: boolean) {
    this.sending = v;
    this.cb.onSending(v);
  }
  private setDone(v: boolean) {
    this.done = v;
    if (v) this.cb.onDone();
  }

  // ============ chunk 清单 ============
  private buildChunkList(filesList: { file: File }[]) {
    const list: { fi: number; ci: number; plainLen: number }[] = [];
    let total = 0;
    for (let fi = 0; fi < filesList.length; fi++) {
      const size = filesList[fi].file.size;
      const n = size === 0 ? 0 : Math.ceil(size / LOCAL_CHUNK_SIZE);
      for (let ci = 0; ci < n; ci++) {
        const plainLen = Math.min(LOCAL_CHUNK_SIZE, size - ci * LOCAL_CHUNK_SIZE);
        list.push({ fi, ci, plainLen });
        total += plainLen;
      }
    }
    return { list, total };
  }

  // ============ 启动 ============
  async startSend(files: { file: File }[]) {
    if (!this.room || !this.passphrase) { this.cb.onStatus('请先生成房间'); return; }
    if (!files.length) { this.cb.onStatus('没有待发送文件'); return; }
    let keyHex: string;
    try { keyHex = await deriveKey(this.passphrase, LOCAL_SALT); }
    catch (e: any) { this.cb.onStatus(`密钥派生失败: ${e?.message || e}`); return; }
    this.keyHex = keyHex;

    const { list: chunkListAll, total } = this.buildChunkList(files);
    this.setSending(true);
    this.cb.onProgress(0);
    this.setDone(false);
    this.cb.onStatus('正在建立控制通道…');
    this.abort = new AbortController();

    try {
      let startIdx = 0;
      let seg = 0;
      while (startIdx < chunkListAll.length) {
        if (this.abort!.signal.aborted) break;
        this.segIndex = seg;
        this.cb.onSegIndex(seg);
        const r = await this.transferSegment({ seg, startIdx, chunkListAll, filesList: files, total, keyHex });
        startIdx = r.sentUpTo;
        seg++;
      }
      if (!this.abort!.signal.aborted) {
        this.cb.onStatus('文件已发送，等待对方接收完成…');
        setTimeout(() => {
          if (!this.done && this.sending) {
            this.setDone(true);
            this.cb.onProgress(1);
            this.setSending(false);
            this.close();
          }
        }, 30000);
      }
    } catch (e: any) {
      if (this.abort?.signal.aborted) this.cb.onStatus('已取消发送');
      else this.cb.onStatus(`传输出错: ${e?.message || e}`);
      this.setSending(false);
      this.close();
    } finally {
      if (this.abort?.signal.aborted) this.setSending(false);
    }
  }

  // ============ 单段传输 ============
  private async transferSegment(ctx: SegCtx): Promise<{ sentUpTo: number; isLast: boolean }> {
    const { seg, startIdx, chunkListAll, filesList, total, keyHex } = ctx;
    const room = segRoom(this.room, seg);
    const base = resolveRelayBase();

    let segOffset = 0;
    for (let k = 0; k < startIdx; k++) segOffset += chunkListAll[k].plainLen;
    const segStartTime = Date.now();

    this.cb.onStatus(`正在传输第 ${seg + 1} 段…`);

    // 每段独立滑动窗口 + 接收端就绪闸门（防上一段残留导致闸门误判）
    this.ackBytes = 0; this.sentBytes = 0; this.ackWaiters = [];
    this.recvReady = false;
    this.armRecvReady();

    let segTimeUp = false;
    let segBytes = 0;
    let producedUpTo = startIdx;
    let segClosed = false;

    const handleCtrlMsg = (data: any) => {
      if (data.type === 'ready') {
        this.peerOnline = true; this.cb.onPeerOnline(true);
        this.cb.onStatus('对方已在线，可开始传输');
      } else if (data.type === 'pull' || data.type === 'recv-ready') {
        this.recvReady = true; this.recvReadyResolve?.(); this.recvReadyResolve = null;
      } else if (data.type === 'progress') {
        const t = data.total || 1;
        this.cb.onProgress(Math.min(1, (data.received || 0) / t));
        this.ackBytes = Math.max(0, (data.received || 0) - segOffset);
        this.notifyAckWaiters();
      } else if (data.type === 'recv-done' && !this.done) {
        this.setDone(true);
        this.cb.onProgress(1);
        this.setSending(false);
        this.cb.onStatus('传输完成');
        this.close();
      }
    };

    const ctrl = new RelayControl({
      base, room, role: 'sender', onMessage: handleCtrlMsg,
      reconnect: true, reconnectDelay: 1000,
      shouldReconnect: () => !segClosed && !this.done && !this.abort?.signal.aborted,
    });
    this.ctrl = ctrl;
    const self = this;
    await ctrl.connect();

    // 先发 offer，再等就绪
    const offerP = postOfferSeg();
    offerP.catch(() => {});
    this.cb.onStatus(seg === 0
      ? '等待对方点「连接接收」…（链接已生成，可先发给对方）'
      : `第 ${seg + 1} 段：等待对方就绪…`);

    // recvReady 活性重试：relay 偶发未补发 pull 会让发送端永久等待首帧。每 15s 未就绪则断开
    // ctrl 重连 → relay 重补 pull，最多 8 次（~2min）。
    let attempts = 0;
    const RECV_RETRY = 8;
    const RECV_WAIT = 15_000;
    while (true) {
      try {
        await Promise.race([
          this.recvReadyPromise,
          new Promise<void>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), RECV_WAIT)),
        ]);
        break;
      } catch {
        attempts++;
        if (attempts >= RECV_RETRY) {
          this.cb.onStatus(`无法开始传输：对方未开始接收（重试 ${RECV_RETRY} 次仍超时）。请确认对方已点「连接接收」且页面未关闭。`);
          this.setSending(false);
          segClosed = true;
          try { ctrl.close(); } catch { /* ignore */ }
          throw new Error(`第 ${seg + 1} 段：对方未开始接收（${RECV_RETRY} 次重试超时）`);
        }
        try { ctrl.close(); } catch { /* ignore */ }
        this.armRecvReady();
        postOfferSeg().catch(() => {});
      }
    }
    await offerP;
    this.cb.onStatus(`第 ${seg + 1} 段：开始传输数据…`);

    // ---- 生产者：本段 chunk 加密入队 ----
    let pending: Uint8Array[] = [];
    let producerDone = false;
    let waiters: Array<() => void> = [];
    const frameGate: { resolve: (() => void) | null; reject: ((e: any) => void) | null } = { resolve: null, reject: null };
    const pushFrame = (f: Uint8Array) => {
      const wasEmpty = pending.length === 0;
      pending.push(f);
      if (wasEmpty && frameGate.resolve) frameGate.resolve();
      const w = waiters.shift(); if (w) w();
    };
    const notifyDrain = () => { const w = waiters.shift(); if (w) w(); };
    const notifyAllDrain = () => { const ws = waiters; waiters = []; for (const w of ws) { try { w(); } catch { /* ignore */ } } };
    const waitFrame = async (): Promise<void> => {
      if (pending.length > 0) return;
      await new Promise<void>((res) => {
        let fired = false;
        const once = () => { if (fired) return; fired = true; res(); };
        waiters.push(once);
        setTimeout(once, 500);
      });
    };

    const postOneChunk = async (seed: Uint8Array): Promise<boolean> => {
      const parts: Uint8Array[] = [seed];
      let bytes = seed.length;
      while (bytes < POST_LIMIT) {
        if (pending.length > 0) {
          const f = pending.shift()!; notifyDrain();
          parts.push(f); bytes += f.length;
          continue;
        }
        if (producerDone) break;
        if (bytes >= SOFT_MIN) break;
        await waitFrame();
      }
      const body = new Uint8Array(bytes);
      { let off = 0; for (const p of parts) { body.set(p, off); off += p.length; } }
      this.sentBytes += bytes;

      let lastErr: any = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (this.abort?.signal.aborted) throw new Error('已取消');
        try {
          const resp = await fetch(`${base}/stream/${room}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: body as unknown as BodyInit, signal: this.abort!.signal,
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          if (attempt > 0) this.cb.onStatus(`第 ${seg + 1} 段：重试成功，继续传输…`);
          return !(producerDone && pending.length === 0);
        } catch (e: any) {
          if (this.abort?.signal.aborted) throw e;
          lastErr = e;
          this.cb.onStatus(`第 ${seg + 1} 段：网络抖动，正在重发分片（第 ${attempt + 1}/4 次）…`);
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        }
      }
      throw new Error(`第 ${seg + 1} 段上传失败（已重试 4 次）: ${lastErr?.message || lastErr}`);
    };

    async function postOfferSeg(): Promise<void> {
      const offerJson = JSON.stringify({
        type: 'offer',
        files: filesList.map((f) => ({ name: f.file.name, size: f.file.size })),
        segIndex: seg, segCount: 0, isLast: false,
      });
      const offerFrame = encodeMsg(new TextEncoder().encode(offerJson));
      let lastErr: any = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (self.abort?.signal.aborted) throw new Error('已取消');
        try {
          const resp = await fetch(`${base}/stream/${room}`, {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
            body: offerFrame as unknown as BodyInit, signal: self.abort!.signal,
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return;
        } catch (e: any) {
          if (self.abort?.signal.aborted) throw e;
          lastErr = e;
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        }
      }
      throw new Error(`第 ${seg + 1} 段上传 offer 失败: ${lastErr?.message || lastErr}`);
    };

    const postSegendFrame = async (realIsLast: boolean): Promise<void> => {
      const segendJson = JSON.stringify({ type: 'segend', isLast: realIsLast });
      const frame = encodeMsg(new TextEncoder().encode(segendJson));
      let lastErr: any = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (this.abort?.signal.aborted) throw new Error('已取消');
        try {
          const resp = await fetch(`${base}/stream/${room}`, {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
            body: frame as unknown as BodyInit, signal: this.abort!.signal,
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return;
        } catch (e: any) {
          if (this.abort?.signal.aborted) throw e;
          lastErr = e;
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        }
      }
      throw new Error(`第 ${seg + 1} 段上传 segend 失败: ${lastErr?.message || lastErr}`);
    };

    const sendCloseSeg = async (): Promise<void> => {
      try {
        await fetch(`${base}/stream/${room}/close`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(0), signal: this.abort!.signal,
        });
      } catch (e: any) {
        if (this.abort?.signal.aborted) throw e;
        console.warn(`第 ${seg + 1} 段关闭流提示失败（数据已送达，relay 会超时回收）: ${e?.message || e}`);
      }
    };

    if (startIdx < chunkListAll.length) {
      const producer = (async () => {
        try {
          for (let i = startIdx; i < chunkListAll.length; i++) {
            const c = chunkListAll[i];
            const file = filesList[c.fi].file;
            const offset = c.ci * LOCAL_CHUNK_SIZE;
            const chunkBuf = await file.slice(offset, offset + c.plainLen).arrayBuffer();
            const enc = new Uint8Array(await encryptChunkAsync(chunkBuf, keyHex));
            const frame = new Uint8Array(FRAME_HDR + enc.length);
            const dv = new DataView(frame.buffer);
            dv.setUint16(0, c.fi); dv.setUint32(2, c.ci); dv.setUint32(6, c.plainLen);
            frame.set(enc, FRAME_HDR);
            pushFrame(encodeMsg(frame));
            segBytes += c.plainLen;
            producedUpTo = i + 1;
            while (pending.length > 300) {
              await new Promise<void>((r) => {
                let fired = false;
                const once = () => { if (fired) return; fired = true; r(); };
                waiters.push(once);
                setTimeout(once, 500);
              });
            }
            if (i + 1 < chunkListAll.length
                && (Date.now() - segStartTime) >= SEGMENT_TIME_MS
                && segBytes >= SEGMENT_MIN_BYTES) {
              segTimeUp = true;
              break;
            }
          }
          producerDone = true; notifyAllDrain();
        } catch (e: any) {
          if (frameGate.reject) frameGate.reject(e);
          throw e;
        }
      })();
      await new Promise<void>((res, rej) => { frameGate.resolve = res; frameGate.reject = rej; });
      frameGate.reject = null;

      // 消费者：并发池发起分片流式 POST（深流水线），窗口 + 并发数双闸门
      let inflightWaiters: Array<() => void> = [];
      const wakeInflight = () => { const ws = inflightWaiters; inflightWaiters = []; for (const w of ws) { try { w(); } catch { /* ignore */ } } };
      let inflightCount = 0;
      const pumpPool = async () => {
        const active = new Set<Promise<unknown>>();
        const tryLaunch = (): boolean => {
          if (inflightCount >= MAX_INFLIGHT) return false;
          if ((this.sentBytes - this.ackBytes) >= WINDOW) return false;
          if (pending.length === 0) return false;
          const seed = pending.shift()!; notifyDrain();
          inflightCount++;
          const p = postOneChunk(seed).catch((e) => { throw e; })
            .finally(() => { inflightCount--; wakeInflight(); });
          active.add(p);
          p.finally(() => active.delete(p));
          return true;
        };
        for (;;) {
          let launched = false;
          while (tryLaunch()) launched = true;
          if (!launched) {
            if (inflightCount === 0 && producerDone && pending.length === 0) break;
            await new Promise<void>((res) => {
              let fired = false;
              const once = () => { if (fired) return; fired = true; res(); };
              this.ackWaiters.push(once); inflightWaiters.push(once);
              setTimeout(once, 1000);
            });
          }
        }
        await Promise.all([...active]);
      };
      await pumpPool();
      await producer;
    }

    const realIsLast = !segTimeUp;
    try { await postSegendFrame(realIsLast); }
    catch (e: any) { console.warn(`第 ${seg + 1} 段 segend 发送失败（接收端将按 EOF 判定）: ${e?.message || e}`); }
    await sendCloseSeg();
    segClosed = true;
    if (!realIsLast) { try { ctrl.close(); } catch { /* ignore */ } }
    return { sentUpTo: producedUpTo, isLast: realIsLast };
  }
}
