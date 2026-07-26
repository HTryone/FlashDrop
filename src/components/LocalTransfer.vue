<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import {
  encryptChunk, decryptChunk, deriveKey, randomPassphrase,
  LOCAL_SALT, LOCAL_CHUNK_SIZE,
} from '@/crypto/e2ee';
import { createWebRTC, fetchIceServers } from '@/composables/useWebRTC';

// 由父组件（发送/接收面板）指定渲染哪一侧；不传则两侧都渲染
const props = defineProps<{ side?: 'send' | 'receive' }>();

// ---------- 常量 ----------
const CHUNK = LOCAL_CHUNK_SIZE;          // 加密前分片大小（明文）
// 加密后单帧 ≈ 768KB + 16(IV) + ≤16(PKCS7) + 32(HMAC) + 12(帧头) ≈ 786.5KB，远低于 Cloudflare DO 的 1MB 上限
const FRAME_HDR = 12;                    // 帧头：fi(u16) + ci(u32) + plainLen(u32)
// Cloudflare DO WebSocket 消息上限 1 MB（≈1,000,000 字节），需留余量
const LOW = 16 * 1024 * 1024;           // 背压阈值 16MiB（增大缓冲区，减少停顿，提升吞吐）
const CONN_TIMEOUT = 10000;             // 连接超时 ms
const DRAIN_TIMEOUT_MS = 30000;         // 背压等待超时 ms

// 默认线上中转（Cloudflare Worker，WSS）。可用构建时 VITE_RELAY_URL=xxx 覆盖。
const RELAY_DEFAULT = 'flashdrop-relay.xianshenghu363.workers.dev';
function resolveRelay() {
  const host = (import.meta as any).env?.VITE_RELAY_URL || RELAY_DEFAULT;
  const proto = (host.includes('workers.dev') || location.protocol === 'https:') ? 'wss' : 'ws';
  return { host, proto };
}

