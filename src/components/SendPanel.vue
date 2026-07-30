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

// 自动分房：按「时间」切段（每段目标发送时长 ~8 分钟），每段独立房间（独立 DO 实例），
// 规避单 DO 长时间运行（>15min）缓冲堆积劣化。段房间码 = base-s{i}。
// 段大小按运行时实测上行速度动态估算：快则大段、慢则小段，保证每段都在 15min 阈值内完成。
const SEGMENT_TIME_MS = 8 * 60 * 1000;
const SEGMENT_MIN = 128 * 1024 * 1024;   // 首段/最慢兜底：128MB（即便 ~0.15MB/s 也 <15min）
const SEGMENT_MAX = 1024 * 1024 * 1024;  // 单段上限 1GB（防极慢速仍超阈值的兜底）
let estSpeed = 0; // 运行时实测上行速度(bytes/s)
function segTargetBytes(): number {
  if (estSpeed <= 0) return SEGMENT_MIN;
  return Math.min(SEGMENT_MAX, Math.max(SEGMENT_MIN, Math.round(estSpeed * (SEGMENT_TIME_MS / 1000))));
}
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
  // 段数运行期按实测速度动态确定（每段 ~8 分钟），不再预估
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
/** 从 startIdx 起，按 target 字节切出下一段 chunk 清单（块原子：单段最多超出一个块）。 */
function nextSegment(chunkListAll: { fi: number; ci: number; plainLen: number }[], startIdx: number, target: number) {
  const chunks: { fi: number; ci: number; plainLen: number }[] = [];
  let bytes = 0;
  let i = startIdx;
  while (i < chunkListAll.length && (chunks.length === 0 || bytes + chunkListAll[i].plainLen <= target)) {
    chunks.push(chunkListAll[i]); bytes += chunkListAll[i].plainLen; i++;
  }
  return { chunks, bytes, nextIdx: i, isLast: i >= chunkListAll.length };
}

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
  estSpeed = 0;
  const t0 = Date.now();
  let totalSentAll = 0;

  try {
    let startIdx = 0;
    let seg = 0;
    let segOffsetsAcc = 0;
    // 估算段数仅用于展示；真实结束以发送端标记的 isLast 为准（按时间切段，段数运行期才确定）
    const estSegCount = Math.max(1, Math.ceil(total / SEGMENT_MIN));
    while (startIdx < chunkListAll.length) {
      if (lAbort.signal.aborted) break;
      const target = segTargetBytes();
      const { chunks, bytes, nextIdx, isLast } = nextSegment(chunkListAll, startIdx, target);
      const segOffsets = [segOffsetsAcc];
      lSegIndex.value = seg;
      lSegCount.value = estSegCount;
      await transferSegment({ seg, segCount: estSegCount, chunks, segOffsets, filesList, total, lKeyHex, isLast });
      totalSentAll += sentBytes;
      // 用累计实际耗时估算上行速度，供后续段定大小（慢速必触发小段，规避 15min 阈值）
      const dt = (Date.now() - t0) / 1000;
      if (dt > 1 && totalSentAll > 0) estSpeed = totalSentAll / dt;
      segOffsetsAcc += bytes;
      startIdx = nextIdx;
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
  seg: number; segCount: number;
  chunks: { fi: number; ci: number; plainLen: number }[];
  segOffsets: number[]; filesList: { file: File }[]; total: number; lKeyHex: string;
  isLast: boolean;
};

/** 单段传输：独立房间 + 独立控制通道 + 独立滑动窗口；段内逻辑与原单房间一致。 */
async function transferSegment(ctx: SegCtx) {
  const { seg, segCount, chunks: chunkList, segOffsets, filesList, total, lKeyHex, isLast } = ctx;
  const room = segRoom(lRoom.value, seg);
  const base = resolveRelayBase();
  const POST_LIMIT = 4 * 1024 * 1024;
  const MAX_INFLIGHT = 3;
  const segBytes = chunkList.reduce((s, c) => s + c.plainLen, 0);

  lStatus.value = `正在传输第 ${seg + 1} 段（${fmt(segBytes)}）…`;

  // 每段独立滑动窗口 + 接收端就绪闸门（防上一段残留导致闸门误判）
  ackBytes = 0; sentBytes = 0; ackWaiters = [];
  lRecvReady.value = false;
  armRecvReady();

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
  let chunkBytes = 0;
  const frameGate: { resolve: (() => void) | null; reject: ((e: any) => void) | null } = { resolve: null, reject: null };
  function pushFrame(f: Uint8Array) {
    const wasEmpty = pending.length === 0;
    pending.push(f);
    if (wasEmpty && frameGate.resolve) frameGate.resolve();
    const w = waiters.shift(); if (w) w();
  }
  function notifyDrain() { const w = waiters.shift(); if (w) w(); }
  async function waitFrame(): Promise<void> {
    if (pending.length > 0) return;
    await new Promise<void>((res) => waiters.push(res));
  }
  async function postOneChunk(seed: Uint8Array): Promise<boolean> {
    chunkBytes = 0;
    const rs = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(seed); sentBytes += seed.length; chunkBytes += seed.length;
      },
      async pull(ctrl) {
        if (pending.length === 0) {
          if (producerDone) { ctrl.close(); return; }
          await waitFrame();
          if (pending.length === 0) {
            if (producerDone) { ctrl.close(); return; }
            return;
          }
        }
        const frame = pending.shift()!; notifyDrain();
        ctrl.enqueue(frame); sentBytes += frame.length; chunkBytes += frame.length;
        if (chunkBytes >= POST_LIMIT) { ctrl.close(); return; }
      },
    });
    const resp = await fetch(`${base}/stream/${room}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: rs, duplex: 'half', signal: lAbort!.signal,
    } as any);
    if (!resp.ok) throw new Error(`第 ${seg + 1} 段上传失败 HTTP ${resp.status}`);
    return !(producerDone && pending.length === 0);
  }
  async function postOfferSeg() {
    const offerJson = JSON.stringify({
      type: 'offer',
      files: filesList.map((f) => ({ name: f.file.name, size: f.file.size })),
      segIndex: seg, segCount, isLast, // segCount 仅估算展示；接收端以 isLast 判定结束
    });
    const offerFrame = encodeMsg(new TextEncoder().encode(offerJson));
    const rs = new ReadableStream({ start(ctrl) { ctrl.enqueue(offerFrame); ctrl.close(); } });
    const resp = await fetch(`${base}/stream/${room}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: rs, duplex: 'half', signal: lAbort!.signal,
    } as any);
    if (!resp.ok) throw new Error(`第 ${seg + 1} 段上传 offer 失败 HTTP ${resp.status}`);
  }
  async function sendCloseSeg() {
    try {
      await fetch(`${base}/stream/${room}/close`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(0), signal: lAbort!.signal,
      });
    } catch (e: any) {
      if (lAbort?.signal.aborted) throw e;
      throw new Error(`第 ${seg + 1} 段关闭流失败: ${e?.message || e}`);
    }
  }

  if (chunkList.length > 0) {
    const producer = (async () => {
      try {
        for (const c of chunkList) {
          const file = filesList[c.fi].file;
          const offset = c.ci * LOCAL_CHUNK;
          const chunkBuf = await file.slice(offset, offset + c.plainLen).arrayBuffer();
          const enc = new Uint8Array(await encryptChunkAsync(chunkBuf, lKeyHex));
          const frame = new Uint8Array(FRAME_HDR + enc.length);
          const dv = new DataView(frame.buffer);
          dv.setUint16(0, c.fi); dv.setUint32(2, c.ci); dv.setUint32(6, c.plainLen);
          frame.set(enc, FRAME_HDR);
          pushFrame(encodeMsg(frame));
          while (pending.length > 300) { await new Promise<void>((r) => waiters.push(r)); }
        }
        producerDone = true; notifyDrain();
      } catch (e: any) {
        if (frameGate.reject) frameGate.reject(e);
        throw e;
      }
    })();
    await new Promise<void>((res, rej) => { frameGate.resolve = res; frameGate.reject = rej; });
    frameGate.reject = null;

    // 消费者：并发池发起分片流式 POST（深流水线），窗口 + 并发数双闸门
    const inflightWaiters: Array<() => void> = [];
    const wakeInflight = () => { let w: (() => void) | undefined; while ((w = inflightWaiters.shift())) w(); };
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
          await new Promise<void>((res) => { ackWaiters.push(res); inflightWaiters.push(res); });
        }
      }
      await Promise.all([...active]);
    }
    await pumpPool();
    await producer;
  }

  await sendCloseSeg();
  segClosed = true; // 停止自动重连
  if (!isLast) { try { lWs?.close(); } catch {} }
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
        <div v-if="lSegCount > 1 && (lSending || lDone)" class="seg-info">分段传输：第 {{ lSegIndex + 1 }} / {{ lSegCount }} 段</div>
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
