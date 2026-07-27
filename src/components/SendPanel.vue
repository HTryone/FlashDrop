<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import type { QueuedFile, StorageType } from '@/types/transfer';
import { createTransfer, refreshCode, setMessage, terminateTransfer, zipUrl } from '@/api/transfer';
import { uploadAll } from '@/composables/useTusUpload';
import { newSalt, E2EE_CHUNK_SIZE, randomPassphrase, deriveKey, LOCAL_SALT, LOCAL_CHUNK_SIZE } from '@/crypto/e2ee';
import { createWebRTC, fetchIceServers } from '@/composables/useWebRTC';
import { encryptChunkAsync } from '@/composables/useLocalCrypto';
import SendFileRow from './SendFileRow.vue';

const emit = defineEmits<{
  (e: 'gotLoginCode', code: string): void;
}>();

// 发送方式：中转发送（带分享码/登录码/有效期/口令）| 本地直传（WebSocket 实时，无有效期/口令）
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

// ========== 本地直传（复用 LocalTransfer 逻辑）==========
const LOCAL_CHUNK = LOCAL_CHUNK_SIZE;
const FRAME_HDR = 12;
const LOW = 16 * 1024 * 1024;
const CONN_TIMEOUT = 10000;
const DRAIN_TIMEOUT_MS = 30000;
const P2P_WAIT_MS = 8000; // 传输开始前等待 P2P 直连就绪的最长时长，超时回退中继
const RELAY_DEFAULT = 'flashdrop-relay.xianshenghu363.workers.dev';
function resolveRelay() {
  const host = (import.meta as any).env?.VITE_RELAY_URL || RELAY_DEFAULT;
  const proto = (host.includes('workers.dev') || location.protocol === 'https:') ? 'wss' : 'ws';
  return { host, proto };
}

const lRoom = ref('');
const lPassphrase = ref('');
const lSendLink = ref('');
const lKeyHex = ref('');
const lSending = ref(false);
const lDone = ref(false);
const lTransferStarted = ref(false);
let lLoopStarted = false;
const lProgress = ref(0);
const lStatus = ref('');
const lPeerOnline = ref(false);
let lWs: WebSocket | null = null;

// WebRTC P2P 直连层（叠加在现有 WS 中继之上；失败自动回退 WS）
let lRtc: ReturnType<typeof createWebRTC> | null = null;
let lRtcStarted = false;
const lRtcOpen = ref(false);
let lIce: RTCIceServer[] = [];

function resetLocalSender() {
  lSending.value = false; lDone.value = false; lTransferStarted.value = false;
  lLoopStarted = false; lProgress.value = 0; lPeerOnline.value = false;
  lRtcOpen.value = false;
}
function closeLocalWs() {
  if (lWs) { try { lWs.close(); } catch {} lWs = null; }
  if (lRtc) { try { lRtc.destroy(); } catch {} lRtc = null; }
  lRtcStarted = false; lRtcOpen.value = false;
}

// 创建 WebRTC 层（若已存在则跳过）。P2P 直连优先，失败由 doLocalSendLoop 回退 WS。
function ensureLocalRtc(relayHost: string, proto: string) {
  if (lRtc) return;
  lRtc = createWebRTC({
    role: 'sender',
    iceServers: lIce,
    sendSignal: (m) => { if (lWs && lWs.readyState === WebSocket.OPEN) lWs.send(JSON.stringify(m)); },
    onState: (open) => { lRtcOpen.value = open; if (open) lStatus.value = '已建立 P2P 直连，准备传输'; },
  });
}

function genRoom() {
  closeLocalWs(); resetLocalSender();
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; const a = new Uint8Array(6); crypto.getRandomValues(a);
  for (let i = 0; i < 6; i++) s += cs[a[i] % cs.length];
  lRoom.value = s; lPassphrase.value = randomPassphrase();
  lSendLink.value = `${location.origin}/?tab=local&room=${s}#k=${lPassphrase.value}`;
  lStatus.value = '房间已生成，正在连接中继…'; void connectLocalSender();
}

