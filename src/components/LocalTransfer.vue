<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import {
  deriveKey, randomPassphrase,
  LOCAL_SALT, LOCAL_CHUNK_SIZE,
} from '@/crypto/e2ee';
import { createWebRTC, fetchIceServers } from '@/composables/useWebRTC';
import { decryptChunkAsync } from '@/composables/useLocalCrypto';

// 由父组件（发送/接收面板）指定渲染哪一侧；不传则两侧都渲染
const props = defineProps<{ side?: 'send' | 'receive' }>();

// ---------- 常量 ----------
const CHUNK = LOCAL_CHUNK_SIZE;          // 加密前分片大小（明文）
// 加密后单帧 ≈ 896KB + 16(IV) + ≤16(PKCS7) + 32(HMAC) + 12(帧头) ≈ 897KB，低于 Cloudflare DO 的 1MB WebSocket 上限
const FRAME_HDR = 12;                    // 帧头：fi(u16) + ci(u32) + plainLen(u32)
// Cloudflare DO WebSocket 消息上限 1 MB（≈1,000,000 字节），需留余量
const CONN_TIMEOUT = 10000;             // 连接超时 ms

// 默认线上中转（Cloudflare Worker，WSS）。可用构建时 VITE_RELAY_URL=xxx 覆盖。
const RELAY_DEFAULT = 'flashdrop-relay.315461.xyz';
function resolveRelay() {
  const host = (import.meta as any).env?.VITE_RELAY_URL || RELAY_DEFAULT;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
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
  // ss.supported 为 false 表示 Service Worker 不可用（如非安全上下文/被禁用）：
  // 即使 sw.js 存在也无法注册，此时必须降级 Blob，否则数据会静默丢失。
  if (ss && ss.supported !== false) {
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
//  接收方
// ================================================================

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
let finishing = false;            // 防止 done/EOF/收齐 多处触发重复关流
// 端到端流量控制：接收端监视自身「已解密未写盘」的积压字节，
// 超过高水位发 pause、回落低水位发 resume，驱动发送端减速/恢复。
// 这样写盘速度直接决定整体吞吐，全程平滑、不震荡、不归零、不丢帧。
const RECV_PAUSE_BYTES = 16 * 1024 * 1024; // 高水位：积压 >16MB 即通知发送端暂停
const RECV_RESUME_BYTES = 4 * 1024 * 1024;  // 低水位：积压 <4MB 才恢复（迟滞避免抖动）
let recvPaused = false;            // 当前是否已通知发送端暂停
let recvReceived = 0;             // 已解密、进入流水线的字节数（含已写盘）
let recvAborted = false;          // 收到发送端 cancel 后置位，正在跑的 processFrame 会中途退出
// —— 并发解密 + 保序写盘（接收端流水线，根治「接收端慢拖垮整体」）——
let perFileChunks: number[] = [];   // 每文件帧数（offer 时推算），用于把 (fi,ci) 映射成全局序号
let nextWriteSeq = 0;               // 下一个待写盘的全局帧序号（严格递增，保证文件不乱序）
const readyBuf = new Map<number, { fi: number; plain: Uint8Array }>(); // 解密完成、等待落盘的帧（按序号）
let drainRunning = false;           // 写盘协程是否运行中（防止并发 write 导致 WritableStream 报错）
let eofReceived = false;            // 收到发送端经 DataChannel 发的结束标记
let pendingDone = false;            // 收到 done 控制消息
// 防御性缓冲：writers 尚未建好（setup 进行中 / 中继把数据帧先于 offer 送达）时，
// 把二进制数据帧暂存，等 setup 完成后再回放，避免命中「文件索引越界」直接丢帧（之前 max=-1 卡死的根因）。
let preSetupFrames: ArrayBuffer[] = [];
let preSetupBytes = 0;
const PRE_SETUP_CAP = 256 * 1024 * 1024; // 暂存上限 256MB，超出则丢弃最早期帧（防内存爆）

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
  recvReceived = 0; recvPaused = false;
  perFileChunks = []; nextWriteSeq = 0; readyBuf.clear(); drainRunning = false;
  eofReceived = false; pendingDone = false;
  preSetupFrames = []; preSetupBytes = 0;
  dcReasm = null;
  if (recvRtc) { try { recvRtc.destroy(); } catch { /* ignore */ } recvRtc = null; }
  recvRtcOpen.value = false;
}
/** 安全关闭接收端 WS */
function closeReceiverWs() {
  if (recvWs) { try { recvWs.close(); } catch { /* ignore */ } recvWs = null; }
  if (recvRtc) { try { recvRtc.destroy(); } catch { /* ignore */ } recvRtc = null; }
  recvRtcOpen.value = false;
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
  // 诊断开关：URL 带 ?force=relay 时跳过 P2P，强制只走中继（与发送端保持一致）
  try { rIce = await fetchIceServers(relayHost, proto); } catch { rIce = []; }
  if (new URLSearchParams(location.search).get('force') === 'relay') {
    recvStatus.value = '诊断模式：已禁用 P2P，强制走中继';
  } else {
  recvRtc = createWebRTC({
    role: 'receiver',
    iceServers: rIce,
    sendSignal: (m) => { if (recvWs && recvWs.readyState === WebSocket.OPEN) recvWs.send(JSON.stringify(m)); },
    onDataChannel: (dc) => { dc.onmessage = onDcMessage; },
    onState: (open) => { recvRtcOpen.value = open; },
  });
  }

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
        // 每文件帧数（用于把 (fi,ci) 映射成全局写盘序号，保证多文件不乱序）
        perFileChunks = msg.files.map((f: any) => Math.max(1, Math.ceil((f.size || 0) / CHUNK)));
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
        // 回放 setup 前暂存的早期数据帧（中继乱序场景），避免丢帧
        if (preSetupFrames.length) {
          const buf = preSetupFrames; preSetupFrames = []; preSetupBytes = 0;
          for (const f of buf) handleDataFrame(f);
        }
        recvStatus.value = recvFallback
          ? `收到 ${msg.files.length} 个文件，开始接收（当前为不安全连接，已切换为浏览器下载模式；大文件建议用 https 访问以获得流式写入）`
          : `收到 ${msg.files.length} 个文件，开始流式接收…`;
        try {
          ws.send(JSON.stringify({ type: 'ready' }));
        } catch { /* ready 发送失败不影响后续 */ }
      } else if (msg.type === 'done') {
        pendingDone = true;
        void drainWrites();   // 排空后若已收齐全部帧则完成
      } else if (msg.type === 'peer-left') {
        senderOnline.value = false;
        recvStatus.value = '对方已断开';
        receiving.value = false;
      } else if (msg.type === 'cancel') {
        // 发送端主动取消：中断接收、丢弃已落盘的部分数据、回到初始等待状态
        onCancelRecv();
      } else if (msg.type === 'rtc-signal') {
        void recvRtc?.onSignal(msg.data);
      }
      return;
    }

    // ---- 二进制数据帧（WS 兜底通道；P2P 直连时由 dc.onmessage 调用同一处理函数）----
    handleDataFrame(ev.data as ArrayBuffer);
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
  if (finishing) return;
  finishing = true;
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