// ---------- 工具 ----------
function fmt(n: number) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 安全解析 JSON，失败返回 null */
function safeParse(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

/** 安全执行加密，失败抛出带上下文的 Error */
function safeEncrypt(plain: Uint8Array, keyHex: string): Uint8Array<ArrayBuffer> {
  try { return encryptChunk(plain, keyHex); }
  catch (e: any) { throw new Error(`加密失败: ${e?.message || e}`); }
}

/** 安全执行解密，失败抛出带上下文的 Error */
function safeDecrypt(frame: Uint8Array, keyHex: string, plainLen?: number): Uint8Array<ArrayBuffer> {
  try { return decryptChunk(frame, keyHex, plainLen); }
  catch (e: any) { throw new Error(`解密失败: ${e?.message || e}`); }
}

// ================================================================
//  接收端「写入落盘」抽象：安全上下文用 StreamSaver 流式写盘（不爆内存），
//  非安全上下文（手机经 http 局域网访问）Service Worker 不可用 → 降级为浏览器 Blob 下载。
//  关键点：streamsaver 动态 import + 全程 try/catch，任何异常都不会拖垮页面（白屏）。
// ================================================================
/** StreamSaver 模块懒加载（带缓存），失败抛错由调用方降级处理 */
let _ssPromise: Promise<any> | null = null;
function ensureStreamSaver(): Promise<any> {
  if (!_ssPromise) {
    // @ts-ignore  streamsaver 类型声明可能缺失，运行时以 any 处理
    _ssPromise = import('streamsaver').then((m: any) => {
      const mod = m.default || m;
      try { mod.mitm = `${location.origin}/mitm.html`; } catch { /* ignore */ }
      return mod;
    });
  }
  return _ssPromise;
}

/** 只有 localhost / https 才允许注册 Service Worker（StreamSaver 前置条件） */
function isSecureContextForSW(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
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

/** 流式写入 sink（安全上下文） */
class StreamSink {
  private w: any;
  constructor(w: any) { this.w = w; }
  write(p: Uint8Array) { return this.w.write(p); }
  async close() { await this.w.close(); }
  abort() { try { this.w.abort(); } catch { /* ignore */ } }
}
/** 降级 sink：攒进内存数组，close 时触发浏览器下载（非安全上下文兜底，小文件可用） */
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

/** 为所有文件创建写入 sink；优先 StreamSaver，失败/不可用则降级 Blob。设置 recvFallback 标志供 UI 提示 */
let recvFallback = false;
async function makeSinks(files: any[]) {
  writers = [];
  recvFallback = false;
  let ss: any = null;
  if (isSecureContextForSW()) {
    try { ss = await ensureStreamSaver(); } catch (e: any) {
      console.warn('[recv] streamsaver 加载失败，降级 Blob 下载:', e);
      ss = null;
    }
  }
  if (ss) {
    try {
      writers = files.map((f: any) => new StreamSink(ss.createWriteStream(f.name, { size: f.size || undefined }).getWriter()));
      return;
    } catch (e: any) {
      console.warn('[recv] 创建流式写入失败，降级 Blob 下载:', e);
    }
  }
  // 降级路径：非安全上下文或 streamsaver 不可用
  recvFallback = true;
  writers = files.map((f: any) => new BlobSink(f.name));
}

// ================================================================
//  发送方
// ================================================================
const sendFiles = ref<File[]>([]);
const room = ref('');
const passphrase = ref('');
const sendLink = ref('');
const keyHex = ref('');
const sending = ref(false);
const sendDone = ref(false);
const transferStarted = ref(false);     // 用户已点「开始传输」（offer 已发出）
let loopStarted = false;                // doSendLoop 是否已启动（防止接收端晚加入重发 offer 导致重复发送）
const sendProgress = ref(0);
const sendStatus = ref('');
const peerOnline = ref(false);
let sendWs: WebSocket | null = null;

function pick(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) sendFiles.value = Array.from(input.files);
}
const sendTotal = computed(() => sendFiles.value.reduce((s, f) => s + f.size, 0));

/** 清理发送端状态（用于重连/关闭时） */
function resetSender() {
  sending.value = false;
  sendDone.value = false;
  transferStarted.value = false;
  loopStarted = false;
  sendProgress.value = 0;
  peerOnline.value = false;
}
/** 安全关闭发送端 WS */
function closeSenderWs() {
  if (sendWs) { try { sendWs.close(); } catch { /* ignore */ } sendWs = null; }
}

function genRoom() {
  // 防止重复连接：先关旧 WS
  closeSenderWs();
  resetSender();

  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  for (let i = 0; i < 6; i++) s += cs[a[i] % cs.length];
  room.value = s;
  passphrase.value = randomPassphrase();
  sendLink.value = `${location.origin}/?tab=local&room=${s}#k=${passphrase.value}`;
  sendStatus.value = '房间已生成，正在连接中继…';
  void connectSender();
}

/** 生成房间后立即连接中继，提前感知对方是否在线 */
async function connectSender() {
  if (!room.value || !passphrase.value) return;
  try {
    keyHex.value = await deriveKey(passphrase.value, LOCAL_SALT);
  } catch (e: any) {
    sendStatus.value = `密钥派生失败: ${e?.message || e}`;
    return;
  }

  const { host: relayHost, proto } = resolveRelay();
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${proto}://${relayHost}/relay?room=${room.value}&role=sender`);
  } catch (e: any) {
    sendStatus.value = `无法创建连接: ${e?.message || e}`;
    return;
  }
  (ws as any).bufferedAmountLowThreshold = LOW;
  sendWs = ws;
  resetSender();
  sendStatus.value = '已连上中继，等待对方加入…';

  // 连接超时
  let settled = false;
  const openTimer = window.setTimeout(() => {
    if (!settled && ws.readyState !== WebSocket.OPEN) {
      settled = true;
      sendStatus.value = '连接超时：中继不可达';
      resetSender();
      try { ws.close(); } catch { /* ignore */ }
    }
  }, CONN_TIMEOUT);

  ws.onopen = () => {
    clearTimeout(openTimer);
    if (!settled) sendStatus.value = '已连上中继，等待对方加入…';
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return; // 忽略非文本帧（发送端不应收到二进制）
    const msg = safeParse(ev.data as string);
    if (!msg) return;

    if ((msg.type === 'peer-joined' && msg.role === 'receiver') || msg.type === 'receiver-joined') {
      const wasOffline = !peerOnline.value;
      peerOnline.value = true;
      if (!sending.value && !sendDone.value) {
        sendStatus.value = '对方已在线，可开始传输';
      }
      // 接收端晚加入：用户已点「开始传输」但 offer 在对方连接前发出（已丢失），
      // 此时重发一次 offer，让新加入的接收端拿到文件清单并回 ready，从而启动传输。
      // 仅在传输尚未真正开始（loopStarted=false）时重发，避免重复发送数据帧。
      if (transferStarted.value && !loopStarted && ws.readyState === WebSocket.OPEN && wasOffline) {
        sendOffer(ws);
        sendStatus.value = '对方已加入，重新发起传输…';
      }
    } else if (msg.type === 'ready') {
      void doSendLoop(ws);
    } else if (msg.type === 'peer-left') {
      peerOnline.value = false;
      if (!sendDone.value) sendStatus.value = '对方已断开，等待重新加入…';
    }
    // 忽略未知消息类型
  };

  ws.onclose = () => {
    clearTimeout(openTimer);
    if (!settled) { settled = true; }
    if (!sendDone.value) resetSender();
  };
  ws.onerror = () => {
    clearTimeout(openTimer);
    if (!settled) { settled = true; }
    sendStatus.value = '连接出错（中继不可达或被拦截）';
    resetSender();
  };
}

