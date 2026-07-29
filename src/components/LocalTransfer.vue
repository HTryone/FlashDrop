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
let recvAckTimer: ReturnType<typeof setInterval> | null = null;  // 周期性回报 ack(含缺口 NACK) 的定时器

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
  if (recvAckTimer) { clearInterval(recvAckTimer); recvAckTimer = null; }
  perFileChunks = []; nextWriteSeq = 0; readyBuf.clear(); drainRunning = false;
  pendingDone = false;
  if (recvWs) { try { recvWs.close(); } catch {} recvWs = null; }
}

function closeReceiverConn() {
  if (recvAbort) { try { recvAbort.abort(); } catch {} recvAbort = null; }
  if (recvWsReconnectTimer) { clearTimeout(recvWsReconnectTimer); recvWsReconnectTimer = null; }
  if (recvAckTimer) { clearInterval(recvAckTimer); recvAckTimer = null; }
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
//  WS 数据通道（2026-07-29 真流式架构）：数据帧经同一条 receiver WS 到达。
//  二进制消息 = 一个 E2EE 数据帧 [12B FRAME_HDR][IV+密文+HMAC]（≤1MiB，无长度前缀）；
//  JSON 消息 = 控制帧（offer 文件清单 / data-eof 数据结束）。
//  relay 帧级即时转发（无 POST 整段缓冲），根治分片脉冲。
// ================================================================
let recvDirHandle: any = null;   // startRecv 用户手势内选好的目录句柄，offer 到达时建 sink 用

/** 收到 offer（文件清单）：建落盘句柄并回发 recv-ready 放行发送端 */
async function onOffer(offer: any) {
  if (recvFiles.value.length) return; // 幂等：发送端每 5s 重发 offer 防 WS 竞态丢失，重复到达直接忽略
  if (!Array.isArray(offer.files) || offer.files.length === 0) {
    recvStatus.value = '收到无效的文件清单'; return;
  }
  senderOnline.value = true;
  recvFiles.value = offer.files;
  recvTotal = offer.files.reduce((s: number, f: any) => s + (f.size || 0), 0);
  recvTotalChunks = offer.files.reduce((s: number, f: any) => s + Math.max(1, Math.ceil((f.size || 0) / CHUNK)), 0);
  perFileChunks = offer.files.map((f: any) => Math.max(1, Math.ceil((f.size || 0) / CHUNK)));
  recvChunks = 0;
  try { await makeSinks(offer.files, recvDirHandle); } catch (e: any) {
    console.error('[recv] makeSinks failed:', e);
    recvStatus.value = `初始化接收失败: ${e?.message || e}`;
    receiving.value = false;
    return;
  }
  console.log('[recv] makeSinks ok, sending recv-ready');
  recvReady.value = true;
  // 声明：落盘句柄已就绪，通知发送端可以开始推数据帧
  if (recvWs && recvWs.readyState === WebSocket.OPEN) {
    try { recvWs.send(JSON.stringify({ type: 'recv-ready' })); } catch {}
  }
  recvStatus.value = recvFallback
    ? `收到 ${offer.files.length} 个文件，开始接收（当前为不安全连接，已切换为浏览器下载模式）`
    : `收到 ${offer.files.length} 个文件，开始流式接收…`;
}

/** WebSocket 数据+控制通道：保持 DO 活跃，且承载 offer/数据帧/eof（不再有 HTTP GET 流） */
function connectRecvControl(base: string): Promise<void> {
  return new Promise((resolve) => {
    const wsUrl = base.replace(/^https:/, 'wss:') + `/ws/${recvRoom.value}?role=receiver`;
    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';   // 数据帧直接以 ArrayBuffer 交付，免 Blob 异步转换
      recvWs = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        try { ws.send(JSON.stringify({ type: 'ready' })); } catch {}
        resolve();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') {
          // 二进制 = 数据帧，布局与 handleDataFrame 期待的 [12B hdr][加密体] 完全一致
          handleDataFrame(ev.data as ArrayBuffer);
          return;
        }
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'offer') { void onOffer(msg); }
          else if (msg.type === 'data-eof') { pendingDone = true; void drainWrites(); }
        } catch { /* 忽略非 JSON 控制消息 */ }
      };
      ws.onerror = () => {
        if (!opened) {
          // WebSocket 不可用（本地开发或网络限制），回退 HTTP POST /ready
          void fetch(`${base}/stream/${recvRoom.value}/ready`, { method: 'POST' }).catch(() => {});
          resolve();
        }
      };
      ws.onclose = () => {
        if (recvWs === ws) recvWs = null;
        // 只有曾经成功打开过的连接才自动重连，避免初始失败时死循环
        if (opened && receiving.value && !recvWs) {
          recvWsReconnectTimer = setTimeout(() => void connectRecvControl(base), 3000);
        }
      };
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

  // 在用户手势内先弹目录选择器（Chromium File System Access API）：拿到句柄后数据直接流式写盘，
  // 不出现浏览器「下载」、不被扩展污染的 mitm iframe 干扰。取消选择则放弃本次接收。
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
  console.log('[recv] dirHandle acquired, requesting permission...');

  // 关键：showDirectoryPicker 必须在用户手势内调用；随后立刻在同一手势内申请持久读写权限。
  // 否则等异步读到 offer 后再调用 dirHandle.getFileHandle() 时，user activation 已过期，
  // Chrome 会抛 SecurityError: "User activation is required to request permissions."。
  if (dirHandle) {
    try {
      const perm = await (dirHandle as any).requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      recvStatus.value = '需要目录读写权限才能保存文件';
      receiving.value = false;
      return;
    }
    console.log('[recv] directory permission granted');
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
  recvStatus.value = '正在建立数据通道…';
  recvAbort = new AbortController();
  recvDirHandle = dirHandle;   // offer 到达时（onOffer）建落盘句柄用
  const base = resolveRelayBase();

  // WS 真流式：连上 WS 发 ready 即完成初始化，其余全部事件驱动——
  // offer(JSON)→onOffer 建 sink 回 recv-ready → 二进制帧→handleDataFrame 解密
  // → drainWrites 保序写盘 → 收齐全部帧→finishRecv（data-eof 仅兜底触发收尾）。
  console.log('[recv] connecting ws (data channel)...');
  await connectRecvControl(base);
  // 启动 ack 周期回报（每 150ms）：即使无新帧到达也持续回报缺口 NACK，确保静默丢帧被补发
  if (recvAckTimer) clearInterval(recvAckTimer);
  recvAckTimer = setInterval(() => {
    if (!receiving.value) { if (recvAckTimer) { clearInterval(recvAckTimer); recvAckTimer = null; } return; }
    sendAck();
  }, 150);
  console.log('[recv] ws connected, waiting for offer...');
  recvStatus.value = '已连接，等待对方发送文件清单…';
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

/** 回报累计确认 + 缺口（NACK）：acked = 已连续写盘最高 seq；missing = readyBuf 中高于 nextWriteSeq 却缺失的 seq。
 *  发送端据此回收缓存并补发缺失帧，根治 Chrome WS 静默丢帧导致的文件损坏。 */
function sendAck() {
  if (!recvWs || recvWs.readyState !== WebSocket.OPEN) return;
  const acked = nextWriteSeq - 1;
  let maxBuf = nextWriteSeq - 1;
  for (const s of readyBuf.keys()) if (s > maxBuf) maxBuf = s;
  const missing: number[] = [];
  for (let s = nextWriteSeq; s <= maxBuf; s++) if (!readyBuf.has(s)) missing.push(s);
  try { recvWs.send(JSON.stringify({ type: 'ack', acked, missing })); } catch {}
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
      // 节流回报 ack(累计确认 + 缺口 NACK) 给发送端（~100ms 一次，驱动重传）
      const _now = Date.now();
      if (recvWs && recvWs.readyState === WebSocket.OPEN && _now - lastProgressAt >= 100) {
        lastProgressAt = _now;
        sendAck();
      }
      nextWriteSeq++;
    }
    // 收齐全部帧 → 完成
    if (recvTotalChunks > 0 && nextWriteSeq >= recvTotalChunks) {
      // 通知发送端：已全部收齐写盘（仅发一次，防止重复）
      if (!recvDoneSent) {
        recvDoneSent = true;
        sendAck();   // 最终 ack：acked=total-1, missing=[]，发送端回收全部缓存
        if (recvWs && recvWs.readyState === WebSocket.OPEN) {
          try { recvWs.send(JSON.stringify({ type: 'recv-done' })); } catch {}
        }
      }
      await finishRecv();
    } else if (pendingDone && nextWriteSeq < recvTotalChunks) {
      // 发送端已声明数据结束(data-eof)，但序号仍有缺口 → 帧永久丢失。
      // 旧逻辑会卡在缺失序号处死等：recvBytes 不再增长 → 发送端窗口闸门锁死 → 双方无提示。
      // 给 2s 宽限容纳迟到帧（relay 可能仍在转发最后几帧），仍缺口则明确报错并中止，
      // 同时通知发送端(recv-gone) 触发其 lFatal 中止，避免对端无限等待。
      setTimeout(() => {
        if (nextWriteSeq >= recvTotalChunks) return;          // 宽限内补齐，正常完成
        const missing = recvTotalChunks - nextWriteSeq;
        recvStatus.value = `传输不完整：缺失 ${missing} 个数据帧，文件可能损坏，请重试`;
        receiving.value = false;
        for (const w of writers) { try { w.abort(); } catch {} }
        writers = [];
        if (recvWs && recvWs.readyState === WebSocket.OPEN) {
          try { recvWs.send(JSON.stringify({ type: 'recv-gone' })); } catch {}
        }
      }, 2000);
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