// P2P DataChannel 收到的分片帧重组：分片头 [totalLen u32][offset u32][payload]，凑齐后交给 enqueueRecv。
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
      handleDataFrame(full.buffer);
    }
  } catch (e: any) {
    console.error('[recv] DC 分片重组失败:', e);
    dcReasm = null;
  }
}

// ================================================================
//  接收端核心：并发解密 + 保序写盘流水线
//  旧实现（recvChain 串行 await decryptChunkAsync）的瓶颈：单 Worker 解密是串行的，
//  每帧必须等解密完才处理下一帧，接收端吞吐被锁死在「单 Worker 解密速度」，
//  进而触发发送端流控暂停 → 整体速度被接收端拖死。
//  新实现：帧到达即丢进 Worker 池并发解密（多个帧同时在多个 Worker 跑），
//  解密完按全局序号入 readyBuf，单一写盘协程串行 await 写盘（保证不乱序）。
//  解密与写盘真正重叠——写盘时后续帧已在 Worker 里解密。
// ================================================================

/** (fi, ci) → 全局递增序号（保证多文件、多块严格有序写盘） */
function frameSeq(fi: number, ci: number): number {
  let s = 0;
  for (let i = 0; i < fi; i++) s += perFileChunks[i] || 0;
  return s + ci;
}

