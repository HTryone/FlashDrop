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
let lDataSocks: WebSocket[] = [];   // 并发数据 WS 流（含主 lWs），用于打满上行带宽

function resetLocalSender() {
  lSending.value = false; lDone.value = false;
  lProgress.value = 0; lPeerOnline.value = false;
  // 滑动窗口状态归零，避免重传时旧 ack/sent 残留导致闸门误判
  ackBytes = 0; sentBytes = 0; ackWaiters = []; lFatal = null;
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
  // 关闭所有并发数据 WS 流（索引 1.. 为额外流；索引 0 = 主 lWs 已单独关闭）
  for (let i = 1; i < lDataSocks.length; i++) {
    try { lDataSocks[i].close(); } catch {}
  }
  lDataSocks = [];
  if (lWs) { try { lWs.close(); } catch {} lWs = null; }
  lWsReadyNotified = false;
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
const WINDOW = 24 * 1024 * 1024;   // 在途上限 24MB：并发 3 路 × 4MB 分片 = 12MB 在途，留余量防死锁；窗口收紧把脉冲从 48MB 降到 12MB（消除并发版震荡）
let ackBytes = 0;                  // 接收端已写盘字节（来自 WS progress.received）
let sentBytes = 0;                 // 已经 WS send 出去的帧字节
let ackWaiters: Array<() => void> = [];
let lFatal: string | null = null;  // relay 回报的致命错误（如 recv-gone），发送循环见之即中止
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

/** 控制/数据帧的统一处理（主 lWs 与额外并发数据流共用）：握手信号、进度、完成、对端掉线 */
function handleControlMsg(ev: MessageEvent) {
  try {
    const data = JSON.parse(ev.data as string);
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
      // 仅用于 UI 进度；发送端不再据此闸门（已改为每流 bufferedAmount 背压，解耦收发速度）
      ackBytes = data.received || 0;
    } else if (data.type === 'recv-gone') {
      // relay 报告：接收端 WS 不在，数据帧无处转发 → 中止发送防静默丢帧
      lFatal = '接收端连接已断开';
    } else if (data.type === 'recv-done' && !lDone.value) {
      // 接收端确已收齐写盘 → 发送端才标记完成（两端状态一致）
      lDone.value = true;
      lProgress.value = 1;
      lSending.value = false;
      lStatus.value = '传输完成';
    }
  } catch {}
}

