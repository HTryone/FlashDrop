<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import type { QueuedFile, StorageType } from '@/types/transfer';
import { createTransfer, refreshCode, setMessage, terminateTransfer, zipUrl } from '@/api/transfer';
import { uploadAll } from '@/composables/useTusUpload';
import { newSalt, E2EE_CHUNK_SIZE, randomPassphrase, deriveKey, LOCAL_SALT, LOCAL_CHUNK_SIZE } from '@/crypto/e2ee';
import { encryptChunkAsync } from '@/composables/useLocalCrypto';
import SendFileRow from './SendFileRow.vue';

const emit = defineEmits<{
  (e: 'gotLoginCode', code: string): void;
}>();

// 发送方式：中转发送（带分享码/登录码/有效期/口令）| 本地直传（HTTP 流式实时，无有效期/口令）
const sendMode = ref<'relay' | 'local'>('relay');

const files = ref<QueuedFile[]>([]);
const message = ref('');
// E2EE 始终开启，不可关闭
const passphrase = ref(randomPassphrase());
// 有效期（小时）：分享码 / 登录码 / 文件统一过期
const TTL_OPTIONS = [
  { label: '1 小时', value: 1 },
  { label: '24 小时', value: 24 },
  { label: '3 天', value: 72 },
  { label: '7 天', value: 168 },
];
const ttlHours = ref(24);

const transferId = ref('');
const code = ref('');
const loginCode = ref('');       // 16 位登录码（带空格展示）
const storage = ref<StorageType>('local');
const started = ref(false);
const uploading = ref(false);
const dragOver = ref(false);
const error = ref('');

// 取消分享弹窗
const showTerminateDialog = ref(false);

// ========== 本地直传（HTTP 流式中继）==========
const LOCAL_CHUNK = LOCAL_CHUNK_SIZE;
const FRAME_HDR = 12;
const RELAY_DEFAULT = 'flashdrop-relay.315461.xyz';
function resolveRelayBase() {
  const host = (import.meta as any).env?.VITE_RELAY_URL || RELAY_DEFAULT;
  return `https://${host}`;
}

const lRoom = ref('');
const lPassphrase = ref('');
const lSendLink = ref('');
const lKeyHex = ref('');
const lSending = ref(false);
const lDone = ref(false);
const lProgress = ref(0);
const lStatus = ref('');
const lPeerOnline = ref(false);
let lAbort: AbortController | null = null;
let lPollTimer: ReturnType<typeof setTimeout> | null = null;
let lWs: WebSocket | null = null;
let lWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lWsReadyNotified = false;

function resetLocalSender() {
  lSending.value = false; lDone.value = false;
  lProgress.value = 0; lPeerOnline.value = false;
  // 滑动窗口状态归零，避免重传时旧 ack/sent 残留导致闸门误判
  ackBytes = 0; sentBytes = 0; ackWaiters = [];
  lRecvReady.value = false;
}

function cancelLocalSend() {
  if (!lSending.value) return;
  if (lAbort) { try { lAbort.abort(); } catch {} }
  lStatus.value = '已取消发送，可重新传输';
  resetLocalSender();
}

function closeLocalConn() {
  if (lAbort) { try { lAbort.abort(); } catch {} lAbort = null; }
  if (lPollTimer) { clearTimeout(lPollTimer); lPollTimer = null; }
  if (lWsReconnectTimer) { clearTimeout(lWsReconnectTimer); lWsReconnectTimer = null; }
  if (lWs) { try { lWs.close(); } catch {} lWs = null; }
  lWsReadyNotified = false;
}

/** 长度前缀编码：[4B u32 长度][payload] */
function encodeMsg(payload: Uint8Array): Uint8Array {
  const hdr = new Uint8Array(4);
  new DataView(hdr.buffer).setUint32(0, payload.length, false);
  const out = new Uint8Array(hdr.length + payload.length);
  out.set(hdr, 0);
  out.set(payload, hdr.length);
  return out;
}

function genRoom() {
  closeLocalConn(); resetLocalSender();
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; const a = new Uint8Array(6); crypto.getRandomValues(a);
  for (let i = 0; i < 6; i++) s += cs[a[i] % cs.length];
  lRoom.value = s; lPassphrase.value = randomPassphrase();
  lRecvReady.value = false;
  lSendLink.value = `${location.origin}/?tab=local&room=${s}#k=${lPassphrase.value}`;
  lStatus.value = '房间已生成，正在建立控制通道…';
  void connectControl();
}