async function connectLocalSender() {
  if (!lRoom.value || !lPassphrase.value) return;
  try { lKeyHex.value = await deriveKey(lPassphrase.value, LOCAL_SALT); }
  catch (e: any) { lStatus.value = `密钥派生失败: ${e?.message || e}`; return; }
  const { host: relayHost, proto } = resolveRelay();
  let ws: WebSocket;
  try { ws = new WebSocket(`${proto}://${relayHost}/relay?room=${lRoom.value}&role=sender`); }
  catch (e: any) { lStatus.value = `无法创建连接: ${e?.message || e}`; return; }
  (ws as any).bufferedAmountLowThreshold = LOW; lWs = ws; resetLocalSender();
  // 拉取 ICE 配置并创建 WebRTC 层（协商在对方上线后发起）
  try { lIce = await fetchIceServers(relayHost, proto); } catch { lIce = []; }
  ensureLocalRtc(relayHost, proto);
  lStatus.value = '已连上中继，等待对方加入…';
  let settled = false;
  const openTimer = window.setTimeout(() => {
    if (!settled && ws.readyState !== WebSocket.OPEN) { settled = true; lStatus.value = '连接超时：中继不可达'; resetLocalSender(); try { ws.close(); } catch {} }
  }, CONN_TIMEOUT);
  ws.onopen = () => { clearTimeout(openTimer); if (!settled) lStatus.value = '已连上中继，等待对方加入…'; };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const msg = (() => { try { return JSON.parse(ev.data as string); } catch { return null; } })();
    if (!msg) return;
    if ((msg.type === 'peer-joined' && msg.role === 'receiver') || msg.type === 'receiver-joined') {
      const wasOffline = !lPeerOnline.value; lPeerOnline.value = true;
      // 对方上线即发起 WebRTC 协商（P2P 直连），稍后起传时若 DC 已开则走直连
      ensureLocalRtc(relayHost, proto);
      if (!lRtcStarted) { lRtcStarted = true; lRtc?.initiator().catch(() => {}); }
      if (!lSending.value && !lDone.value) lStatus.value = '对方已在线，可开始传输';
      if (lTransferStarted.value && !lLoopStarted && ws.readyState === WebSocket.OPEN && wasOffline) {
        localSendOffer(ws); lStatus.value = '对方已加入，重新发起传输…';
      }
    } else if (msg.type === 'ready') { void doLocalSendLoop(ws); }
    else if (msg.type === 'rtc-signal') { void lRtc?.onSignal(msg.data); }
    else if (msg.type === 'peer-left') {
      lPeerOnline.value = false;
      if (!lDone.value) lStatus.value = '对方已断开，等待重新加入…';
      // 断开则销毁 P2P，待重新加入时再协商
      if (lRtc) { try { lRtc.destroy(); } catch {} lRtc = null; }
      lRtcStarted = false; lRtcOpen.value = false;
    }
  };
  ws.onclose = () => { clearTimeout(openTimer); if (!settled) settled = true; if (!lDone.value) resetLocalSender(); };
  ws.onerror = () => { clearTimeout(openTimer); if (!settled) settled = true; lStatus.value = '连接出错（中继不可达或被拦截）'; resetLocalSender(); };
}

function localSendOffer(ws: WebSocket) {
  try { ws.send(JSON.stringify({ type: 'offer', files: files.value.map(f => ({ name: f.file.name, size: f.file.size })) })); }
  catch (e: any) { lStatus.value = `发送 offer 失败: ${e?.message || e}`; }
}

// 等待 P2P 直连就绪：传输开始时若 DataChannel 尚未 open（协商通常需 1~5s），
// 轮询等待最多 timeoutMs；连上返回 true，超时返回 false（交由调用方回退中继）。
// 解决「点发送太早、P2P 还没连上就被一次性判走中继」的时序 bug。
function waitForRtc(timeoutMs: number): Promise<boolean> {
  if (lRtc && lRtc.isOpen()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = window.setInterval(() => {
      if (lRtc && lRtc.isOpen()) { window.clearInterval(iv); resolve(true); }
      else if (Date.now() - start > timeoutMs) { window.clearInterval(iv); resolve(false); }
    }, 100);
  });
}

function startLocalSend() {
  if (!lWs || lWs.readyState !== WebSocket.OPEN) { lStatus.value = '未连接到中继'; return; }
  if (!lPeerOnline.value) { lStatus.value = '对方尚未加入，请等待对方连接接收'; return; }
  if (!files.value.length) { lStatus.value = '没有待发送文件'; return; }
  lSending.value = true; lTransferStarted.value = true; lProgress.value = 0;
  lStatus.value = '对方已连接，开始传输…'; localSendOffer(lWs);
}