/** 打开一条额外的并发数据 WS 流（role=sender，ch 仅用于调试），共用 handleControlMsg */
function openDataSock(ch: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = resolveRelayBase().replace(/^https:/, 'wss:') + `/ws/${lRoom.value}?role=sender&ch=${ch}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => resolve(ws);
    ws.onmessage = handleControlMsg;
    ws.onerror = () => { /* 失败时由主通道兜底，不在此 reject 以免卡握手 */ };
    ws.onclose = () => {};
    // 5s 内未连上则视为失败
    setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) { try { ws.close(); } catch {} reject(new Error('数据流超时')); } }, 5000);
  });
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
    ws.onmessage = handleControlMsg;
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
  ackBytes = 0; sentBytes = 0; ackWaiters = []; lFatal = null;
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

  // ---- WS 数据通道（2026-07-29 真流式架构）----
  // 铁证（隔离实验）：Chrome→CF 对 POST body 整段缓冲、POST 关闭才向 DO 转发，
  // 分片 POST 必然产生「关流空窗+瞬时跳变」脉冲（用户实测 4-6MB/s 震荡、均值 5）。
  // WS 是帧级即时转发（控制信号即时到达即佐证），数据面改走同一条 sender WS：
  //   帧 = [12B FRAME_HDR][IV+密文+HMAC]，无 4B 长度前缀（WS 自带消息边界）；
  //   896KB 明文块加密后 ≈ 897KB < 1MiB（Cloudflare WS 单消息上限，e2ee.ts 当初即为此设计）。
  // 背压双闸门：① 端到端在途 sentBytes-ackBytes ≤ WINDOW（ack=接收端已写盘字节）
  //            ② 本地 socket 缓冲 ws.bufferedAmount ≤ BUF_LIMIT（防整文件塞进内存缓冲）
  // 并发数据 WS 流数：对标旧 POST 版 MAX_INFLIGHT=3，用多条 WS 流打满上行带宽
  // （单条 WS 流在用户链路仅能跑 ~1.6MB/s，3 路并发可恢复到 ~6MB/s 上行上限）。
  const N_STREAMS = 3;
  const BUF_LIMIT = 8 * 1024 * 1024;            // 本地 WS 发送缓冲总上限
  const perStreamLimit = BUF_LIMIT / N_STREAMS;  // 每流背压上限（总量仍 ≈8MB）

  try {
    const mapped = files.value.map(f => ({ file: f.file }));
    const total = mapped.reduce((s, f) => s + f.file.size, 0);
    if (total === 0) {
      lDone.value = true; lStatus.value = '传输完成（空）'; lSending.value = false;
      return;
    }

    // 1. 经 WS 发 offer（JSON 控制帧，relay 透传给接收端）
    const offerMsg = JSON.stringify({
      type: 'offer',
      files: files.value.map(f => ({ name: f.file.name, size: f.file.size })),
    });
    if (!lWs || lWs.readyState !== WebSocket.OPEN) throw new Error('控制通道未连接');
    lWs.send(offerMsg);
    lStatus.value = '已发送文件清单，等待对方就绪…';

    // 2. 等接收端 recv-ready（对方收到 offer、建好落盘句柄后回发）。
    //    WS 竞态可能丢 offer（接收端 WS 晚于发送时刻连上）→ 每 5s 重发（接收端幂等忽略重复），20s 超时。
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      let lastOffer = t0;
      const timer = setInterval(() => {
        if (lRecvReady.value) { clearInterval(timer); resolve(); return; }
        if (lAbort?.signal.aborted) { clearInterval(timer); reject(new Error('已取消')); return; }
        if (Date.now() - t0 > 20000) {
          clearInterval(timer);
          reject(new Error('对方未开始接收（20s 超时）。请确认对方已点「连接接收」且页面未关闭'));
          return;
        }
        if (Date.now() - lastOffer >= 5000 && lWs?.readyState === WebSocket.OPEN) {
          lastOffer = Date.now();
          try { lWs.send(offerMsg); } catch {}
        }
      }, 200);
    });
    lStatus.value = '对方已就绪，开始传输数据…';

    // 3. 真流式并发发送：N 条 WS 数据流轮询发送（无分片 POST、无关流空窗）。
    //    背压仅用每流 bufferedAmount（本地 socket 缓冲上限），不再等接收端写盘 ack ——
    //    彻底解耦发送端与接收端磁盘速度（旧版 WINDOW 闸门会把发送端拖到接收端写盘速率，
    //    是 WS 版比 POST 版慢 3.7 倍的根因）。多流并发打满上行，恢复 ~6MB/s。
    //    主 lWs 即流 0；并发打开 N-1 条额外数据流（开不起来则降级单流，不致命）。
    lDataSocks = [lWs];
    try {
      const extra = await Promise.all(
        Array.from({ length: N_STREAMS - 1 }, (_, k) => openDataSock(k + 1)),
      );
      lDataSocks.push(...extra);
    } catch {
      lStatus.value = '并发数据流建立失败，降级为单流传输';
    }

    let assign = 0;   // 轮询分配到各数据流（接收端按帧内 seq 保序写盘，分配顺序无关）
    for (let fi = 0; fi < mapped.length; fi++) {
      const file = mapped[fi].file; let offset = 0; let ci = 0;
      while (offset < file.size) {
        if (lAbort!.signal.aborted) throw new Error('已取消');
        if (lFatal) throw new Error(lFatal);
        const end = Math.min(offset + LOCAL_CHUNK, file.size);
        const chunkBuf = await file.slice(offset, end).arrayBuffer();
        const plainLen = chunkBuf.byteLength;
        const enc = new Uint8Array(await encryptChunkAsync(chunkBuf, lKeyHex.value));
        // 帧头：fi u16 + ci u32 + plainLen u32
        const frame = new Uint8Array(FRAME_HDR + enc.length);
        const dv = new DataView(frame.buffer);
        dv.setUint16(0, fi); dv.setUint32(2, ci); dv.setUint32(6, plainLen);
        frame.set(enc, FRAME_HDR);
        // 背压：仅本流 WS 发送缓冲（bufferedAmount 无事件可订阅，20ms 轮询）
        const sock = lDataSocks[assign % lDataSocks.length]; assign++;
        while (sock.readyState === WebSocket.OPEN && sock.bufferedAmount > perStreamLimit) {
          if (lAbort!.signal.aborted) throw new Error('已取消');
          if (lFatal) throw new Error(lFatal);
          await new Promise((r) => setTimeout(r, 20));
        }
        if (sock.readyState !== WebSocket.OPEN) throw new Error('数据通道断开');
        if (lFatal) throw new Error(lFatal);
        sock.send(frame);
        offset += plainLen; ci++;
        offset += plainLen; ci++;
      }
    }

    // 4. 数据结束控制帧：所有数据流都发一份（接收端以「收齐全部帧」为完成判据，此帧仅兜底触发收尾）
    for (const s of lDataSocks) {
      if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: 'data-eof' }));
    }
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
