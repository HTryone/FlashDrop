<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import {
  deriveKey,
  LOCAL_SALT, LOCAL_CHUNK_SIZE,
} from '@/crypto/e2ee';
import { decryptChunkAsync } from '@/composables/useLocalCrypto';

// 由父组件（发送/接收面板）指定渲染哪一侧；不传则两侧都渲染
const props = defineProps<{ side?: 'send' | 'receive' }>();

// ---------- 常量 ----------
const CHUNK = LOCAL_CHUNK_SIZE;
const FRAME_HDR = 12;
const RELAY_DEFAULT = 'flashdrop-relay.315461.xyz';
function resolveRelayBase() {
  const host = (import.meta as any).env?.VITE_RELAY_URL || RELAY_DEFAULT;
  return `https://${host}`;
}

// ---------- 工具 ----------
function fmt(n: number) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// ================================================================
//  接收端「写入落盘」抽象：安全上下文用 StreamSaver 流式写盘（不爆内存），
//  非安全上下文（手机经 http 局域网访问）Service Worker 不可用 → 降级为浏览器 Blob 下载。
// ================================================================
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
  // 等 SW active（register 可能还在 install/activate）
  try { await navigator.serviceWorker.ready; } catch { /* ignore */ }
  if (navigator.serviceWorker.controller) return;
  // 等待 activate 中的 clients.claim() 触发 controllerchange（sw.js 已 clients.claim()）
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

class StreamSink {
  private w: any;
  constructor(w: any) { this.w = w; }
  write(p: Uint8Array) { return this.w.write(p); }
  async close() { await this.w.close(); }
  abort() { try { this.w.abort(); } catch { /* ignore */ } }
}
class BlobSink {
  private chunks: Uint8Array[] = [];
  private name: string;
  constructor(name: string) { this.name = name; }
  write(p: Uint8Array) { this.chunks.push(p); return Promise.resolve(); }
  async close() {
    const blob = new Blob(this.chunks as any);
    triggerDownload(blob, this.name);
    this.chunks = [];
  }
  abort() { this.chunks = []; }
}

// Chromium 专用：File System Access API 直接流式落盘，无需 SW / iframe / MessageChannel。
// StreamSaver 的 mitm iframe 在装了扩展的 Chrome 上结构性不可靠（扩展消息污染 → "didn't send a messageChannel" 崩溃），
// 我们的环境正是如此，故 Chromium 优先走此路径，从根上消除该崩溃。
class FSAccessSink {
  private handle: any;
  private writable: any = null;
  constructor(handle: any) { this.handle = handle; }
  async write(p: Uint8Array) {
    // getFileHandle() 返回 Promise，必须先 await 拿到真实句柄再 createWritable
    const h = await this.handle;
    if (!this.writable) this.writable = await h.createWritable();
    await this.writable.write(p);
  }
  async close() {
    if (this.writable) { await this.writable.close(); this.writable = null; }
  }
  abort() { try { this.writable?.abort(); } catch { /* ignore */ } }
}

// 必须在用户手势内调用（连接接收按钮触发），拿到目录句柄；非 Chromium 返回 null 走 StreamSaver 兜底。
async function pickSaveDir(): Promise<any | null> {
  const w = window as any;
  if (typeof w.showDirectoryPicker !== 'function') return null;
  try {
    const dir = await w.showDirectoryPicker();
    console.log('[recv] showDirectoryPicker ok');
    return dir;
  } catch (e: any) {
    // 用户取消(Esc)或拒绝授权 → 上层据此放弃本次接收
    // 其他错误也包成 __cancelled，但打印出来便于诊断
    console.log('[recv] showDirectoryPicker error:', e?.name, e?.message);
    return { __cancelled: true, __error: e?.name || String(e) };
  }
}

let recvFallback = false;
async function makeSinks(files: any[], dirHandle?: any) {
  writers = [];
  recvFallback = false;
  // 优先：Chromium File System Access API（直写磁盘，无 SW/iframe，扩展无从干扰）
  if (dirHandle && !(dirHandle as any).__cancelled) {
    try {
      writers = files.map((f: any) => {
        const safeName = String(f.name).replace(/[\\/]/g, '_');
        return new FSAccessSink(dirHandle.getFileHandle(safeName, { create: true }));
      });
      return;
    } catch (e: any) {
      writers = [];
      // 落盘句柄异常 → 退回 StreamSaver 兜底
    }
  }
  let ss: any = null;
  if (isSecureContextForSW()) {
    try {
      await ensureSWControlled();   // 让 SW 接管页面 → StreamSaver 走直连通道，避开脆弱的 mitm iframe
      ss = await ensureStreamSaver();
    } catch (e: any) {
      ss = null;
    }
  }
  if (ss && ss.supported !== false) {
    try {
      writers = files.map((f: any) => new StreamSink(ss.createWriteStream(f.name, { size: f.size || undefined }).getWriter()));
      return;
    } catch (e: any) {
      // fallthrough to Blob
    }
  }
  recvFallback = true;
  writers = files.map((f: any) => new BlobSink(f.name));
}