/** 发送 offer（文件清单）。供「开始传输」与「接收端晚加入重发」复用 */
function sendOffer(ws: WebSocket) {
  try {
    ws.send(JSON.stringify({
      type: 'offer',
      files: sendFiles.value.map((f) => ({ name: f.name, size: f.size })),
    }));
  } catch (e: any) {
    sendStatus.value = `发送 offer 失败: ${e?.message || e}`;
  }
}

/** 真正开始传输（门控：必须对方在线 + WS 就绪） */
function startSend() {
  if (!sendWs || sendWs.readyState !== WebSocket.OPEN) {
    sendStatus.value = '未连接到中继'; return;
  }
  if (!peerOnline.value) {
    sendStatus.value = '对方尚未加入，请等待对方连接接收'; return;
  }
  if (!sendFiles.value.length) {
    sendStatus.value = '没有待发送文件'; return;
  }
  sending.value = true;
  transferStarted.value = true;
  sendProgress.value = 0;
  sendStatus.value = '对方已连接，开始传输…';
  sendOffer(sendWs);
}

async function doSendLoop(ws: WebSocket) {
  loopStarted = true;
  const files = sendFiles.value;
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total === 0) {
    // 空文件列表，直接结束
    ws.send(JSON.stringify({ type: 'done' }));
    sendDone.value = true;
    sendStatus.value = '传输完成（空）';
    sending.value = false;
    return;
  }
  let sent = 0;
  try {
    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      let offset = 0;
      let ci = 0;
      while (offset < file.size) {
        // 检查 WS 是否还活着
        if (ws.readyState !== WebSocket.OPEN) {
          throw new Error('连接已断开');
        }
        const end = Math.min(offset + CHUNK, file.size);
        const buf = await file.slice(offset, end).arrayBuffer();
        const plain = new Uint8Array(buf);
        const enc = safeEncrypt(plain, keyHex.value);

        // 组装帧：[fi:u16][ci:u32][plainLen:u32][encrypted_chunk]
        const header = new Uint8Array(FRAME_HDR);
        const dv = new DataView(header.buffer);
        dv.setUint16(0, fi);
        dv.setUint32(2, ci);
        dv.setUint32(6, buf.byteLength); // 真实明文长度（用于接收端去除 PKCS7 填充）
        const frame = new Uint8Array(header.length + enc.length);
        frame.set(header, 0);
        frame.set(enc, header.length);

        // 背压控制
        if (ws.bufferedAmount > LOW) await safeDrain(ws);

        ws.send(frame);
        offset += buf.byteLength;
        ci++;
        sent += buf.byteLength;
        sendProgress.value = total ? sent / total : 1;
      }
    }
    // 全部发完
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'done' }));
    }
    sendDone.value = true;
    sendStatus.value = '传输完成';
  } catch (e: any) {
    sendStatus.value = `传输出错: ${e?.message || e}`;
  } finally {
    sending.value = false;
  }
}

/** 带超时的背压等待 */
function safeDrain(ws: WebSocket): Promise<void> {
  if (ws.bufferedAmount <= LOW) return Promise.resolve();
  return new Promise((resolve) => {
    const onLow = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, DRAIN_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener('bufferedamountlow', onLow as any);
      ws.removeEventListener('close', onClose as any);
    }
    ws.addEventListener('bufferedamountlow', onLow as any, { once: true });
    ws.addEventListener('close', onClose as any, { once: true });
  });
}