// 端到端滑动窗口状态（顶层作用域：控制通道 onmessage 与发送流 pull 共享）
// 只控「在途字节量」(已发-已确认)，绝不控速率，天然免疫 ~8s 速率信号异位 → 消除震荡
const WINDOW = 16 * 1024 * 1024;   // 在途上限 16MB：配合 POST_LIMIT=8MB 高速分片，窗口比原24MB收紧以抑制突发过冲，ack 50ms 实时感知
let ackBytes = 0;                  // 接收端已写盘字节（来自 WS progress.received）
let sentBytes = 0;                 // 已 enqueue 进 POST body 流的字节
let ackWaiters: Array<() => void> = [];
function notifyAckWaiters() { const w = ackWaiters.shift(); if (w) w(); }

// 接收端「创建下载」闸门：接收端建好下载流(StreamSaver sink)后才允许发数据帧，
// 否则接收端 GET 已连但下载流未就绪 → 数据在 DO 堆积 → OOM。offer 首帧不受限（接收端要先读它来建下载）。
const lRecvReady = ref(false);
let recvReadyResolve: (() => void) | null = null;
let recvReadyPromise: Promise<void> = Promise.resolve();
function armRecvReady() {
  if (lRecvReady.value) return;               // 已收到 recv-ready 则无需重等
  recvReadyPromise = new Promise<void>((res) => { recvReadyResolve = res; });
}

/** WebSocket 控制通道：保持 DO 活跃，避免 HTTP 请求间 hibernate 丢失 room */
function connectControl() {
  if (!lRoom.value || lWs) return;
  const wsUrl = resolveRelayBase().replace(/^https:/, 'wss:') + `/ws/${lRoom.value}?role=sender`;
  try {
    const ws = new WebSocket(wsUrl);
    lWs = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      lStatus.value = '控制通道已连接，等待对方加入…';
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'ready' && !lWsReadyNotified) {
          lWsReadyNotified = true;
          lPeerOnline.value = true;
          lStatus.value = '对方已在线，可开始传输';
        } else if (data.type === 'pull' || data.type === 'recv-ready') {
          // pull = relay 权威信号：接收端 GET 已连上，可安全推数据（不会成孤儿）
          // recv-ready = 接收端应用层备份信号（GET 连上后由接收端发出）。二者任一即放行。
          lRecvReady.value = true;
          recvReadyResolve?.();
          recvReadyResolve = null;
        } else if (data.type === 'progress') {
          // 接收端真实已收进度（明文口径，与发送端 total 同源，比例零偏差）
          const t = data.total || 1;
          lProgress.value = Math.min(1, (data.received || 0) / t);
          // 滑动窗口：用接收端已写盘字节更新 ack，唤醒被闸门挡住的 pull
          ackBytes = data.received || 0;
          notifyAckWaiters();
        } else if (data.type === 'recv-done' && !lDone.value) {
          // 接收端确已收齐写盘 → 发送端才标记完成（两端状态一致）
          lDone.value = true;
          lProgress.value = 1;
          lSending.value = false;
          lStatus.value = '传输完成';
        }
      } catch {}
    };
    ws.onerror = (ev) => {
      if (!lWsReadyNotified) {
        lStatus.value = '控制通道出错，尝试 HTTP 兼容通道…';
        void pollReceiverReady();
      }
    };
    ws.onclose = (ev) => {
      if (lWs === ws) lWs = null;
      // 只有曾经成功打开过的连接才自动重连，避免初始失败时死循环
      if (opened && !lWsReadyNotified && !lSending.value) {
        lStatus.value = '控制通道断开，3秒后重连…';
        lWsReconnectTimer = setTimeout(() => void connectControl(), 3000);
      }
    };
  } catch (e: any) {
    lStatus.value = `控制通道失败: ${e?.message || e}`;
    void pollReceiverReady();
  }
}