// ================================================================
//  接收方状态
// ================================================================
const recvRoom = ref(new URLSearchParams(location.search).get('room') || '');
const recvPass = ref(new URLSearchParams(location.hash.slice(1)).get('k') || '');
const recvLinkInput = ref('');
const receiving = ref(false);
const recvReady = ref(false);
const senderOnline = ref(false);
const recvFiles = ref<{ name: string; size: number }[]>([]);
const recvProgress = ref(0);
const recvStatus = ref('输入房间码（或粘贴整条链接）后点连接');
let writers: any[] = [];
let recvBytes = 0;
let recvTotal = 0;
let recvChunks = 0;
let recvTotalChunks = 0;
let recvKey = '';
let finishing = false;
let recvAborted = false;
let recvAbort: AbortController | null = null;
let recvWs: WebSocket | null = null;
let recvWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
// 并发解密 + 保序写盘
let perFileChunks: number[] = [];
let nextWriteSeq = 0;
const readyBuf = new Map<number, { fi: number; plain: Uint8Array }>();
let drainRunning = false;
let pendingDone = false;
  let recvReceived = 0;
let lastProgressAt = 0;     // 进度回传节流时间戳
let recvDoneSent = false;   // recv-done 是否已发送给发送端（防重复）
let manifest0: { name: string; size: number }[] | null = null; // 第 1 段文件清单（后续段校验一致性）
const recvSegCount = ref(1);                                    // 总段数（第 1 段 offer 中获知）
function segRoomRecv(i: number): string { return `${recvRoom.value}-s${i}`; } // 段房间码

function resetReceiver() {
  receiving.value = false;
  recvReady.value = false;
  senderOnline.value = false;
  recvFiles.value = [];
  recvProgress.value = 0;
  recvBytes = 0;
  recvTotal = 0;
  recvChunks = 0;
  recvTotalChunks = 0;
  for (const w of writers) { try { w.abort(); } catch { /* ignore */ } }
  writers = [];
  recvKey = '';
  recvReceived = 0;
  lastProgressAt = 0; recvDoneSent = false;
  perFileChunks = []; nextWriteSeq = 0; readyBuf.clear(); drainRunning = false;
  pendingDone = false;
  if (recvWs) { try { recvWs.close(); } catch {} recvWs = null; }
}

function closeReceiverConn() {
  if (recvAbort) { try { recvAbort.abort(); } catch {} recvAbort = null; }
  if (recvWsReconnectTimer) { clearTimeout(recvWsReconnectTimer); recvWsReconnectTimer = null; }
  if (recvWs) { try { recvWs.close(); } catch {} recvWs = null; }
  finishing = false;
}

function parsePastedLink() {
  const s = recvLinkInput.value.trim();
  if (!s) return;
  try {
    const u = new URL(s);
    recvRoom.value = u.searchParams.get('room') || recvRoom.value;
    const h = new URLSearchParams(u.hash.slice(1));
    const k = h.get('k');
    if (k) recvPass.value = k;
  } catch { /* 不是合法 URL 则忽略 */ }
}

// ================================================================
//  HTTP 流式读取：长度前缀分帧
// ================================================================
let recvBuf = new Uint8Array(0);

/** 从 reader 累积读取恰好 n 字节，返回切出的 Uint8Array，不足返回 null（EOF） */
async function readExact(reader: ReadableStreamDefaultReader<Uint8Array>, n: number): Promise<Uint8Array | null> {
  while (recvBuf.length < n) {
    const { done, value } = await reader.read();
    if (done) return null;
    const tmp = new Uint8Array(recvBuf.length + value.length);
    tmp.set(recvBuf, 0);
    tmp.set(value, recvBuf.length);
    recvBuf = tmp;
  }
  const out = recvBuf.slice(0, n);
  recvBuf = recvBuf.slice(n);
  return out;
}

