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

// 自动分房：纯「时间」切段（每段从开始传输起计时，达到 SEGMENT_TIME_MS 即收尾开新段），
// 每段独立房间（独立 DO 实例），规避单 DO 长时间运行（>15min）缓冲堆积劣化。段房间码 = base-s{i}。
// 不按字节预算大小：速度中途变化也不影响，天然躲开 15min 阈值——这是相对旧版「速度×时间」写法的根本改进
// （旧版用段开始那一刻的速度估算整段大小，前快后慢时大段会越过 15min 阈值）。
const SEGMENT_TIME_MS = 300_000;            // 单段目标时长 5 分钟（远小于 DO 15min 劣化阈值，留足余量）
const SEGMENT_MIN_BYTES = 32 * 1024 * 1024; // 最小段字节守卫：本段已发字节未达此值时不切，避免瞬时抖动切出迷你段
function segRoom(base: string, i: number): string { return `${base}-s${i}`; }

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
const lSegIndex = ref(0);   // 当前段（0 基），用于 UI 展示
const lSegCount = ref(1);  // 总段数

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
  // 段数运行期按传输墙钟动态确定（每 ~5 分钟切一段），不预算大小
  lSegCount.value = 1;
  lSendLink.value = `${location.origin}/?tab=local&room=${s}#k=${lPassphrase.value}`;
  lStatus.value = '房间已生成，等待对方加入…';
}

// 端到端滑动窗口状态（顶层作用域：控制通道 onmessage 与发送流 pull 共享）
// 只控「在途字节量」(已发-已确认)，绝不控速率，天然免疫 ~8s 速率信号异位 → 消除震荡
const WINDOW = 24 * 1024 * 1024;   // 在途上限 24MB：并发 3 路 × 4MB 分片 = 12MB 在途，留余量防死锁；窗口收紧把脉冲从 48MB 降到 12MB（消除并发版震荡）
let ackBytes = 0;                  // 接收端已写盘字节（来自 WS progress.received）
let sentBytes = 0;                 // 已 enqueue 进 POST body 流的字节
let ackWaiters: Array<() => void> = [];
// 必须唤醒「全部」等待者，且清空数组。
// 历史 BUG：只 shift 一个 → 被 wakeInflight 唤醒过的 stale resolver 会永久残留在 ackWaiters 里，
// 每次 progress 只消化掉一个死 resolver，真正在等窗口的协程拿不到唤醒；
// 当 inflightCount 归零、窗口仍满时唯一唤醒源就是 progress，
// 而发送端停发 → 接收端不落盘 → 不再发 progress → 永久死锁（表现为速度归零、大文件后段必现）。
function notifyAckWaiters() { const ws = ackWaiters; ackWaiters = []; for (const w of ws) { try { w(); } catch {} } }

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


/** 把所有文件展开成有序 chunk 清单（fi, ci, plainLen），供按时间动态切段。 */
function buildChunkList(filesList: { file: File }[]) {
  type Chunk = { fi: number; ci: number; plainLen: number };
  const list: Chunk[] = [];
  let total = 0;
  for (let fi = 0; fi < filesList.length; fi++) {
    const size = filesList[fi].file.size;
    const n = size === 0 ? 0 : Math.ceil(size / LOCAL_CHUNK);
    for (let ci = 0; ci < n; ci++) {
      const plainLen = Math.min(LOCAL_CHUNK, size - ci * LOCAL_CHUNK);
      list.push({ fi, ci, plainLen });
      total += plainLen;
    }
  }
  return { list, total };
}
// 按时间切段已无需按字节预切（nextSegment）：transferSegment 直接吃全量 chunk 清单 + startIdx，
// 在帧循环里按墙钟时间（SEGMENT_TIME_MS）收尾，边界天然落在帧边界。