/** HTTP 长轮询兜底（本地开发用，Cloudflare 上需要 WebSocket 保活） */
async function pollReceiverReady() {
  if (!lRoom.value || lWsReadyNotified) return;
  const base = resolveRelayBase();
  try {
    const resp = await fetch(`${base}/stream/${lRoom.value}/ready?t=${Date.now()}`, { mode: 'cors' });
    if (resp.ok && !lWsReadyNotified) {
      lWsReadyNotified = true;
      lPeerOnline.value = true;
      lStatus.value = '对方已在线，可开始传输';
      return;
    }
  } catch {}
  lPollTimer = setTimeout(() => void pollReceiverReady(), 2000);
}


async function startLocalSend() {
  if (!lRoom.value || !lPassphrase.value) { lStatus.value = '请先生成房间'; return; }
  if (!lPeerOnline.value) { lStatus.value = '对方尚未加入，请等待'; return; }
  if (!files.value.length) { lStatus.value = '没有待发送文件'; return; }

  try { lKeyHex.value = await deriveKey(lPassphrase.value, LOCAL_SALT); }
  catch (e: any) { lStatus.value = `密钥派生失败: ${e?.message || e}`; return; }

  lSending.value = true; lProgress.value = 0;
  lStatus.value = '正在确认控制通道…';
  lAbort = new AbortController();
  // 重置滑动窗口 + 接收端就绪闸门（防上一次传输残留导致闸门误判；recv-ready 已到则保持无需重等）
  ackBytes = 0; sentBytes = 0; ackWaiters = [];
  armRecvReady();

  // 关键：确保 WebSocket 控制通道还活着（DO 靠 WS 保活，否则 hibernate 会丢 rooms 状态，
  // 导致 POST 和 GET 连到不同的 TransformStream 实例 → 接收端 EOF at header）
  if (!lWs || lWs.readyState !== WebSocket.OPEN) {
    lStatus.value = '控制通道已断开，正在重连…';
    connectControl();
    // 等待 WS 重连 + 对端 ready
    await new Promise<void>((resolve) => {
      const check = () => {
        if (lWs && lWs.readyState === WebSocket.OPEN && lWsReadyNotified) resolve();
        else setTimeout(check, 200);
      };
      setTimeout(check, 200);
    });
  }

  const base = resolveRelayBase();
  // Cloudflare POST 请求体限制 100MB；本地 relay 无此限制。
  // 实测证据（2026-07-29 浏览器打线上 relay 隔离实验）：Chrome→CF 链路对流式 POST 请求体
  // 是「整段缓冲、POST 关闭才向 DO 转发」——发 5MB 挂住不关 8 秒接收端 0 字节，一关全到。
  // 因此 POST 分片必须显著小于滑动窗口，否则互锁死。为消除「忽快忽慢」震荡，把分片从 8MB 降到 2MB：
  // 每个分片关闭→转发→接收→ack 的周期更短，速度脉冲块更小、频率更高，宏观上更平滑。
  // 2MB 分片配合 8MB 窗口（≥4 个分片流水线）已实测不卡死。
  const POST_LIMIT = 8 * 1024 * 1024;   // 回到 8MB 高速分片（用户要求"尽量保证高速"）：分片大→Chrome→CF「关闭才转发」开销少→吞吐高；震荡靠 WINDOW=16MB+ack50ms 抑制

  // ---- 流式分片 POST（核心修复）----
  // 旧逻辑：攒满 80MB 一次性 fetch POST 大 body → 大请求体在代理/Cloudflare 链路上被丢弃，
  //         接收端只收到 OPTIONS 预检、永远收不到数据体（表现为「未收到文件清单 / EOF at header」）。
  // 新逻辑：producer 异步加密产生帧入队，postOneChunk 顺序发起每个分片 ReadableStream POST，
  //         边产生边上传（不再缓冲 80MB 大 body），浏览器原生背压限流，relay 端 req.pipe 原生转发。
  let pending: Uint8Array[] = [];
  let producerDone = false;
  let waiters: Array<() => void> = [];
  let chunkBytes = 0;
  let firstFrameResolve: (() => void) | null = null;
  let firstFrameReject: ((e: any) => void) | null = null;

  function pushFrame(f: Uint8Array) {
    const wasEmpty = pending.length === 0;
    pending.push(f);
    if (wasEmpty && firstFrameResolve) { firstFrameResolve(); firstFrameResolve = null; }
    const w = waiters.shift(); if (w) w();
  }
  function notifyDrain() {
    const w = waiters.shift(); if (w) w();
  }
  async function waitFrame(): Promise<void> {
    if (pending.length > 0) return;
    await new Promise<void>((res) => waiters.push(res));
  }

  // 发送一个分片（一个 ReadableStream POST）；返回 false 表示全部发完
  async function postOneChunk(): Promise<boolean> {
    chunkBytes = 0;
    const rs = new ReadableStream({
      start(ctrl) {
        // 关键：duplex:'half' 的 body 必须创建时就有数据，Chrome 才会立即发起 HTTP 请求。
        // 若等第一次 pull 再 enqueue，可能形成死锁：浏览器不发起请求 → 不 pull → 没数据。
        if (pending.length === 0) {
          console.warn('[send] postOneChunk start with empty pending');
          return;
        }
        const frame = pending.shift()!;
        notifyDrain();
        ctrl.enqueue(frame);
        sentBytes += frame.length;
        chunkBytes += frame.length;
        console.log('[send] first frame enqueued', frame.length, 'chunkBytes', chunkBytes);
      },
      async pull(ctrl) {
        // 滑动窗口闸门：在途量超窗则等待接收端 ack（字节累计量不过期，不会像速率信号那样相位错）
        while (sentBytes - ackBytes > WINDOW) {
          console.log('[send] window gate', sentBytes, ackBytes, sentBytes - ackBytes);
          await new Promise<void>((res) => ackWaiters.push(res));
        }
        if (pending.length === 0) {
          if (producerDone) { ctrl.close(); return; }
          console.log('[send] pull waiting for frame');
          await waitFrame();
          if (pending.length === 0) {
            if (producerDone) { ctrl.close(); return; }
            console.log('[send] pull still no frame, return');
            return; // 浏览器会再次调用 pull
          }
        }
        const frame = pending.shift()!;
        notifyDrain();
        ctrl.enqueue(frame);
        sentBytes += frame.length;   // 修复：累加已发字节，使滑动窗口闸门真正生效
        chunkBytes += frame.length;
        console.log('[send] frame enqueued', frame.length, 'chunkBytes', chunkBytes, 'pending', pending.length);
        if (chunkBytes >= POST_LIMIT) { ctrl.close(); return; }
      },
    });
    const resp = await fetch(`${base}/stream/${lRoom.value}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: rs,
      duplex: 'half',
      signal: lAbort!.signal,
    } as any);
    if (!resp.ok) throw new Error(`上传失败 HTTP ${resp.status}`);
    return !(producerDone && pending.length === 0);
  }

  // 数据全部发完后，单独发一个空 POST 到 /close 关闭流
  // （Worker 的 /close 处理器关闭 writable → 接收端 GET 流收到 EOF = 传输完成）
  async function sendClose() {
    try {
      await fetch(`${base}/stream/${lRoom.value}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(0),
        signal: lAbort!.signal,
      });
    } catch (e: any) {
      if (lAbort?.signal.aborted) throw e;
      throw new Error(`关闭流失败: ${e?.message || e}`);
    }
  }

  try {
    // 1. 单独发 offer（文件清单）POST；必须在 ReadableStream 之外等 recv-ready，
    //    否则在 pull 里阻塞等 recv-ready 会导致 HTTP body 长时间不流动，浏览器/Cloudflare 直接 abort fetch → Failed to fetch。
    const offerJson = JSON.stringify({
      type: 'offer',
      files: files.value.map(f => ({ name: f.file.name, size: f.file.size })),
    });
    const offerBytes = new TextEncoder().encode(offerJson);
    const offerFrame = encodeMsg(offerBytes);
    async function postOffer() {
      const rs = new ReadableStream({
        start(ctrl) { ctrl.enqueue(offerFrame); ctrl.close(); }
      });
      const resp = await fetch(`${base}/stream/${lRoom.value}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: rs,
        duplex: 'half',
        signal: lAbort!.signal,
      } as any);
      if (!resp.ok) throw new Error(`上传 offer 失败 HTTP ${resp.status}`);
    }
    await postOffer();
    lStatus.value = '已发送文件清单，等待对方创建下载…';

    const mapped = files.value.map(f => ({ file: f.file }));
    const total = mapped.reduce((s, f) => s + f.file.size, 0);
    if (total === 0) {
      await sendClose();
      lDone.value = true; lStatus.value = '传输完成（空）'; lSending.value = false;
      return;
    }

    // 等接收端 GET 连上（relay 发 pull 权威信号）或接收端应用层 recv-ready 备份信号。
    // 二者任一即放行——此时接收端 GET 一定已就绪，推送数据不会成孤儿。
    // 超时（默认 20s）则直接报错终止：对方多半未点「连接接收」或页面已关，盲推只会造孤儿。
    try {
      await Promise.race([
        recvReadyPromise,
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('对方未开始接收（20s 超时）')), 20000)),
      ]);
    } catch (e: any) {
      lStatus.value = `无法开始传输：${e?.message || e}。请确认对方已点「连接接收」且页面未关闭。`;
      lSending.value = false;
      return;
    }
    lStatus.value = '对方已就绪，开始传输数据…';

    // 生产者：逐块加密入队
    let frameLogCount = 0;
    const producer = (async () => {
      console.log('[send] producer start');
      try {
      for (let fi = 0; fi < mapped.length; fi++) {
        const file = mapped[fi].file; let offset = 0; let ci = 0;
        while (offset < file.size) {
          const end = Math.min(offset + LOCAL_CHUNK, file.size);
          console.log('[send] slicing', file.name, offset, end);
          const chunkBuf = await file.slice(offset, end).arrayBuffer();
          console.log('[send] slice ok', chunkBuf.byteLength);
          const plainLen = chunkBuf.byteLength;
          console.log('[send] encrypting...');
          const enc = new Uint8Array(await encryptChunkAsync(chunkBuf, lKeyHex.value));
          console.log('[send] encrypted', enc.length);
          // 帧头：fi u16 + ci u32 + plainLen u32
          const frame = new Uint8Array(FRAME_HDR + enc.length);
          const dv = new DataView(frame.buffer);
          dv.setUint16(0, fi); dv.setUint32(2, ci); dv.setUint32(6, plainLen);
          frame.set(enc, FRAME_HDR);
          pushFrame(encodeMsg(frame));
          frameLogCount++;
          if (frameLogCount <= 3) console.log('[send] pushed frame', fi, ci, 'pending', pending.length);
          // 简单背压：在途帧过多则等待消费
          while (pending.length > 300) { await new Promise<void>((r) => waiters.push(r)); }
          offset += plainLen; ci++;
        }
      }
      producerDone = true;
      notifyDrain();
      console.log('[send] producer done');
      } catch (e: any) {
        console.error('[send] producer error:', e);
        if (firstFrameReject) { firstFrameReject(e); firstFrameReject = null; }
        throw e;
      }
    })();

    // 关键：等 producer 生产出第一帧，再启动 consumer。
    // 这样 ReadableStream 的 start() 能立即 enqueue 数据，触发 Chrome 立即发起 HTTP 请求。
    console.log('[send] waiting for first frame');
    await new Promise<void>((res, rej) => { firstFrameResolve = res; firstFrameReject = rej; });
    firstFrameReject = null;
    console.log('[send] first frame ready, start consumer');

    // 消费者：顺序发起每个分片流式 POST，直到 producer 完成且无待发帧
    let more = true;
    while (more) {
      console.log('[send] postOneChunk loop, pending', pending.length, 'producerDone', producerDone);
      more = await postOneChunk();
    }
    await producer;
    await sendClose();
    // 不立即标记完成：真正完成以接收端 recv-done 为准（见 onmessage 的 recv-done 分支），
    // 这样发送端「完成态」= 接收端确已收齐写盘，两端状态永远一致。
    lStatus.value = '文件已发送，等待对方接收完成…';
    // 兜底超时：30s 内未收到 recv-done（如对方 WS 断开），也标记完成，避免发送端卡死
    setTimeout(() => {
      if (!lDone.value && lSending.value) {
        lDone.value = true;
        lStatus.value = '已完成（对方可能已离线，文件应已送达）';
        lSending.value = false;
      }
    }, 30000);
  } catch (e: any) {
    if (lAbort?.signal.aborted) { lStatus.value = '已取消发送'; }
    else lStatus.value = `传输出错: ${e?.message || e}`;
    lSending.value = false;
  } finally {
    lAbort = null;
  }
}

function copyLocalLink() { navigator.clipboard?.writeText(lSendLink.value); lStatus.value = '链接已复制'; }

// ========== 中转发送（原有逻辑）==========

const totalSize = computed(() => files.value.reduce((s, f) => s + f.file.size, 0));
const doneCount = computed(() => files.value.filter((f) => f.status === 'done').length);
const allDone = computed(() => files.value.length > 0 && doneCount.value === files.value.length);

// 选中区状态：待传输 / 传输中 / 已完成
const selStatus = computed(() => {
  if (!files.value.length) return '';
  if (allDone.value) return '已完成';
  if (uploading.value) return '传输中…';
  return '待传输';
});
const selStatusClass = computed(() => {
  if (selStatus.value === '已完成') return 'done';
  if (selStatus.value === '传输中…') return 'busy';
  return 'idle';
});

const shareLink = computed(() => (code.value ? `${location.origin}/?code=${code.value}` : ''));

function addFiles(list: FileList | File[], basePath = '') {
  for (const f of Array.from(list)) {
    const rel = basePath ? `${basePath}/${f.name}` : (f as any).webkitRelativePath || f.name;
    if (files.value.some((x) => x.relativePath === rel && x.file.size === f.size)) continue;
    files.value.push({ file: f, relativePath: rel, status: 'pending', uploaded: 0 });
  }
}

// 递归读取拖入的目录结构
function traverse(entry: any, path = '') {
  return new Promise<void>((resolve) => {
    if (entry.isFile) {
      entry.file((f: File) => {
        const rel = path ? `${path}/${f.name}` : f.name;
        if (!files.value.some((x) => x.relativePath === rel && x.file.size === f.size)) {
          files.value.push({ file: f, relativePath: rel, status: 'pending', uploaded: 0 });
        }
        resolve();
      });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(async (ents: any[]) => {
          if (!ents.length) return resolve();
          for (const e of ents) await traverse(e, path ? `${path}/${entry.name}` : entry.name);
          readBatch();
        });
      };
      readBatch();
    } else resolve();
  });
}

async function onDrop(e: DragEvent) {
  e.preventDefault();
  dragOver.value = false;
  const dt = e.dataTransfer;
  if (!dt) return;
  const items = dt.items;
  if (items && items.length && typeof (items[0] as any).webkitGetAsEntry === 'function') {
    for (const it of Array.from(items)) {
      const entry = (it as any).webkitGetAsEntry();
      if (entry) await traverse(entry);
    }
  } else if (dt.files.length) {
    addFiles(dt.files);
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) addFiles(input.files);
  input.value = '';
}

function removeFile(i: number) {
  files.value.splice(i, 1);
}

function clearSelected() {
  files.value = [];
}

/** 刷新加密口令（随机生成新口令） */
function refreshPassphrase() {
  passphrase.value = randomPassphrase();
}

async function start() {
  error.value = '';
  if (!files.value.length) {
    error.value = '请先选择要发送的文件';
    return;
  }
  // E2EE 使用 crypto-js 纯 JS 实现，不依赖 HTTPS/安全上下文
  uploading.value = true;
  try {
    if (!transferId.value) transferId.value = generateUUID();
    const e2eeMeta = { salt: newSalt(), chunkSize: E2EE_CHUNK_SIZE };
    const resp = await createTransfer(transferId.value, message.value, e2eeMeta, ttlHours.value);
    code.value = resp.code;
    loginCode.value = resp.loginCode;   // 16 位登录码
    storage.value = resp.storage;
    started.value = true;

    // 通知父组件：拿到登录码了（用于"我的传输"入口）
    emit('gotLoginCode', resp.loginCode.replace(/\s/g, ''));

    const salt = e2eeMeta.salt;
    await uploadAll(files.value, {
      transferId: transferId.value,
      e2ee: { enabled: true, passphrase: passphrase.value }, // E2EE 始终开启
      e2eeSalt: salt,
      concurrency: 3,
      onItemProgress: (qf, u) => { qf.uploaded = u; },
      onItemSuccess: () => {},
      onItemError: (qf, m) => { error.value = `「${qf.relativePath}」失败：${m}`; },
    });
  } catch (e: any) {
    error.value = e?.message || '传输出错';
  } finally {
    uploading.value = false;
  }
}

async function onRefresh() {
  if (!transferId.value) return;
  const r = await refreshCode(transferId.value);
  code.value = r.code;
}

/** 确认终止传输 */
async function confirmTerminate() {
  if (!transferId.value) return;
  try {
    await terminateTransfer(transferId.value);
    showTerminateDialog.value = false;
    // 清理本地状态，刷新页面
    alert('传输已终止，分享码和登录码均已失效。页面即将刷新。');
    location.reload();
  } catch (e: any) {
    error.value = e?.message || '终止失败';
  }
}

function copyLink() {
  if (!shareLink.value) return;
  navigator.clipboard?.writeText(shareLink.value);
}

function copyLoginCode() {
  if (!loginCode.value) return;
  navigator.clipboard?.writeText(loginCode.value.replace(/\s/g, ''));
}

function copyPassphrase() {
  navigator.clipboard?.writeText(passphrase.value);
}

function fmt(n: number) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// 兼容非安全上下文（http://192.168.x.x 不暴露 crypto.randomUUID）
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (+c ^ (crypto?.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16),
  );
}

// 留言实时同步到服务端
watch(message, async (v) => {
  if (!transferId.value) return;
  try {
    await setMessage(transferId.value, v);
  } catch {
    /* 忽略 */
  }
});

// 组件卸载时清理本地直传连接
onUnmounted(() => { closeLocalConn(); });
</script>

<template>
  <div class="send">
    <!-- 拖拽 / 选择区（共用） -->
    <div
      class="drop"
      :class="{ over: dragOver }"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop="onDrop"
    >
      <div class="drop-icon">⬆️</div>
      <div class="drop-title">把文件或文件夹拖到这里</div>
      <div class="drop-sub muted">或</div>
      <div class="drop-btns">
        <label class="btn primary">
          选择文件
          <input type="file" multiple hidden @change="onPick" />
        </label>
        <label class="btn">
          选择文件夹
          <input type="file" webkitdirectory directory multiple hidden @change="onPick" />
        </label>
      </div>
    </div>

    <!-- 已选文件（共用） -->
    <div v-if="files.length" class="selected">
      <div class="sel-head">
        <span>已选 {{ files.length }} 个 · {{ fmt(totalSize) }}</span>
        <span class="sel-status" :class="selStatusClass">{{ selStatus }}</span>
        <button class="btn sm ghost" @click="clearSelected" :disabled="uploading || lSending">清空所选</button>
      </div>
      <div class="file-list">
        <SendFileRow
          v-for="(f, i) in files"
          :key="i + f.relativePath"
          :qf="f"
          @remove="removeFile(i)"
        />
      </div>
    </div>

    <!-- 发送方式选择 -->
    <div class="opts">
      <div class="opt">
        <label>发送方式</label>
        <div class="seg">
          <button :class="{ on: sendMode === 'relay' }" @click="sendMode = 'relay'">中转发送</button>
          <button :class="{ on: sendMode === 'local' }" @click="sendMode = 'local'">本地直传</button>
        </div>
      </div>

      <!-- 中转发送专属选项 -->
      <template v-if="sendMode === 'relay'">
        <div class="opt">
          <label>有效期</label>
          <div class="seg">
            <button
              v-for="opt in TTL_OPTIONS"
              :key="opt.value"
              :class="{ on: ttlHours === opt.value }"
              @click="ttlHours = opt.value"
            >{{ opt.label }}</button>
          </div>
          <small class="faint">分享码、登录码、文件同时到期；过期或乱写分享码返回找不到</small>
        </div>
      </template>
    </div>

    <!-- ===== 中转发送模式 ===== -->
    <template v-if="sendMode === 'relay'">
    <!-- 留言 -->
    <div class="field">
      <label>留言（对方可见）</label>
      <textarea v-model="message" rows="2" placeholder="例如：这是 20G 的设计素材，注意解压密码…"></textarea>
    </div>

    <!-- 加密口令（E2EE 强制开启） -->
    <div class="field e2ee-field">
      <label>
        🔒 端到端加密口令
        <span class="badge">必须</span>
        <span class="muted hint">· 把这个口令告诉接收方，对方用它解密文件</span>
      </label>
      <div class="pass-row">
        <input v-model="passphrase" type="text" class="pass" placeholder="自动生成的随机口令" />
        <button class="btn sm" @click="refreshPassphrase" title="换一个随机口令">🔄 刷新</button>
        <button class="btn sm ghost" @click="copyPassphrase" title="复制口令">📋 复制</button>
      </div>
    </div>

    <div v-if="error" class="err-box">{{ error }}</div>

    <div class="actions">
      <button class="btn primary" :disabled="uploading || allDone || !files.length" @click="start">
        {{ uploading ? '传输中…' : started ? '继续传输' : '开始传输' }}
      </button>
      <span v-if="allDone" class="ok-tag">✓ 全部完成</span>
      <span v-else-if="files.length && !started" class="hint-start faint">已选中文件，点「开始传输」生成分享码</span>
    </div>

    <!-- 分享码 + 登录码 -->
    <div v-if="code" class="code-card">
      <!-- 分享码（给接收方） -->
      <div class="code-section">
        <div class="code-label muted">分享码（发给接收方）</div>
        <div class="code-value gradient-text">{{ code }}</div>
        <div class="code-actions">
          <button class="btn sm" @click="copyLink">复制链接</button>
          <button class="btn sm" @click="onRefresh">刷新换码</button>
          <a class="btn sm" :href="zipUrl(code)" v-if="storage !== 'r2'">打包下载全部</a>
          <button class="btn sm danger" @click="showTerminateDialog = true" v-if="!uploading">取消分享</button>
        </div>
        <div class="code-link faint">{{ shareLink }}</div>
      </div>

      <!-- 分隔线 -->
      <div class="divider"></div>

      <!-- 登录码（发送者自己用，换电脑回看） -->
      <div class="code-section">
        <div class="code-label muted">🔑 登录码（你自己保存，换电脑后查看/管理）</div>
        <div class="login-code-value">{{ loginCode }}</div>
        <div class="code-actions">
          <button class="btn sm" @click="copyLoginCode">复制登录码</button>
        </div>
        <small class="faint">凭此码可在任意设备查看和管理你的传输内容</small>
      </div>
    </div>

    <!-- 终止确认弹窗 -->
    <Teleport to="body">
      <div v-if="showTerminateDialog" class="modal-overlay" @click.self="showTerminateDialog = false">
        <div class="modal-box">
          <h3>⚠️ 确认取消分享？</h3>
          <p>此操作将：</p>
          <ul>
            <li><strong>作废分享码</strong> — 接收方无法再下载</li>
            <li><strong>作废登录码</strong> — 你无法再通过登录码管理此传输</li>
            <li><strong>清除本地记忆</strong> — 页面将自动刷新</li>
          </ul>
          <p class="warn-text">文件已上传的部分不会被自动删除，但无法被任何人访问。</p>
          <div class="modal-actions">
            <button class="btn ghost" @click="showTerminateDialog = false">再想想</button>
            <button class="btn danger" @click="confirmTerminate">确认终止</button>
          </div>
        </div>
      </div>
    </Teleport>
    </template>

    <!-- ===== 本地直传模式 ===== -->
    <template v-else>
    <div class="local-send-panel">
      <p class="hint">文件经 HTTP 流式中继转发，不落服务器磁盘；双方需同时在线，关闭即止。</p>
      <p class="hint e2ee-hint">🔒 已端到端加密：密钥仅在你的浏览器本地派生，服务器只转发密文、无法解密。</p>

      <div v-if="!lRoom" class="actions">
        <button class="btn primary" :disabled="!files.length" @click="genRoom">生成直传房间</button>
      </div>
      <div v-else class="roominfo">
        <div class="code">房间码：<b>{{ lRoom }}</b></div>
        <div class="link">
          <input :value="lSendLink" readonly />
          <button class="btn sm" @click="copyLocalLink">复制链接</button>
        </div>
        <div class="presence">
          <span class="dot" :class="{ on: lPeerOnline }"></span>
          对方（接收端）：{{ lPeerOnline ? '已在线 ✓' : '等待加入…' }}
        </div>
        <div class="actions">
          <button v-if="!lSending" class="btn primary" :disabled="lDone || !lPeerOnline" @click="startLocalSend">
            {{ lDone ? '已完成' : (lPeerOnline ? '开始传输' : '等待对方加入…') }}
          </button>
          <button v-else class="btn danger" @click="cancelLocalSend">取消发送</button>
        </div>
        <div v-if="lSending || lDone" class="bar">
          <div class="fill" :style="{ width: (lProgress * 100) + '%' }"></div>
        </div>
      </div>
      <div class="status">{{ lStatus }}</div>
    </div>
    </template>
  </div>
</template>

<style scoped src="./SendPanel.css"></style>