function copyLink() {
  navigator.clipboard?.writeText(sendLink.value);
  sendStatus.value = '链接已复制';
}

// ================================================================
//  接收方
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
let recvWs: WebSocket | null = null;
// WebRTC P2P 直连层（叠加在 WS 中继之上；失败自动回退 WS）
let recvRtc: ReturnType<typeof createWebRTC> | null = null;
const recvRtcOpen = ref(false);
let rIce: RTCIceServer[] = [];
let writers: any[] = [];                 // 每个文件一个 WritableStream writer，流式写盘
let recvBytes = 0;
let recvTotal = 0;
let recvChunks = 0;                      // 已收到的数据块数（用于收齐自动完成）
let recvTotalChunks = 0;                 // 期望总块数（由 offer 文件清单推算）
let recvKey = '';

/** 清理接收端状态 */
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
  dcReasm = null;
  if (recvRtc) { try { recvRtc.destroy(); } catch { /* ignore */ } recvRtc = null; }
  recvRtcOpen.value = false;
}
/** 安全关闭接收端 WS */
function closeReceiverWs() {
  if (recvWs) { try { recvWs.close(); } catch { /* ignore */ } recvWs = null; }
  if (recvRtc) { try { recvRtc.destroy(); } catch { /* ignore */ } recvRtc = null; }
  recvRtcOpen.value = false;
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

async function startRecv() {
  if (!recvRoom.value || !recvPass.value) {
    recvStatus.value = '需要房间码和口令'; return;
  }

  // 防止重复连接
  closeReceiverWs();
  resetReceiver();

  try {
    recvKey = await deriveKey(recvPass.value, LOCAL_SALT);
  } catch (e: any) {
    recvStatus.value = `密钥派生失败: ${e?.message || e}`; return;
  }

  const { host: relayHost, proto } = resolveRelay();
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${proto}://${relayHost}/relay?room=${recvRoom.value}&role=receiver`);
  } catch (e: any) {
    recvStatus.value = `无法创建连接: ${e?.message || e}`; return;
  }
  ws.binaryType = 'arraybuffer';
  recvWs = ws;
  receiving.value = true;
  recvStatus.value = '连接中…';
  // 拉取 ICE 并创建 WebRTC 层（接收端为 answerer，收到 offer 即应答）
  try { rIce = await fetchIceServers(relayHost, proto); } catch { rIce = []; }
  recvRtc = createWebRTC({
    role: 'receiver',
    iceServers: rIce,
    sendSignal: (m) => { if (recvWs && recvWs.readyState === WebSocket.OPEN) recvWs.send(JSON.stringify(m)); },
    onDataChannel: (dc) => { dc.onmessage = onDcMessage; },
    onState: (open) => { recvRtcOpen.value = open; },
  });

  let settled = false;
  const openTimer = window.setTimeout(() => {
    if (!settled && ws.readyState !== WebSocket.OPEN) {
      settled = true;
      recvStatus.value = '连接超时：中继不可达';
      resetReceiver();
      try { ws.close(); } catch { /* ignore */ }
    }
  }, CONN_TIMEOUT);

  ws.onopen = () => {
    clearTimeout(openTimer);
    if (!settled) recvStatus.value = senderOnline.value
      ? '已连接，对方已在线，等待发送…'
      : '已连接，等待发送端上线…（发送端未连接时无法接收）';
  };

  ws.onmessage = async (ev) => {
    // ---- 文本控制消息 ----
    if (typeof ev.data === 'string') {
      const msg = safeParse(ev.data as string);
      if (!msg) return;

      if ((msg.type === 'peer-joined' && msg.role === 'sender') || msg.type === 'sender-joined') {
        senderOnline.value = true;
        if (!recvFiles.value.length) recvStatus.value = '对方已在线，等待发送…';
      } else if (msg.type === 'offer') {
        // 收到 offer → 对方肯定在线（兜底：即使没收到 peer-joined 也标记在线）
        senderOnline.value = true;
        if (!Array.isArray(msg.files) || msg.files.length === 0) {
          recvStatus.value = '收到无效的文件清单'; return;
        }
        recvFiles.value = msg.files;
        recvTotal = msg.files.reduce((s: number, f: any) => s + (f.size || 0), 0);
        recvBytes = 0;
        // 推算总块数（每块 LOCAL_CHUNK 字节），用于收齐最后一帧自动完成，不再依赖外部 done 信号
        recvTotalChunks = msg.files.reduce((s: number, f: any) => s + Math.max(1, Math.ceil((f.size || 0) / CHUNK)), 0);
        recvChunks = 0;
        // 创建写入 sink（自动选 StreamSaver / Blob 降级），任何异常都被 makeSinks 内部兜住
        try {
          await makeSinks(msg.files);
        } catch (e: any) {
          console.error('[recv] 创建写入通道失败:', e);
          recvStatus.value = `初始化接收失败: ${e?.message || e}`;
          return;
        }
        recvReady.value = true;
        recvStatus.value = recvFallback
          ? `收到 ${msg.files.length} 个文件，开始接收（当前为不安全连接，已切换为浏览器下载模式；大文件建议用 https 访问以获得流式写入）`
          : `收到 ${msg.files.length} 个文件，开始流式接收…`;
        try {
          ws.send(JSON.stringify({ type: 'ready' }));
        } catch { /* ready 发送失败不影响后续 */ }
      } else if (msg.type === 'done') {
        finishRecv();
      } else if (msg.type === 'peer-left') {
        senderOnline.value = false;
        recvStatus.value = '对方已断开';
        receiving.value = false;
      } else if (msg.type === 'rtc-signal') {
        void recvRtc?.onSignal(msg.data);
      }
      return;
    }

    // ---- 二进制数据帧（WS 兜底通道；P2P 直连时由 dc.onmessage 调用同一处理函数）----
    handleRecvFrame(ev.data as ArrayBuffer);
  };

  ws.onclose = () => {
    clearTimeout(openTimer);
    if (!settled) { settled = true; }
    if (!recvReady.value || recvBytes < recvTotal) {
      // 非正常结束（未完成接收）
      recvStatus.value = receiving.value ? '连接意外关闭，接收可能不完整' : '已断开';
    }
    receiving.value = false;
  };
  ws.onerror = () => {
    clearTimeout(openTimer);
    if (!settled) { settled = true; }
    recvStatus.value = '连接出错（中继不可达或被拦截）';
    resetReceiver();
  };
}