async function startLocalSend() {
  if (!lRoom.value || !lPassphrase.value) { lStatus.value = '请先生成房间'; return; }
  if (!files.value.length) { lStatus.value = '没有待发送文件'; return; }
  let lKeyHex: string;
  try { lKeyHex = await deriveKey(lPassphrase.value, LOCAL_SALT); }
  catch (e: any) { lStatus.value = `密钥派生失败: ${e?.message || e}`; return; }

  const filesList = files.value.map((f) => ({ file: f.file }));
  const { list: chunkListAll, total } = buildChunkList(filesList);
  lSending.value = true; lProgress.value = 0; lDone.value = false;
  lStatus.value = '正在建立控制通道…';
  lAbort = new AbortController();

  try {
    let startIdx = 0;
    let seg = 0;
    // 纯时间切段：每段从开始传起计时，到点（SEGMENT_TIME_MS）即收尾开新段；段数运行期才确定。
    while (startIdx < chunkListAll.length) {
      if (lAbort.signal.aborted) break;
      lSegIndex.value = seg;
      const r = await transferSegment({ seg, startIdx, chunkListAll, filesList, total, lKeyHex });
      startIdx = r.sentUpTo;
      seg++;
    }
    if (!lAbort.signal.aborted) {
      lStatus.value = '文件已发送，等待对方接收完成…';
      // 兜底超时：30s 内未收到 recv-done（如对方 WS 断开），也标记完成，避免发送端卡死
      setTimeout(() => {
        if (!lDone.value && lSending.value) {
          lDone.value = true;
          lStatus.value = '已完成（对方可能已离线，文件应已送达）';
          lSending.value = false;
          closeLocalConn();
        }
      }, 30000);
    }
  } catch (e: any) {
    if (lAbort?.signal.aborted) { lStatus.value = '已取消发送'; }
    else lStatus.value = `传输出错: ${e?.message || e}`;
    lSending.value = false;
    closeLocalConn();
  } finally {
    if (lAbort?.signal.aborted) lSending.value = false;
  }
}

type SegCtx = {
  seg: number;
  startIdx: number;
  chunkListAll: { fi: number; ci: number; plainLen: number }[];
  filesList: { file: File }[]; total: number; lKeyHex: string;
};

