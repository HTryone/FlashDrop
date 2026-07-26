<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import {
  encryptChunk, decryptChunk, deriveKey, randomPassphrase,
  LOCAL_SALT, LOCAL_CHUNK_SIZE,
} from '@/crypto/e2ee';

const CHUNK = LOCAL_CHUNK_SIZE;
const LOW = 8 * 1024 * 1024; // 背压阈值 8MiB

// 默认线上中转（Cloudflare Worker，WSS）。可用构建时 VITE_RELAY_URL=xxx 覆盖。
const RELAY_DEFAULT = 'flashdrop-relay.xianshenghu363.workers.dev';
function resolveRelay() {
  const host = (import.meta as any).env?.VITE_RELAY_URL || RELAY_DEFAULT;
  const proto = (host.includes('workers.dev') || location.protocol === 'https:') ? 'wss' : 'ws';
  return { host, proto };
}

// ---------- 发送方 ----------
const sendFiles = ref<File[]>([]);
const room = ref('');
const passphrase = ref('');
const sendLink = ref('');
const keyHex = ref('');
const sending = ref(false);
const sendDone = ref(false);
const sendProgress = ref(0);
const sendStatus = ref('');
let sendWs: WebSocket | null = null;

function pick(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) sendFiles.value = Array.from(input.files);
}

function genRoom() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  for (let i = 0; i < 6; i++) s += cs[a[i] % cs.length];
  room.value = s;
  passphrase.value = randomPassphrase();
  sendLink.value = `${location.origin}/?tab=local&room=${s}#k=${passphrase.value}`;
  sendStatus.value = '房间已生成，把链接发给对方，再点「开始传输」';
}

async function startSend() {
  if (!room.value || !passphrase.value) return;
  keyHex.value = await deriveKey(passphrase.value, LOCAL_SALT);
  const { host: relayHost, proto } = resolveRelay();
  const ws = new WebSocket(`${proto}://${relayHost}/relay?room=${room.value}&role=sender`);
  (ws as any).bufferedAmountLowThreshold = LOW;
  sendWs = ws;
  sending.value = true;
  sendProgress.value = 0;
  sendStatus.value = '等待对方连接…';

  const sendOpenTimer = window.setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      sendStatus.value = '连接超时：中继不可达，请确认后端已启动或已配置 VITE_RELAY_URL';
      sending.value = false;
      try { ws.close(); } catch { /* ignore */ }
    }
  }, 8000);
  ws.onopen = () => {
    clearTimeout(sendOpenTimer);
    sendStatus.value = '已连上中继，等待对方加入…';
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data);
    if (msg.type === 'receiver-joined') {
      // 对端已连，发送文件清单
      ws.send(JSON.stringify({
        type: 'offer',
        files: sendFiles.value.map((f) => ({ name: f.name, size: f.size })),
      }));
      sendStatus.value = '对方已连接，开始传输…';
    } else if (msg.type === 'ready') {
      void sendLoop(ws);
    } else if (msg.type === 'peer-left') {
      sendStatus.value = '对方已断开';
      sending.value = false;
    }
  };
  ws.onclose = () => { clearTimeout(sendOpenTimer); sending.value = false; };
  ws.onerror = () => { clearTimeout(sendOpenTimer); sendStatus.value = '连接出错（中继不可达或被拦截）'; sending.value = false; };
}

async function sendLoop(ws: WebSocket) {
  const files = sendFiles.value;
  const total = files.reduce((s, f) => s + f.size, 0);
  let sent = 0;
  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    let offset = 0;
    let ci = 0;
    while (offset < file.size) {
      const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
      const plain = new Uint8Array(buf);
      const enc = encryptChunk(plain, keyHex.value);
      const header = new Uint8Array(6);
      const dv = new DataView(header.buffer);
      dv.setUint16(0, fi);
      dv.setUint32(2, ci);
      const frame = new Uint8Array(header.length + enc.length);
      frame.set(header, 0);
      frame.set(enc, header.length);
      if (ws.bufferedAmount > LOW) await drain(ws);
      ws.send(frame);
      offset += buf.byteLength;
      ci++;
      sent += buf.byteLength;
      sendProgress.value = total ? sent / total : 1;
    }
  }
  ws.send(JSON.stringify({ type: 'done' }));
  sendDone.value = true;
  sendStatus.value = '传输完成';
  sending.value = false;
}

function drain(ws: WebSocket): Promise<void> {
  if (ws.bufferedAmount <= LOW) return Promise.resolve();
  return new Promise((res) => ws.addEventListener('bufferedamountlow', () => res(), { once: true }));
}

function copyLink() {
  navigator.clipboard?.writeText(sendLink.value);
  sendStatus.value = '链接已复制';
}