/** 任意通道（WS 兜底 / P2P DataChannel 重组后）收到一帧的入口：立即并发解密，不阻塞其他帧 */
function handleDataFrame(data: ArrayBuffer) {
  if (recvAborted) return;
  // 防御：writers 尚未建好（setup 进行中 / 中继乱序导致数据帧先于 offer 送达）时，
  // 先把整帧（复制底层 buffer，防被回收）暂存，等 setup 完成后再回放，避免命中
  // 「文件索引越界」直接丢帧——这正是之前「下到 0.9MB 卡死」(max=-1) 的根因。
  if (writers.length === 0) {
    if (data.byteLength + preSetupBytes > PRE_SETUP_CAP) {
      console.warn('[recv] setup 前暂存超限，丢弃最早的一批早期帧');
      preSetupFrames = preSetupFrames.slice(1);
    }
    preSetupFrames.push(data.slice(0));
    preSetupBytes += data.byteLength;
    return;
  }
  const frame = new Uint8Array(data);
  if (frame.length < FRAME_HDR) { recvStatus.value = '收到过短的数据帧'; return; }
  const dv = new DataView(frame.buffer);
  const fi = dv.getUint16(0);
  if (fi === 0xFFFF) { onRecvEof(); return; } // 发送端经 DataChannel 发的结束标记
  const ci = dv.getUint32(2);
  const plainLen = dv.getUint32(6);
  const body = frame.subarray(FRAME_HDR);
  // ⚠️ body.buffer 可能是整个底层 ArrayBuffer（含帧头），必须按 byteOffset/length 切出只属于 body 的 ArrayBuffer，
  // 否则 Worker 端会把 12B 帧头也当密文解密 → HMAC 校验失败或文件损坏。
  const bodyBuf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  if (fi >= writers.length) {
    console.warn(`[recv] 文件索引越界: fi=${fi}, max=${writers.length - 1}`);
    return;
  }
  const seq = frameSeq(fi, ci);
  // 并发解密（Worker 池自动负载均衡），不 await —— 让后续帧也能立刻开始解密
  decryptChunkAsync(bodyBuf, recvKey, plainLen)
    .then((plainBuf) => {
      if (recvAborted) return;             // 已取消则丢弃此块
      recvReceived += (plainBuf as ArrayBuffer).byteLength;
      readyBuf.set(seq, { fi, plain: new Uint8Array(plainBuf) });
      void drainWrites();                   // 尝试推进写盘（背压判断见 drainWrites 末尾）
    })
    .catch((e: any) => {
      console.error('[recv] 解密失败:', e);
      recvStatus.value = `数据帧错误: ${e?.message || e}`;
    });
}

/** 收到发送端经 DataChannel 发的结束标记（WS 通道的 done 由消息分支处理） */
function onRecvEof() {
  eofReceived = true;
  void drainWrites();
}

/** 串行写盘协程：按全局序号顺序把 readyBuf 里的帧写入对应文件 writer。
 *  单协程运行（drainRunning 防重入），保证 WritableStream 不被并发 write。 */
async function drainWrites() {
  if (drainRunning) return;
  drainRunning = true;
  try {
    while (readyBuf.has(nextWriteSeq)) {
      const item = readyBuf.get(nextWriteSeq)!;
      readyBuf.delete(nextWriteSeq);
      const w = writers[item.fi];
      if (w) {
        try { await w.write(item.plain); }
        catch (we: any) { console.error('[recv] 写入失败:', we); }
      }
      recvBytes += item.plain.length;
      recvProgress.value = recvTotal ? recvBytes / recvTotal : 1;
      nextWriteSeq++;
    }
    // 端到端背压：根据「已收未写盘」积压决定通知发送端暂停/恢复。
    // 写盘是最慢环节，由它直接驱动发送端速度 → 吞吐平滑、不震荡、不归零。
    const backlog = recvReceived - recvBytes;
    if (!recvPaused && backlog >= RECV_PAUSE_BYTES) {
      recvPaused = true;
      try { recvWs?.send(JSON.stringify({ type: 'pause', src: 'recv' })); } catch {}
    } else if (recvPaused && backlog <= RECV_RESUME_BYTES) {
      recvPaused = false;
      try { recvWs?.send(JSON.stringify({ type: 'resume', src: 'recv' })); } catch {}
    }
    // 收齐全部帧 → 完成（done/EOF 信号丢失也能自愈）
    if (recvTotalChunks > 0 && nextWriteSeq >= recvTotalChunks) {
      await finishRecv();
    }
  } finally {
    drainRunning = false;
  }
}

// 发送端取消：丢弃所有排队帧、中断落盘、回到初始等待状态
function onCancelRecv() {
  recvAborted = true;                 // 让正在跑的解密任务完成后丢弃、不写盘
  readyBuf.clear();                   // 丢弃已解密待写盘的帧
  for (const w of writers) { try { w.abort(); } catch { /* ignore */ } }
  writers = [];
  recvAborted = false;                // 复位以便下次接收
  resetReceiver();
  recvStatus.value = '对方已取消发送，已重置为初始状态，可重新接收';
}

// ================================================================
//  生命周期
// ================================================================
onUnmounted(() => {
  closeReceiverWs();
});
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
.transport.p2p { color: #2ecc71; border-color: rgba(46, 204, 113, 0.4); }
input[type=file] { font-size: 13px; color: var(--text-dim); }
</style>