/** 单段传输：独立房间 + 独立控制通道 + 独立滑动窗口；段内逻辑与原单房间一致。 */
async function transferSegment(ctx: SegCtx): Promise<{ sentUpTo: number; isLast: boolean }> {
  const { seg, startIdx, chunkListAll, filesList, total, lKeyHex } = ctx;
  const room = segRoom(lRoom.value, seg);
  const base = resolveRelayBase();
  const POST_LIMIT = 4 * 1024 * 1024;
  const MAX_INFLIGHT = 3;

  // 本段起始字节偏移（滑动窗口用：本段已确认字节 = 全局已收 - 本段之前字节），与接收端 segOffset 对齐
  let segOffset = 0;
  for (let k = 0; k < startIdx; k++) segOffset += chunkListAll[k].plainLen;
  const segOffsets = [segOffset];
  const segStartTime = Date.now();

  lStatus.value = `正在传输第 ${seg + 1} 段…`;

  // 每段独立滑动窗口 + 接收端就绪闸门（防上一段残留导致闸门误判）
  ackBytes = 0; sentBytes = 0; ackWaiters = [];
  lRecvReady.value = false;
  armRecvReady();

  // 段级状态：生产者按时间切段时填充，供段末收尾与 isLast 判定
  let segTimeUp = false;     // 本段因到达 SEGMENT_TIME_MS 而收尾（非最后一段）
  let segBytes = 0;          // 本段已加密入队字节
  let producedUpTo = startIdx; // 生产者已处理的下一个 chunk 索引

  // 本段控制通道（每段独立 room → 独立 DO，规避单 DO 长时劣化）。
  // 断线自动重连：relay 在 sender WS 重连且接收端 GET 已连时会补发 pull，
  // 消灭「WS 掉线丢 pull → 发送端永等 → 一个包都不发」的死锁。
  let segClosed = false;
  const wsUrl = base.replace(/^https:/, 'wss:') + `/ws/${room}?role=sender`;
  const handleCtrlMsg = (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'ready') {
        lPeerOnline.value = true;
        lStatus.value = '对方已在线，可开始传输';
      } else if (data.type === 'pull' || data.type === 'recv-ready') {
        lRecvReady.value = true; recvReadyResolve?.(); recvReadyResolve = null;
      } else if (data.type === 'progress') {
        const t = data.total || 1;
        lProgress.value = Math.min(1, (data.received || 0) / t);
        // 滑动窗口用「本段已确认字节」= 全局已收 - 本段之前字节偏移；绝不跨段累计，否则闸门虚高死锁
        ackBytes = Math.max(0, (data.received || 0) - segOffsets[0]);
        notifyAckWaiters();
      } else if (data.type === 'recv-done' && !lDone.value) {
        lDone.value = true; lProgress.value = 1; lSending.value = false;
        lStatus.value = '传输完成';
        closeLocalConn();
      }
    } catch {}
  };
  function openCtrl(first: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let opened = false;
      ws.onopen = () => { opened = true; lWs = ws; resolve(); };
      ws.onerror = () => { if (!opened && first) reject(new Error('控制通道连接失败')); };
      ws.onmessage = handleCtrlMsg;
      ws.onclose = () => {
        if (lWs === ws) lWs = null;
        // 段未结束且未完成 → 1s 后自动重连（重连失败会再次触发 onclose 循环重试）
        if (!segClosed && !lDone.value && !lAbort?.signal.aborted) {
          setTimeout(() => { if (!segClosed && !lDone.value) openCtrl(false).catch(() => {}); }, 1000);
        }
        if (!opened && first) reject(new Error('控制通道连接失败'));
      };
    });
  }
  await openCtrl(true);

  // —— 破死锁改序：先发 offer，再等就绪。relay 会把 POST 挂起到接收端 GET 连上，
  // offer 先行入 writeChain 保证它是 GET 流第一个有效帧；数据帧仍等就绪后才开始 POST。
  const offerP = postOfferSeg();
  offerP.catch(() => {}); // 超时路径统一抛错，防未捕获 rejection
  lStatus.value = seg === 0
    ? '等待对方点「连接接收」…（链接已生成，可先发给对方）'
    : `第 ${seg + 1} 段：等待对方就绪…`;
  // 第 0 段 = 等对方上线，属正常等待，给 10 分钟；后续段接收端已在流程中，60s 足够
  const waitMs = seg === 0 ? 10 * 60 * 1000 : 60 * 1000;
  try {
    await Promise.race([
      recvReadyPromise,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error(`第 ${seg + 1} 段：对方未开始接收（${Math.round(waitMs / 1000)}s 超时）`)), waitMs)),
    ]);
  } catch (e: any) {
    lStatus.value = `无法开始传输：${e?.message || e}。请确认对方已点「连接接收」且页面未关闭。`;
    lSending.value = false;
    segClosed = true;
    try { lWs?.close(); } catch {}
    throw e;
  }
  await offerP; // 就绪即说明 GET 已连，offer 已送达
  lStatus.value = `第 ${seg + 1} 段：开始传输数据…`;

  // ---- 生产者：本段 chunk 加密入队 ----
  let pending: Uint8Array[] = [];
  let producerDone = false;
  let waiters: Array<() => void> = [];
  const frameGate: { resolve: (() => void) | null; reject: ((e: any) => void) | null } = { resolve: null, reject: null };
  function pushFrame(f: Uint8Array) {
    const wasEmpty = pending.length === 0;
    pending.push(f);
    if (wasEmpty && frameGate.resolve) frameGate.resolve();
    const w = waiters.shift(); if (w) w();
  }
  function notifyDrain() { const w = waiters.shift(); if (w) w(); }
  /** 唤醒全部等待者：生产结束时必须用它，否则并发 pull 中只有 1 个被唤醒、其余永久挂起 → POST 流不 close → 段卡死。 */
  function notifyAllDrain() { const ws = waiters; waiters = []; for (const w of ws) { try { w(); } catch {} } }
  async function waitFrame(): Promise<void> {
    if (pending.length > 0) return;
    // 500ms 兜底轮询：任何唤醒信号丢失都不会导致永久挂起（唤醒后会重新检查 pending/producerDone）
    await new Promise<void>((res) => {
      let fired = false;
      const once = () => { if (fired) return; fired = true; res(); };
      waiters.push(once);
      setTimeout(once, 500);
    });
  }
  async function postOneChunk(seed: Uint8Array): Promise<boolean> {
    // ---- 阶段 1：先把帧攒成一个 ≤POST_LIMIT 的完整字节块（不再用流式 body）----
    // 旧实现把 pending 里 shift 出来的帧直接喂给流式请求体：POST 一旦失败（网络抖动/500），
    // 这些帧就永久丢失且无法重发 → 接收端按序写盘卡在缺口上 → 双方 UI 显示「传输中」但速度归零。
    // 改为先组包再发，字节留在本地变量里，失败可原样重发（relay 侧已保证「整体读完才入队」，重发无副作用）。
    const parts: Uint8Array[] = [seed];
    let bytes = seed.length;
    const SOFT_MIN = 1024 * 1024; // 队列空且已攒够 1MB 就先发，避免死等满 4MB 拉长延迟
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
    // 窗口计数在「已交付发送」时即计入（与旧行为一致），失败会整体抛错终止本段
    sentBytes += bytes;

    // ---- 阶段 2：原子重试 ----
    let lastErr: any = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (lAbort?.signal.aborted) throw new Error('已取消');
      try {
        const resp = await fetch(`${base}/stream/${room}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: body as unknown as BodyInit, signal: lAbort!.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        if (attempt > 0) lStatus.value = `第 ${seg + 1} 段：重试成功，继续传输…`;
        return !(producerDone && pending.length === 0);
      } catch (e: any) {
        if (lAbort?.signal.aborted) throw e;
        lastErr = e;
        lStatus.value = `第 ${seg + 1} 段：网络抖动，正在重发分片（第 ${attempt + 1}/4 次）…`;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    throw new Error(`第 ${seg + 1} 段上传失败（已重试 4 次）: ${lastErr?.message || lastErr}`);
  }
  async function postOfferSeg() {
    const offerJson = JSON.stringify({
      type: 'offer',
      files: filesList.map((f) => ({ name: f.file.name, size: f.file.size })),
      // 时间切段下 isLast 在发 offer 时不可预知（取决于传输过程墙钟），故统一 false，
      // 段末由 segend 帧携带真实 isLast；segCount 运行期才定，填 0（仅展示）。
      segIndex: seg, segCount: 0, isLast: false,
    });
    const offerFrame = encodeMsg(new TextEncoder().encode(offerJson));
    // offer 同样用普通 body + 重试：它是本段第一个有效帧，丢了整段就起不来
    let lastErr: any = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (lAbort?.signal.aborted) throw new Error('已取消');
      try {
        const resp = await fetch(`${base}/stream/${room}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
          body: offerFrame as unknown as BodyInit, signal: lAbort!.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return;
      } catch (e: any) {
        if (lAbort?.signal.aborted) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    throw new Error(`第 ${seg + 1} 段上传 offer 失败: ${lastErr?.message || lastErr}`);
  }
  // 段末控制帧：携带真实 isLast。时间切段下发送端需跑完本段才知道是否最后一段，
  // 故在段末（数据发完、close 之前）补发此帧；接收端读流时识别并据其判定结束。
  async function postSegendFrame(realIsLast: boolean) {
    const segendJson = JSON.stringify({ type: 'segend', isLast: realIsLast });
    const frame = encodeMsg(new TextEncoder().encode(segendJson));
    let lastErr: any = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (lAbort?.signal.aborted) throw new Error('已取消');
      try {
        const resp = await fetch(`${base}/stream/${room}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
          body: frame as unknown as BodyInit, signal: lAbort!.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return;
      } catch (e: any) {
        if (lAbort?.signal.aborted) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    throw new Error(`第 ${seg + 1} 段上传 segend 失败: ${lastErr?.message || lastErr}`);
  }
  // 段末关闭流：best-effort。数据已通过 POST + segend(isLast) 送达，close 只是给 relay 的回收提示；
  // 失败 relay 也会超时回收，对结果零影响。旧版把它当致命错抛出，导致「传输出错: 第 N 段关闭流失败」假报错。
  async function sendCloseSeg() {
    try {
      await fetch(`${base}/stream/${room}/close`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(0), signal: lAbort!.signal,
      });
    } catch (e: any) {
      if (lAbort?.signal.aborted) throw e;
      console.warn(`第 ${seg + 1} 段关闭流提示失败（数据已送达，relay 会超时回收）: ${e?.message || e}`);
    }
  }

  if (startIdx < chunkListAll.length) {
    const producer = (async () => {
      try {
        for (let i = startIdx; i < chunkListAll.length; i++) {
          const c = chunkListAll[i];
          const file = filesList[c.fi].file;
          const offset = c.ci * LOCAL_CHUNK;
          const chunkBuf = await file.slice(offset, offset + c.plainLen).arrayBuffer();
          const enc = new Uint8Array(await encryptChunkAsync(chunkBuf, lKeyHex));
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
              setTimeout(once, 500);   // 兜底：唤醒信号丢失也不会永久挂在背压等待上
            });
          }
          // 纯时间切段：到点且本段已发够最小守卫字节 且 还有后续 chunk → 收尾本段（边界落帧边界，接收端按 fi/ci 重组天然干净）
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
    const wakeInflight = () => { const ws = inflightWaiters; inflightWaiters = []; for (const w of ws) { try { w(); } catch {} } };
    let inflightCount = 0;
    async function pumpPool() {
      const active = new Set<Promise<unknown>>();
      const tryLaunch = (): boolean => {
        if (inflightCount >= MAX_INFLIGHT) return false;
        if ((sentBytes - ackBytes) >= WINDOW) return false;
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
          // 同一个 resolver 同时挂在两个唤醒源上，必须去重（once），否则重复 resolve；
          // 且两边唤醒时都整体清空，保证不会有 stale resolver 残留造成后续唤醒被吞。
          // 兜底 1s 轮询：即便两个唤醒源都静默（对端停发 progress），也能重新评估窗口，绝不永久卡死。
          await new Promise<void>((res) => {
            let fired = false;
            const once = () => { if (fired) return; fired = true; res(); };
            ackWaiters.push(once); inflightWaiters.push(once);
            setTimeout(once, 1000);
          });
        }
      }
      await Promise.all([...active]);
    }
    await pumpPool();
    await producer;
  }

  // 段末：先发 segend 帧（携带真实 isLast），再 best-effort 关闭流。
  // 真实 isLast = 生产者跑到 EOF（非因时间到点收尾）→ 这是最后一段。
  const realIsLast = !segTimeUp;
  try { await postSegendFrame(realIsLast); }
  catch (e: any) { console.warn(`第 ${seg + 1} 段 segend 发送失败（接收端将按 EOF 判定）: ${e?.message || e}`); }
  await sendCloseSeg();
  segClosed = true; // 停止自动重连
  if (!realIsLast) { try { lWs?.close(); } catch {} }
  return { sentUpTo: producedUpTo, isLast: realIsLast };
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
          <button v-if="!lSending" class="btn primary" :disabled="lDone || !lRoom" @click="startLocalSend">
            {{ lDone ? '已完成' : '开始传输' }}
          </button>
          <button v-else class="btn danger" @click="cancelLocalSend">取消发送</button>
        </div>
        <div v-if="(lSending || lDone)" class="seg-info">分段传输：第 {{ lSegIndex + 1 }} 段</div>
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
