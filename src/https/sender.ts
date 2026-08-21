// 本地直传——发送端状态机（HTTP 流式中继）。
// 从 SendPanel.vue 的「本地直传」段抽离为纯 TS 类；Vue 组件只实例化本类并通过回调更新 UI。
// 行为与原内联逻辑逐字节一致：帧协议、按时间切段、滑动窗口 + 并发池双闸门、段末 segend/close、断线重连。

import { encodeMsg, FRAME_HDR } from './frame';
import { resolveRelayBase, genRoomCode } from '@/transfer/room';
import { segRoom, SEGMENT_TIME_MS, SEGMENT_MIN_BYTES } from './segment';
import { RelayControl } from './control';
import { encryptChunkAsync } from '@/https/useLocalCrypto';
import { deriveKey, LOCAL_SALT, LOCAL_CHUNK_SIZE, randomPassphrase } from '@/crypto/e2ee';
import { info, error, warn } from '@/diagnostics/logger';

export interface SenderCallbacks {
  onStatus: (s: string) => void;
  onPeerOnline: (v: boolean) => void;
  onProgress: (p: number) => void; // 0..1
  onSegIndex: (i: number) => void;
  onSending: (v: boolean) => void;
  onTransferring?: (v: boolean) => void;
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
  private dataStarted = false; // 是否已真正开始推数据，用于精确驱动「传输中」状态（区别于 setSending 的流程级标记）
  private abort: AbortController | null = null;
  private ctrl: RelayControl | null = null;
  // 在场侦听 WS：genRoom 即开，早于「开始传输」。仅用于接收端加入时点亮 peerOnline 灯，
  // 不承载数据传输门控（门控由 transferSegment 内的 this.ctrl 负责）。
  // 修复「接收端先点连接接收，发送端灯要等到点开始传输才亮」——那时才建连导致早先的 ready/peer-joined 通知无人接收。
  private presenceCtrl: RelayControl | null = null;
  private remoteAborted = false; // 对方（接收端）取消，区别于本地取消
  private remoteFailed = false;  // 对方（接收端）接收失败，区别于取消
  private currentSegRoom = '';   // 当前段对应的 relay 房间（含段号），供 closeStream 关流
  private streamClosed = false;  // 当前段流是否已 POST /close，防重复关闭

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
    info('https', 'sender', `生成本地直传房间 ${s}`, { room: s });
    this.cb.onStatus('房间已生成，等待对方加入…');
    this.cb.onRoom(s, this.link, pass);
    this.armPresence(); // 提前开在场侦听 WS，接收端一加入即点亮「对方在线」灯
  }

  // 提前开在场侦听 WS（genRoom 时调用）：只监听 ready/peer-joined/recv-ready 以点亮 peerOnline，
  // 不处理进度/recv-done（那些由 transferSegment 的 this.ctrl 负责）。
  // 关键：必须连「段房间 segRoom(this.room,0)」——接收端 recvSegment 连的正是这个房间
  // （receiver.ts:174 = segRoom(this.room,0)），relay 的 peer-joined/recv-ready 按房间隔离转发
  // （relay.js:281-318）。此前错连基础房间 this.room，与接收端不在同一房间，永远收不到对方加入，
  // 导致「生成房间即亮灯」失效、灯要等到点开始传输（this.ctrl 连段房间）才亮。
  // relay 的 wsSender 单槽：本 WS 先连即占用段房间 wsSender；startSend 一开始传输即关闭本 WS
  // （见 startSend 内 presenceCtrl.close()），把 wsSender 单槽让给 this.ctrl，避免两者争夺导致
  // 进度/recv-done 被误转给闲连而卡死。
  private armPresence() {
    if (this.presenceCtrl) return;
    const base = resolveRelayBase();
    this.presenceCtrl = new RelayControl({
      base, room: segRoom(this.room, 0), role: 'sender',
      onMessage: (d: any) => {
        if (!d) return;
        if (d.type === 'ready' || d.type === 'peer-joined' || d.type === 'recv-ready') {
          if (!this.peerOnline) { this.peerOnline = true; this.cb.onPeerOnline(true); }
        }
      },
      reconnect: true, reconnectDelay: 1000,
      shouldReconnect: () => !this.done,
    });
    this.presenceCtrl.connect();
  }

  private resetWindow() {
    this.ackBytes = 0;
    this.sentBytes = 0;
    this.ackWaiters = [];
    this.recvReady = false;
    this.recvReadyResolve = null;
    this.recvReadyPromise = Promise.resolve();
    this.streamClosed = false;
    this.currentSegRoom = '';
  }

  // ============ 取消 / 关闭 ============
  cancel() {
    if (!this.sending) return;
    info('https', 'sender', `已取消本地直传`, { room: this.room });
    // 先通知接收端"我取消了"，再延迟中止，确保控制消息先经 WS 发出
    if (this.ctrl?.isOpen) { try { this.ctrl.send({ type: 'cancel' }); } catch { /* ignore */ } }
    setTimeout(() => {
      if (this.abort) { try { this.abort.abort(); } catch { /* ignore */ } }
      this.close();
    }, 250);
    this.cb.onStatus('已取消发送，可重新传输');
    this.setSending(false);
  }

  close() {
    // 注意：不在此处置空/abort this.abort。置空会使 pump 的 this.abort?.signal.aborted 检测失效、
    // 在途 fetch 因 this.abort!.signal 空引用抛错被误判为「网络抖动」重试，并覆盖取消状态。
    // 中止由调用方（handleCtrlMsg 的 cancel 分支 / cancel()）显式触发。
    if (this.ctrl) { this.ctrl.close(); this.ctrl = null; }
    if (this.presenceCtrl) { this.presenceCtrl.close(); this.presenceCtrl = null; }
  }

  // 关闭当前段在 relay 上的可读流（POST /close）。
  // 关键：最后段不在发完数据后立刻调用，而是等接收端回 recv-done 后再调，
  // 避免 relay 在尾帧尚未被 GET 消费时即 controller.close() 截断，导致接收端差一帧卡 99%。
  // 幂等：streamClosed 守卫，重复调用（recv-done + 超时兜底）只关一次。
  private async closeStream(): Promise<void> {
    if (this.streamClosed) return;
    this.streamClosed = true;
    if (!this.currentSegRoom) return;
    try {
      await fetch(`${resolveRelayBase()}/stream/${this.currentSegRoom}/close`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(0), signal: this.abort?.signal,
      });
    } catch (e: any) {
      if (this.abort?.signal.aborted) return;
      warn('https', 'sender', `关闭流提示失败`, { error: String(e) });
      console.warn(`关闭流提示失败（数据已送达，relay 会超时回收）: ${e?.message || e}`);
    }
  }

  private setSending(v: boolean) {
    this.sending = v;
    this.cb.onSending(v);
    if (!v) { this.dataStarted = false; this.cb.onTransferring?.(false); }
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
    info('https', 'sender', `开始本地直传: 文件数=${files.length}, 总字节=${total}`, { total });
    // 在场侦听 WS 已完成使命：接收端若已在 genRoom 阶段加入，灯已点亮；若尚未加入，
    // 后续由 transferSegment 的 this.ctrl 在收到 peer-joined 时点亮（handleCtrlMsg 已认 peer-joined）。
    // 此处关闭，把段房间 wsSender 单槽让给 this.ctrl，避免两 WS 争夺导致进度/recv-done 被误转。
    if (this.presenceCtrl) { this.presenceCtrl.close(); this.presenceCtrl = null; }
    this.cb.onProgress(0);
    this.setDone(false);
    this.cb.onStatus('正在建立控制通道…');
    this.abort = new AbortController();
    this.remoteAborted = false;
    this.remoteFailed = false;

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
            void this.closeStream(); // 兜底：接收端未回 recv-done（如崩溃）时关闭流，避免悬挂
          }
        }, 30000);
      }
    } catch (e: any) {
      if (this.remoteFailed) this.cb.onStatus('对方接收失败，请重新点「开始传输」重发');
      else if (this.remoteAborted) this.cb.onStatus('对方已取消接收');
      else if (this.abort?.signal.aborted) this.cb.onStatus('已取消发送');
      else { this.cb.onStatus(`传输出错: ${e?.message || e}`); error('https', 'sender', `本地直传异常: ${e?.message || e}`, { room: this.room }); }
      this.setSending(false);
      this.close();
      void this.closeStream();
    } finally {
      if (this.abort?.signal.aborted) this.setSending(false);
    }
  }

  // ============ 单段传输 ============
  private async transferSegment(ctx: SegCtx): Promise<{ sentUpTo: number; isLast: boolean }> {
    const { seg, startIdx, chunkListAll, filesList, total, keyHex } = ctx;
    const room = segRoom(this.room, seg);
    this.currentSegRoom = room;
    this.streamClosed = false;
    const base = resolveRelayBase();

    let segOffset = 0;
    for (let k = 0; k < startIdx; k++) segOffset += chunkListAll[k].plainLen;
    const segStartTime = Date.now();

    this.cb.onStatus(`正在传输第 ${seg + 1} 段…`);
    info('https', 'sender', `开始传输第 ${seg + 1} 段 (${room})`, { seg, room });

    // 每段独立滑动窗口 + 接收端就绪闸门（防上一段残留导致闸门误判）
    this.ackBytes = 0; this.sentBytes = 0; this.ackWaiters = [];
    this.recvReady = false;
    this.armRecvReady();

    let segTimeUp = false;
    let segBytes = 0;
    let producedUpTo = startIdx;
    let segClosed = false;

    const handleCtrlMsg = (data: any) => {
      if (data.type === 'ready' || data.type === 'peer-joined' || data.type === 'recv-ready') {
        if (!this.peerOnline) { this.peerOnline = true; this.cb.onPeerOnline(true); }
        if (data.type === 'ready') this.cb.onStatus('对方已在线，可开始传输');
      }
      if (data.type === 'pull' || data.type === 'recv-ready') {
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
        void this.closeStream(); // 接收端已收齐 → 关流，relay EOF 触发接收端退出读循环
      } else if (data.type === 'cancel') {
        this.remoteAborted = true;
        this.abort?.abort();
        this.cb.onStatus('对方已取消接收');
        this.setSending(false);
        this.close();
      } else if (data.type === 'recv-error') {
        // 接收端接收失败：中止本段、恢复「开始发送」按钮，等待对方重发
        this.remoteAborted = true;
        this.remoteFailed = true;
        this.abort?.abort();
        this.cb.onStatus(`对方接收失败：${data.reason || '未知原因'}，请重新点「开始传输」重发`);
        this.setSending(false);
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

    // 就绪闸门：
    //  · 第 1 段必须真等 —— 接收端要人工点「连接接收」，可能等很久。保留 15s×8 活性重试
    //    （relay 偶发未补发 pull → 断开 ctrl 重连让 relay 重补）。
    //  · 第 2 段起不等任何信号 —— pull 是边沿信号，切段瞬间 WS 与 GET 的建立时序错开就会
    //    永久丢失，实测因此死锁 58s。而 relay 允许「先推后拉」：POST 时房间不存在会自动
    //    createRoom（relay.js:197），房间自带 8MB 缓冲（relay.js:372），GET 首次连上时
    //    readable 未 locked 故复用同一房间、缓冲数据一字节不丢（relay.js:139）。缓冲满则
    //    POST 挂 pullWaiters 等 GET 唤醒（STALL_MS 70s 容忍窗，实测接收端 1~2s 即到）。
    //    所以这里只给 3s 让接收端从容跟上，超时照样开推，不再依赖信号必达。
    if (seg === 0) {
      let attempts = 0;
      const RECV_RETRY = 8;
      const RECV_WAIT = 15_000;
      while (true) {
        const r: { reason: 'ready' | 'cancel' | 'timeout' } = { reason: 'ready' };
        try {
          await Promise.race([
            this.recvReadyPromise.then(() => { r.reason = 'ready'; }),
            new Promise<void>((res) => {
              const h = () => { r.reason = 'cancel'; res(); };
              this.abort!.signal.addEventListener('abort', h, { once: true });
            }),
            new Promise<void>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), RECV_WAIT)),
          ]);
        } catch {
          r.reason = 'timeout';
        }
        if (r.reason === 'cancel') {
          this.cb.onStatus('已取消发送');
          this.setSending(false);
          segClosed = true;
          try { ctrl.close(); } catch { /* ignore */ }
          throw new Error('已取消');
        }
        if (r.reason === 'ready') break;
        // timeout：重试
        attempts++;
        if (attempts >= RECV_RETRY) {
          this.cb.onStatus(`无法开始传输：对方未开始接收（重试 ${RECV_RETRY} 次仍超时）。请确认对方已点「连接接收」且页面未关闭。`);
          this.setSending(false);
          segClosed = true;
          try { ctrl.close(); } catch { /* ignore */ }
          throw new Error(`第 ${seg + 1} 段：对方未开始接收（${RECV_RETRY} 次重试超时）`);
        }
        try { ctrl.nudgeReconnect(); } catch { /* ignore */ } // 关 WS 触发 onclose 自动重连（勿用 close() 永久阻断）
        this.armRecvReady();
        postOfferSeg().catch(() => {});
      }
    } else {
      const r: { reason: 'ready' | 'cancel' | 'timeout' } = { reason: 'ready' };
      try {
        await Promise.race([
          this.recvReadyPromise.then(() => { r.reason = 'ready'; }),
          new Promise<void>((res) => {
            const h = () => { r.reason = 'cancel'; res(); };
            this.abort!.signal.addEventListener('abort', h, { once: true });
          }),
          new Promise<void>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 3_000)),
        ]);
      } catch {
        r.reason = 'timeout';
      }
      if (r.reason === 'cancel') {
        this.cb.onStatus('已取消发送');
        this.setSending(false);
        segClosed = true;
        try { ctrl.close(); } catch { /* ignore */ }
        throw new Error('已取消');
      }
      // ready 或超时都继续开推
    }
    await offerP;
    this.cb.onStatus(`第 ${seg + 1} 段：开始传输数据…`);
    // 首次真正开始推数据：驱动「传输中」状态（区别于 setSending 的点发送即 true）
    if (!this.dataStarted) { this.dataStarted = true; this.cb.onTransferring?.(true); }

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
    catch (e: any) { warn('https', 'sender', `第${seg + 1}段 segend 发送失败`, { seg: seg + 1, error: String(e) }); console.warn(`第 ${seg + 1} 段 segend 发送失败（接收端将按 EOF 判定）: ${e?.message || e}`); }
    if (!realIsLast) {
      // 中间段：发完即关流（EOF 推进段号），与原逻辑一致
      await this.closeStream();
      segClosed = true;
      try { ctrl.close(); } catch { /* ignore */ }
    } else {
      // 最后段：不主动关流。等接收端收齐回 recv-done 后由 handleCtrlMsg 调 closeStream 关流，
      // 避免 relay /close 截断尾帧导致接收端差一帧卡 99%。超时兜底见 startSend 的 30s 定时器。
    }
    return { sentUpTo: producedUpTo, isLast: realIsLast };
  }
}
