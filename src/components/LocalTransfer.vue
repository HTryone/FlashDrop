<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { LocalReceiver } from '@/https';

// 由父组件（接收面板）指定渲染哪一侧；不传则两侧都渲染
const props = defineProps<{ side?: 'send' | 'receive' }>();

// UI 绑定的房间码 / 口令（与 LocalReceiver 内部状态双向同步）
const recvRoom = ref(new URLSearchParams(location.search).get('room') || '');
const recvPass = ref(new URLSearchParams(location.hash.slice(1)).get('k') || '');
const recvLinkInput = ref('');
const receiving = ref(false);
const recvReady = ref(false);
const senderOnline = ref(false);
const recvFiles = ref<{ name: string; size: number }[]>([]);
const recvProgress = ref(0);
const recvStatus = ref('输入房间码（或粘贴整条链接）后点连接');
const recvSegCount = ref(1);

// 本地直传核心逻辑全部在 src/transfer/local/receiver.ts，这里只更新 UI
const receiver = new LocalReceiver({
  onStatus: (s) => { recvStatus.value = s; },
  onRecvReady: (v) => { recvReady.value = v; },
  onSenderOnline: (v) => { senderOnline.value = v; },
  onFiles: (files) => { recvFiles.value = files; },
  onProgress: (p) => { recvProgress.value = p; },
  onSegCount: (n) => { recvSegCount.value = n; },
  onReceiving: (v) => { receiving.value = v; },
});

// 从 URL 自动填入房间码 / 口令
receiver.setRoom(recvRoom.value);
receiver.setPass(recvPass.value);
// 手动编辑输入框时同步给核心
watch(recvRoom, (v) => receiver.setRoom(v));
watch(recvPass, (v) => receiver.setPass(v));

function parsePastedLink() {
  receiver.parseLink(recvLinkInput.value);
  recvRoom.value = receiver.room;
  recvPass.value = receiver.pass;
}

function startRecv() { receiver.start(); }
function onCancelRecv() { receiver.cancel(); }

function fmt(n: number) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

onUnmounted(() => { receiver.close(); });
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