/** 读一条长度前缀消息 [4B u32 长度][payload] */
async function readMsg(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array | null> {
  const hdr = await readExact(reader, 4);
  if (!hdr) {
    console.log('[recv] readMsg EOF at header');
    return null;
  }
  const len = new DataView(hdr.buffer, hdr.byteOffset, 4).getUint32(0, false);
  if (len === 0) {
    console.log('[recv] readMsg zero length');
    return null;
  }
  console.log(`[recv] readMsg expecting ${len} bytes`);
  const payload = await readExact(reader, len);
  console.log(`[recv] readMsg got ${payload?.length ?? 0} bytes`);
  return payload;
}

/** WebSocket 控制通道：每段独立房间，保持该段 DO 活跃（避免整段传输期间 DO hibernate 丢状态） */
function connectRecvControl(base: string, room: string): Promise<void> {
  return new Promise((resolve) => {
    const wsUrl = base.replace(/^https:/, 'wss:') + `/ws/${room}?role=receiver`;
    try {
      const ws = new WebSocket(wsUrl);
      recvWs = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        try { ws.send(JSON.stringify({ type: 'ready' })); } catch {}
        resolve();
      };
      ws.onerror = () => {
        if (!opened) {
          // WebSocket 不可用（本地开发或网络限制），回退 HTTP POST /ready
          void fetch(`${base}/stream/${room}/ready`, { method: 'POST' }).catch(() => {});
          resolve();
        }
      };
      ws.onclose = () => { if (recvWs === ws) recvWs = null; };
    } catch (e: any) {
      recvStatus.value = `控制通道失败: ${e?.message || e}`;
      resolve();
    }
  });
}

async function startRecv() {
  if (!recvRoom.value || !recvPass.value) {
    recvStatus.value = '需要房间码和口令'; return;
  }
  closeReceiverConn();
  resetReceiver();
  recvBuf = new Uint8Array(0);

  // 在用户手势内先弹目录选择器（Chromium File System Access API）；取消选择则放弃本次接收。
  const picked = await pickSaveDir();
  if (picked && (picked as any).__cancelled) {
    const errName = (picked as any).__error || '';
    recvStatus.value = errName
      ? `选择保存目录失败: ${errName}。请检查浏览器是否禁用了文件选择器，或换用 localhost/https 访问。`
      : '已取消选择保存目录';
    receiving.value = false;
    return;
  }
  const dirHandle = picked; // null = 非 Chromium，下方走 StreamSaver 兜底
  if (dirHandle) {
    try {
      const perm = await (dirHandle as any).requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        recvStatus.value = '需要目录读写权限才能保存文件';
        receiving.value = false;
        return;
      }
    } catch (e: any) {
      recvStatus.value = `目录授权失败: ${e?.message || e}`;
      receiving.value = false;
      return;
    }
  }

  try {
    recvKey = await deriveKey(recvPass.value, LOCAL_SALT);
  } catch (e: any) {
    recvStatus.value = `密钥派生失败: ${e?.message || e}`; return;
  }

  receiving.value = true;
  recvAbort = new AbortController();
  const base = resolveRelayBase();
  manifest0 = null;

  // 逐段消费：第 0 段读 offer 获知总段数，再循环后续段。
  let segCount = 1;
  for (let seg = 0; seg < segCount; seg++) {
    if (recvAborted) break;
    const ok = await recvSegment(base, seg, dirHandle);
    if (!ok || !receiving.value) break;       // 出错则停止
    segCount = recvSegCount.value;            // 第 0 段读 offer 后获知真实段数
  }
  // 循环正常结束：所有段收完（finishRecv 已在最后一段 drainWrites 内触发）
}

/** 接收单一段：连接该段房间、读 offer、建/复用 writers、收数据帧到 EOF。
 *  返回 true 表示本段正常结束（无论是否还有后续段），false 表示出错。 */