// ---------- 接收方 ----------
const recvRoom = ref(new URLSearchParams(location.search).get('room') || '');
const recvPass = ref(new URLSearchParams(location.hash.slice(1)).get('k') || '');
const recvLinkInput = ref('');
const receiving = ref(false);
const recvReady = ref(false);
const recvFiles = ref<{ name: string; size: number }[]>([]);
const recvProgress = ref(0);
const recvStatus = ref('输入房间码（或粘贴整条链接）后点连接');
let recvWs: WebSocket | null = null;
let parts: Blob[][] = [];
let recvBytes = 0;
let recvTotal = 0;
let recvKey = '';

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
    recvStatus.value = '需要房间码和口令';
    return;
  }
  recvKey = await deriveKey(recvPass.value, LOCAL_SALT);
  const { host: relayHost, proto } = resolveRelay();
  const ws = new WebSocket(`${proto}://${relayHost}/relay?room=${recvRoom.value}&role=receiver`);
  ws.binaryType = 'arraybuffer';
  recvWs = ws;
  receiving.value = true;
  recvStatus.value = '连接中…';

  const openTimer = window.setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      recvStatus.value = '连接超时：中继不可达，请确认后端已启动或已配置 VITE_RELAY_URL';
      receiving.value = false;
      try { ws.close(); } catch { /* ignore */ }
    }
  }, 8000);
  ws.onopen = () => {
    clearTimeout(openTimer);
    recvStatus.value = '已连接，等待对方发送…';
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'offer') {
        recvFiles.value = msg.files;
        recvTotal = msg.files.reduce((s: number, f: any) => s + f.size, 0);
        parts = msg.files.map((f: any) => new Array(Math.ceil(f.size / CHUNK)));
        recvBytes = 0;
        recvReady.value = true;
        recvStatus.value = `收到 ${msg.files.length} 个文件，准备接收`;
        ws.send(JSON.stringify({ type: 'ready' }));
      } else if (msg.type === 'done') {
        finishRecv();
      } else if (msg.type === 'peer-left') {
        recvStatus.value = '对方已断开';
        receiving.value = false;
      }
      return;
    }
    // 二进制数据帧
    const frame = new Uint8Array(ev.data);
    const dv = new DataView(frame.buffer);
    const fi = dv.getUint16(0);
    const ci = dv.getUint32(2);
    const body = frame.slice(6);
    const plain = decryptChunk(body, recvKey);
    parts[fi][ci] = new Blob([plain]);
    recvBytes += plain.length;
    recvProgress.value = recvTotal ? recvBytes / recvTotal : 1;
  };
  ws.onclose = () => { clearTimeout(openTimer); receiving.value = false; };
  ws.onerror = () => { clearTimeout(openTimer); recvStatus.value = '连接出错（中继不可达或被拦截）'; receiving.value = false; };
}

function finishRecv() {
  for (let fi = 0; fi < recvFiles.value.length; fi++) {
    const chunks = parts[fi].filter((c): c is Blob => !!c);
    if (chunks.length !== parts[fi].length) {
      recvStatus.value = `第 ${fi + 1} 个文件分片缺失，接收不完整`;
      receiving.value = false;
      recvReady.value = false;
      return;
    }
    const blob = new Blob(chunks);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = recvFiles.value[fi].name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  recvStatus.value = '接收完成，文件已下载';
  receiving.value = false;
  recvReady.value = false;
}

function fmt(n: number) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

const sendTotal = computed(() => sendFiles.value.reduce((s, f) => s + f.size, 0));

onUnmounted(() => {
  sendWs?.close();
  recvWs?.close();
});
</script>

<template>
  <div class="local">
    <!-- 发送 -->
    <section class="blk">
      <h3>① 发送（本地磁盘 · 实时直传）</h3>
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
        <div class="actions">
          <button class="btn primary" :disabled="sending || sendDone" @click="startSend">
            {{ sending ? '传输中…' : sendDone ? '已完成' : '开始传输' }}
          </button>
        </div>
        <div v-if="sending || sendDone" class="bar">
          <div class="fill" :style="{ width: (sendProgress * 100) + '%' }"></div>
        </div>
      </div>
      <div class="status">{{ sendStatus }}</div>
    </section>

    <hr />

    <!-- 接收 -->
    <section class="blk">
      <h3>② 接收（输入房间码）</h3>
      <div class="recv-form">
        <input v-model="recvRoom" placeholder="房间码（如 K7P2QX）" :disabled="receiving" />
        <input v-model="recvPass" placeholder="口令（链接 #k 后自动填入）" :disabled="receiving" />
      </div>
      <div class="recv-form">
        <input v-model="recvLinkInput" placeholder="或粘贴整条分享链接自动解析" :disabled="receiving" />
        <button class="btn sm" @click="parsePastedLink">解析</button>
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
.status { font-size: 12.5px; color: var(--text-dim); min-height: 16px; }
.btn { border: 1px solid var(--border); background: var(--panel-2); color: var(--text); border-radius: 8px; padding: 9px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn.primary { background: var(--accent-grad); color: #07101f; border: none; }
.btn.sm { padding: 8px 12px; font-size: 12px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
input[type=file] { font-size: 13px; color: var(--text-dim); }
</style>