async function finishRecv() {
  let allOk = true;
  for (let fi = 0; fi < writers.length; fi++) {
    const w = writers[fi];
    if (!w) { allOk = false; continue; }
    try {
      await w.close();
    } catch (e: any) {
      console.error('[recv] 文件写入关闭失败:', e);
      allOk = false;
    }
  }
  recvStatus.value = allOk ? '接收完成，文件已保存到本机' : '接收完成（部分文件写入失败）';
  receiving.value = false;
  recvReady.value = false;
  writers = [];
}

// P2P DataChannel 收到的分片帧重组：分片头 [totalLen u32][offset u32][payload]，凑齐后交给 handleRecvFrame。
let dcReasm: { total: number; parts: Map<number, Uint8Array>; received: number } | null = null;
function onDcMessage(ev: any) {
  if (typeof ev.data === 'string') return; // DC 只传二进制帧，文本不应出现
  try {
    const buf = ev.data as ArrayBuffer;
    if (buf.byteLength < 8) return;
    const dv = new DataView(buf);
    const total = dv.getUint32(0);
    const off = dv.getUint32(4);
    const payload = new Uint8Array(buf, 8); // 子视图，需复制避免 buf 被回收
    const copy = new Uint8Array(payload.length);
    copy.set(payload);
    if (!dcReasm || dcReasm.total !== total) {
      // 新帧开始（若上一帧异常未收完则丢弃旧片段）
      dcReasm = { total, parts: new Map(), received: 0 };
    }
    dcReasm.parts.set(off, copy);
    dcReasm.received += copy.length;
    if (dcReasm.received >= total) {
      const full = new Uint8Array(total);
      let pos = 0;
      const keys = Array.from(dcReasm.parts.keys()).sort((a, b) => a - b);
      for (const k of keys) { const p = dcReasm.parts.get(k)!; full.set(p, pos); pos += p.length; }
      dcReasm = null;
      handleRecvFrame(full.buffer);
    }
  } catch (e: any) {
    console.error('[recv] DC 分片重组失败:', e);
    dcReasm = null;
  }
}