async function doLocalSendLoop(ws: WebSocket) {
  lLoopStarted = true;
  // 先等 P2P 直连就绪（最多 P2P_WAIT_MS），连上才用 DataChannel，超时回退 WS。
  // 避免「点发送太早、P2P 还没连上」就被一次性判走中继——这是之前「总是走中继」的根因。
  // 仍一次性决定，避免同一文件混用两路导致帧乱序。
  lStatus.value = '正在建立 P2P 直连…';
  const useRtc = await waitForRtc(P2P_WAIT_MS);
  if (useRtc) lStatus.value = 'P2P 直连已建立，开始传输…';
  else lStatus.value = 'P2P 直连未就绪，已回退中继转发';
  const ch = (useRtc && lRtc) ? lRtc.getChannel() : null;
  const mapped = files.value.map(f => ({ file: f.file }));
  const total = mapped.reduce((s, f) => s + f.file.size, 0);
  if (total === 0) { ws.send(JSON.stringify({ type: 'done' })); lDone.value = true; lStatus.value = '传输完成（空）'; lSending.value = false; return; }
  let sent = 0;
  try {
    for (let fi = 0; fi < mapped.length; fi++) {
      const file = mapped[fi].file; let offset = 0; let ci = 0;
      while (offset < file.size) {
        if (ws.readyState !== WebSocket.OPEN && !useRtc) throw new Error('连接已断开');
        const end = Math.min(offset + LOCAL_CHUNK, file.size);
        const chunkBuf = await file.slice(offset, end).arrayBuffer();
        const plainLen = chunkBuf.byteLength;
        const enc = new Uint8Array(await encryptChunkAsync(chunkBuf, lKeyHex.value));
        const header = new Uint8Array(FRAME_HDR); const dv = new DataView(header.buffer);
        dv.setUint16(0, fi); dv.setUint32(2, ci); dv.setUint32(6, plainLen);
        const frame = new Uint8Array(header.length + enc.length); frame.set(header, 0); frame.set(enc, header.length);
        if (useRtc && ch) {
          if (ch.bufferedAmount > LOW) await localSafeDrain(ch);
          const ok = await lRtc!.sendFrame(frame);
          if (!ok) throw new Error('P2P 通道发送失败，请重试');
        } else {
          if (ws.bufferedAmount > LOW) await localSafeDrain(ws);
          ws.send(frame);
        }
        offset += plainLen; ci++; sent += plainLen;
        lProgress.value = total ? sent / total : 1;
      }
    }
    // 双通道发「完成」信号：P2P 下若 WS 的 done 因通道差异未达，DC 上的 EOF 帧可兜底完成
    if (useRtc && ch && lRtc && lRtc.isOpen()) {
      try {
        const eof = new Uint8Array(FRAME_HDR);
        new DataView(eof.buffer).setUint16(0, 0xFFFF); // 0xFFFF = 结束标记
        await lRtc.sendFrame(eof);
      } catch { /* 忽略，下面 WS 兜底 */ }
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'done' }));
    lDone.value = true; lStatus.value = '传输完成';
  } catch (e: any) { lStatus.value = `传输出错: ${e?.message || e}`; }
  finally { lSending.value = false; }
}

function localSafeDrain(target: any): Promise<void> {
  if (!target || target.bufferedAmount <= LOW) return Promise.resolve();
  return new Promise((resolve) => {
    const onLow = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, DRAIN_TIMEOUT_MS);
    function cleanup() { clearTimeout(timer); target.removeEventListener('bufferedamountlow', onLow as any); target.removeEventListener('close', onClose as any); }
    target.addEventListener('bufferedamountlow', onLow as any, { once: true });
    target.addEventListener('close', onClose as any, { once: true });
  });
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

// 组件卸载时清理本地直传 WebSocket
onUnmounted(() => { closeLocalWs(); });
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
      <p class="hint">文件只在内存里经网站流转，不落服务器磁盘；双方需同时在线，关闭即止。</p>

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
          <span class="transport" :class="{ p2p: lRtcOpen }">{{ lRtcOpen ? 'P2P 直连' : '经中继转发' }}</span>
        </div>
        <div class="actions">
          <button class="btn primary" :disabled="lSending || lDone || !lPeerOnline" @click="startLocalSend">
            {{ lSending ? '传输中…' : lDone ? '已完成' : (lPeerOnline ? '开始传输' : '等待对方加入…') }}
          </button>
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