async function recvSegment(base: string, seg: number, dirHandle: any): Promise<boolean> {
  const room = segRoomRecv(seg);
  await connectRecvControl(base, room);
  let resp: Response;
  try {
    resp = await fetch(`${base}/stream/${room}`, {
      signal: recvAbort!.signal,
      headers: { 'Accept': 'application/octet-stream' },
    });
  } catch (e: any) {
    recvStatus.value = `连接失败: ${e?.message || e}`;
    receiving.value = false; return false;
  }
  if (!resp.ok || !resp.body) {
    recvStatus.value = `连接失败: HTTP ${resp.status}`;
    receiving.value = false; return false;
  }

  senderOnline.value = true;
  recvStatus.value = `第 ${seg + 1} 段：已连接，等待文件清单…`;
  let reader = resp.body.getReader();

  // 2. 读 offer（第一条消息）；跳过 DO 开场帧，读到真正的 offer(JSON) 为止。
  let offerPayload: Uint8Array | null = null;
  for (let attempt = 0; attempt < 3 && !offerPayload; attempt++) {
    if (attempt > 0) {
      reader.cancel();
      const r2 = await fetch(`${base}/stream/${room}`, { signal: recvAbort!.signal, headers: { 'Accept': 'application/octet-stream' } });
      if (!r2.ok || !r2.body) { recvStatus.value = `连接失败(重试${attempt}): HTTP ${r2.status}`; receiving.value = false; return false; }
      resp = r2; reader = resp.body.getReader();
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    for (let guard = 0; guard < 8 && !offerPayload; guard++) {
      const m = await readMsg(reader);
      if (!m) break; // EOF：交给外层重试或放弃
      try {
        const o = JSON.parse(new TextDecoder().decode(m));
        if (o && o.type === 'offer') offerPayload = m;
      } catch { /* 开场帧等非法 JSON，忽略继续读 */ }
    }
  }
  if (!offerPayload) { recvStatus.value = '未收到文件清单，对方可能已断开'; receiving.value = false; return false; }
  const offer = JSON.parse(new TextDecoder().decode(offerPayload));
  if (!Array.isArray(offer.files) || offer.files.length === 0) { recvStatus.value = '收到无效的文件清单'; receiving.value = false; return false; }
  const segIndex = offer.segIndex || 0;
  const segCount = offer.segCount || 1;
  recvSegCount.value = segCount;
  if (segIndex !== seg) {
    recvStatus.value = `段序号错乱：期望第 ${seg + 1} 段，收到第 ${segIndex + 1} 段`;
    receiving.value = false; return false;
  }

  if (seg === 0) {
    recvFiles.value = offer.files;
    recvTotal = offer.files.reduce((s: number, f: any) => s + (f.size || 0), 0);
    recvTotalChunks = offer.files.reduce((s: number, f: any) => s + (f.size === 0 ? 0 : Math.ceil((f.size || 0) / CHUNK)), 0);
    perFileChunks = offer.files.map((f: any) => (f.size === 0 ? 0 : Math.ceil((f.size || 0) / CHUNK)));
    recvChunks = 0;
    manifest0 = offer.files.map((f: any) => ({ name: f.name, size: f.size }));
    try { await makeSinks(offer.files, dirHandle); } catch (e: any) {
      recvStatus.value = `初始化接收失败: ${e?.message || e}`; receiving.value = false; return false;
    }
    if (recvTotalChunks === 0) {
      // 空文件集：直接完成
      recvStatus.value = '接收完成（无文件）';
      if (recvWs && recvWs.readyState === WebSocket.OPEN) try { recvWs.send(JSON.stringify({ type: 'recv-done' })); } catch {}
      await finishRecv();
      return true;
    }
  } else {
    // 后续段：复用已建 writers 与状态，仅校验清单一致（防错链/串段）
    const same = manifest0 && manifest0.length === offer.files.length &&
      offer.files.every((f: any, i: number) => f.name === manifest0![i].name && f.size === manifest0![i].size);
    if (!same) { recvStatus.value = '文件清单与第 1 段不一致，传输可能损坏'; receiving.value = false; return false; }
  }

  recvReady.value = true;
  if (recvWs && recvWs.readyState === WebSocket.OPEN) {
    try { recvWs.send(JSON.stringify({ type: 'recv-ready' })); } catch {}
  }
  recvStatus.value = `第 ${seg + 1}/${segCount} 段：开始流式接收…`;

  // 3. 读数据帧直到 EOF
  let frameCount = 0;
  while (true) {
    if (recvAborted) break;
    const payload = await readMsg(reader);
    if (!payload) break; // EOF = 发送端完成本段
    if (payload.length < FRAME_HDR) { console.log(`[recv] 跳过过短帧(${payload.length}B，疑似开场帧)`); continue; }
    const frameBuf = new ArrayBuffer(payload.byteLength);
    new Uint8Array(frameBuf).set(payload);
    handleDataFrame(frameBuf);
    frameCount++;
  }
  // 4. 本段流结束 → 收尾（全局保序写盘；最后一段收齐全部帧时 drainWrites 触发 recv-done + finishRecv）
  pendingDone = true;
  void drainWrites();
  // 关闭本段控制通道（最后一段保留 WS 以回传 recv-done 完成信号）
  if (segIndex < segCount - 1) {
    try { if (recvWs) recvWs.close(); } catch {}
    recvWs = null;
  }
  return true;
}

async function finishRecv() {
  if (finishing) return;
  finishing = true;
  let allOk = true;
  for (let fi = 0; fi < writers.length; fi++) {
    const w = writers[fi];
    if (!w) { allOk = false; continue; }
    try { await w.close(); } catch { allOk = false; }
  }
  if (recvFallback) {
    recvStatus.value = allOk
      ? '接收完成，浏览器已触发下载（当前为不安全连接，已降级为整文件下载；大文件建议用 localhost/https 访问以获得流式写入）'
      : '接收完成（部分文件写入失败）';
  } else {
    recvStatus.value = allOk
      ? '接收完成，文件已流式保存到浏览器下载目录（如未自动弹出，请查看下载管理器）'
      : '接收完成（部分文件写入失败）';
  }
  receiving.value = false;
  recvReady.value = false;
  writers = [];
}

/** (fi, ci) → 全局递增序号 */
function frameSeq(fi: number, ci: number): number {
  let s = 0;
  for (let i = 0; i < fi; i++) s += perFileChunks[i] || 0;
  return s + ci;
}

/** 收到一帧的入口：立即并发解密，不阻塞后续帧 */
function handleDataFrame(data: ArrayBuffer) {
  if (recvAborted) return;
  const frame = new Uint8Array(data);
  if (frame.length < FRAME_HDR) { recvStatus.value = '收到过短的数据帧'; return; }
  const dv = new DataView(frame.buffer);
  const fi = dv.getUint16(0);
  const ci = dv.getUint32(2);
  const plainLen = dv.getUint32(6);
  const body = frame.subarray(FRAME_HDR);
  const bodyBuf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  if (fi >= writers.length) {
    console.warn(`[recv] 文件索引越界: fi=${fi}, max=${writers.length - 1}`);
    return;
  }
  const seq = frameSeq(fi, ci);
  decryptChunkAsync(bodyBuf, recvKey, plainLen)
    .then((plainBuf) => {
      if (recvAborted) return;
      recvReceived += (plainBuf as ArrayBuffer).byteLength;
      readyBuf.set(seq, { fi, plain: new Uint8Array(plainBuf) });
      void drainWrites();
    })
    .catch((e: any) => {
      console.error('[recv] 解密失败:', e);
      recvStatus.value = `数据帧错误: ${e?.message || e}`;
    });
}

/** 串行写盘协程：按全局序号顺序写入 */
async function drainWrites() {
  if (drainRunning) return;
  drainRunning = true;
  try {
    while (readyBuf.has(nextWriteSeq)) {
      const item = readyBuf.get(nextWriteSeq)!;
      readyBuf.delete(nextWriteSeq);
      const w = writers[item.fi];
      if (w) { try { await w.write(item.plain); } catch {} }
      recvBytes += item.plain.length;
      recvProgress.value = recvTotal ? recvBytes / recvTotal : 1;
      // 节流回传进度给发送端（~200ms 一次，避免高频 WS 消息压垮控制通道）
      const _now = Date.now();
      if (recvWs && recvWs.readyState === WebSocket.OPEN && _now - lastProgressAt >= 50) {
        lastProgressAt = _now;
        try { recvWs.send(JSON.stringify({ type: 'progress', received: recvBytes, total: recvTotal })); } catch {}
      }
      nextWriteSeq++;
    }
    // 收齐全部帧 → 完成
    if (recvTotalChunks > 0 && nextWriteSeq >= recvTotalChunks) {
      // 通知发送端：已全部收齐写盘（仅发一次，防止重复）
      if (!recvDoneSent) {
        recvDoneSent = true;
        if (recvWs && recvWs.readyState === WebSocket.OPEN) {
          try { recvWs.send(JSON.stringify({ type: 'recv-done' })); } catch {}
        }
      }
      await finishRecv();
    }
  } finally {
    drainRunning = false;
  }
}

function onCancelRecv() {
  recvAborted = true;
  readyBuf.clear();
  for (const w of writers) { try { w.abort(); } catch {} }
  writers = [];
  recvAborted = false;
  resetReceiver();
  closeReceiverConn();
  recvStatus.value = '对方已取消发送，已重置为初始状态，可重新接收';
}

onUnmounted(() => { closeReceiverConn(); });
</script>

<template>
  <div class="local">
    <!-- 接收 -->
    <section class="blk" v-if="!props.side || props.side === 'receive'">
      <h3>② 接收（输入房间码）</h3>
      <div class="recv-form">
        <input v-model="recvRoom" placeholder="房间码（链接打开时自动填入）" :disabled="receiving" />
      </div>
      <div class="recv-form">
        <input v-model="recvPass" type="text" placeholder="密钥（链接打开时自动填入，或手动输入）" :disabled="receiving" />
      </div>
      <div class="recv-form">
        <input v-model="recvLinkInput" placeholder="或粘贴整条分享链接自动解析" :disabled="receiving" />
        <button class="btn sm" @click="parsePastedLink">解析</button>
      </div>
      <div class="presence">
        <span class="dot" :class="{ on: senderOnline }"></span>
        对方（发送端）：{{ senderOnline ? '已在线 ✓' : '等待加入…' }}
        <span class="transport">HTTP 流式中继</span>
      </div>
      <div class="actions">
        <button class="btn primary" :disabled="receiving" @click="startRecv">连接接收</button>
      </div>
      <div v-if="recvFiles.length" class="filelist">
        <div v-for="f in recvFiles" :key="f.name" class="frow">
          <span>{{ f.name }}</span><span class="sz">{{ fmt(f.size) }}</span>
        </div>
      </div>
      <div v-if="receiving || recvReady" class="bar">
        <div class="fill" :style="{ width: (recvProgress * 100) + '%' }"></div>
      </div>
      <div class="status">{{ recvStatus }}</div>
      <p class="hint e2ee-hint">🔒 已端到端加密：密钥仅在本机从链接 <code>#k=</code> 派生，服务器只转发密文、无法解密。</p>
    </section>
  </div>
</template>

<style scoped>
.local { display: flex; flex-direction: column; gap: 8px; }
.blk { display: flex; flex-direction: column; gap: 10px; }
.hint { font-size: 12.5px; color: var(--text-dim); margin: 0; }
.e2ee-hint {
  color: #3ecf8e;
  border-left: 2px solid #3ecf8e;
  padding: 6px 8px;
  margin: 4px 0 0 !important;
  background: rgba(62, 207, 142, 0.08);
  border-radius: 0 6px 6px 0;
}
.e2ee-hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(62, 207, 142, 0.16);
  padding: 0 4px;
  border-radius: 3px;
}
h3 { margin: 0; font-size: 15px; }
hr { border: none; border-top: 1px solid var(--border); margin: 6px 0; }
.filelist { display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow: auto; }
.frow { display: flex; justify-content: space-between; font-size: 13px; padding: 6px 10px; background: var(--bg-soft); border-radius: 8px; }
.sz { color: var(--text-faint); }
.total { font-size: 12.5px; color: var(--text-faint); }
.roominfo { display: flex; flex-direction: column; gap: 10px; }
.code { font-size: 14px; }
.code b { font-size: 18px; letter-spacing: 2px; color: var(--accent); }
.link { display: flex; gap: 8px; }
.link input { flex: 1; background: var(--bg-soft); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 8px; font-size: 12px; }
.actions { display: flex; gap: 12px; }
.recv-form { display: flex; gap: 8px; }
.recv-form input { flex: 1; background: var(--bg-soft); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 9px; font-size: 13px; }
.bar { height: 8px; background: var(--bg-soft); border-radius: 999px; overflow: hidden; }
.fill { height: 100%; background: var(--accent-grad); transition: width 0.15s; }
.status { font-size: 12.5px; color: var(--text-dim); min-height: 16px; word-break: break-all; }
.btn { border: 1px solid var(--border); background: var(--panel-2); color: var(--text); border-radius: 8px; padding: 9px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn.primary { background: var(--accent-grad); color: #07101f; border: none; }
.btn.sm { padding: 8px 12px; font-size: 12px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.presence { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-dim); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-faint); flex: none; }
.dot.on { background: #2ecc71; box-shadow: 0 0 6px #2ecc71; }
.transport { margin-left: 8px; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-dim); }
input[type=file] { font-size: 13px; color: var(--text-dim); }
</style>