// 二进制数据帧处理：WS 兜底通道与 P2P DataChannel 共用同一函数，避免逻辑分叉。
function handleRecvFrame(data: ArrayBuffer) {
  try {
    const frame = new Uint8Array(data);
    if (frame.length < FRAME_HDR) { recvStatus.value = '收到过短的数据帧'; return; }
    const dv = new DataView(frame.buffer);
    const fi = dv.getUint16(0);
    if (fi === 0xFFFF) { finishRecv(); return; } // 发送端经 DataChannel 发的结束标记
    const ci = dv.getUint32(2);
    const plainLen = dv.getUint32(6);
    const body = frame.slice(FRAME_HDR);
    // 边界检查（writer 数组已按文件数预建，只需校验文件索引）
    if (fi >= writers.length) {
      console.warn(`[recv] 文件索引越界: fi=${fi}, max=${writers.length - 1}`);
      return;
    }
    const plain = safeDecrypt(body, recvKey, plainLen);
    const w = writers[fi];
    if (w) {
      w.write(plain).catch((we: any) => console.error('[recv] 写入失败:', we));
    }
    recvBytes += plain.length;
    recvProgress.value = recvTotal ? recvBytes / recvTotal : 1;
    // 自愈：收齐最后一帧即自动完成（覆盖 done/EOF 信号丢失的情况）
    recvChunks++;
    if (recvTotalChunks > 0 && recvChunks >= recvTotalChunks) finishRecv();
  } catch (e: any) {
    console.error('[recv] 数据帧处理失败:', e);
    recvStatus.value = `数据帧错误: ${e?.message || e}`;
    // 不中断接收，继续尝试后续帧（单个坏块不应终止整个传输）
  }
}

// ================================================================
//  生命周期
// ================================================================
onUnmounted(() => {
  closeSenderWs();
  closeReceiverWs();
});
</script>

<template>
  <div class="local">
    <!-- 发送 -->
    <section class="blk" v-if="!props.side || props.side === 'send'">
      <h3>① 发送（本地直传）</h3>
      <p class="hint">文件只在内存里经网站流转，不落服务器磁盘；双方需同时在线，关闭即止。</p>
      <input type="file" multiple @change="pick" :disabled="sending" />
      <div v-if="sendFiles.length" class="filelist">
        <div v-for="f in sendFiles" :key="f.name" class="frow">
          <span>{{ f.name }}</span><span class="sz">{{ fmt(f.size) }}</span>
        </div>
        <div class="total">共 {{ sendFiles.length }} 个 · {{ fmt(sendTotal) }}</div>
      </div>

      <div v-if="!room" class="actions">
        <button class="btn primary" :disabled="!sendFiles.length" @click="genRoom">生成直传房间</button>
      </div>
      <div v-else class="roominfo">
        <div class="code">房间码：<b>{{ room }}</b></div>
        <div class="link">
          <input :value="sendLink" readonly />
          <button class="btn sm" @click="copyLink">复制链接</button>
        </div>
        <div class="presence">
          <span class="dot" :class="{ on: peerOnline }"></span>
          对方（接收端）：{{ peerOnline ? '已在线 ✓' : '等待加入…' }}
        </div>
        <div class="actions">
          <button class="btn primary" :disabled="sending || sendDone || !peerOnline" @click="startSend">
            {{ sending ? '传输中…' : sendDone ? '已完成' : (peerOnline ? '开始传输' : '等待对方加入…') }}
          </button>
        </div>
        <div v-if="sending || sendDone" class="bar">
          <div class="fill" :style="{ width: (sendProgress * 100) + '%' }"></div>
        </div>
      </div>
      <div class="status">{{ sendStatus }}</div>
    </section>

    <hr v-if="!props.side" />

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
        <span class="transport" :class="{ p2p: recvRtcOpen }">{{ recvRtcOpen ? 'P2P 直连' : '经中继转发' }}</span>
      </div>
      <div class="actions">
        <button class="btn primary" :disabled="receiving || recvReady" @click="startRecv">连接接收</button>
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
    </section>
  </div>
</template>

<style scoped>
.local { display: flex; flex-direction: column; gap: 8px; }
.blk { display: flex; flex-direction: column; gap: 10px; }
.hint { font-size: 12.5px; color: var(--text-dim); margin: 0; }
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
.transport.p2p { color: #2ecc71; border-color: rgba(46, 204, 113, 0.4); }
input[type=file] { font-size: 13px; color: var(--text-dim); }
</style>
