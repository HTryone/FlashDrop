<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import type { QueuedFile, StorageType } from '@/types/transfer';
import { createTransfer, refreshCode, setMessage, terminateTransfer, zipUrl } from '@/api/transfer';
import { uploadAll } from '@/transfer/tus/useTusUpload';
import { newSalt, E2EE_CHUNK_SIZE, randomPassphrase } from '@/crypto/tus-crypto';
import SendFileRow from './SendFileRow.vue';
import { LocalSender } from '@/https';
import { resolveRelayBase } from '@/transfer/room';
import { createP2PSender } from '@/p2p';
import { SignalingClient } from '@/p2p/signaling';

const emit = defineEmits<{
  (e: 'gotLoginCode', code: string): void;
}>();

// 发送方式：中转发送（带分享码/登录码/有效期/口令）| 本地直传（HTTP 流式实时，无有效期/口令）
const sendMode = ref<'relay' | 'local'>('relay');

const files = ref<QueuedFile[]>([]);
const message = ref('');
// E2EE 始终开启，不可关闭
const passphrase = ref(randomPassphrase());
// 有效期固定 24 小时（房间自动清除，不可更改）：分享码 / 登录码 / 文件统一过期
const TTL_HOURS = 24;

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

// ========== 本地直传（HTTP 流式中继）—— 核心逻辑在 src/transfer/local/sender.ts ==========
const lRoom = ref('');
const lPassphrase = ref('');
const lSendLink = ref('');
const lSending = ref(false);
const lDone = ref(false);
const lProgress = ref(0);
const lStatus = ref('');
const lPeerOnline = ref(false);
const lSegIndex = ref(0);   // 当前段（0 基），用于 UI 展示
// 发送端自身状态灯：房间一生成即亮，独立于对方是否在线（解决"只能靠接收端才亮"）
const lSelfActive = computed(() => !!lRoom.value);

const sender = new LocalSender({
  onStatus: (s) => { lStatus.value = s; },
  onPeerOnline: (v) => { lPeerOnline.value = v; },
  onProgress: (p) => { lProgress.value = p; },
  onSegIndex: (i) => { lSegIndex.value = i; },
  onSending: (v) => { lSending.value = v; },
  onDone: () => { lDone.value = true; },
  onRoom: (room, link, pass) => { lRoom.value = room; lSendLink.value = link; lPassphrase.value = pass; },
});

function genRoom() {
  // 先清理旧的提前信令（重新生成房间时）
  if (p2pEarlySig) { p2pEarlySig.close(); p2pEarlySig = null; }
  sender.genRoom();
}

// ---------- P2P 直连发送（独立模块 @/p2p，复用同一房间码/口令/文件，不触碰 HTTP 代码）----------
const localTransport = ref<'http' | 'p2p'>('http');
let p2pSender: ReturnType<typeof createP2PSender> | null = null;
// P2P 提前信令：genRoom 时即连 WS，不等点"开始传输"。
// 这样对方一点"连接接收"，relay 就能通过 peer-joined 通知发送端亮灯。
let p2pEarlySig: SignalingClient | null = null;

// 确保提前信令 WS 已连：P2P 模式下、房间已存在、且尚未连接时才创建。
// 关键修复：房间常在 http 模式下就生成（watch(lRoom) 当时因 mode!=='p2p' 已 return），
// 用户之后才切到 P2P——必须在 watch(localTransport) 切到 p2p 时补连，否则发送端信令 WS 永不打开，
// relay 的 peer-joined 无从送达，接收端一点「连接接收」发送端灯也不亮。
function ensureEarlySig() {
  if (localTransport.value !== 'p2p') return;
  if (!lRoom.value || p2pEarlySig) return;
  p2pEarlySig = new SignalingClient({
    relayBase: resolveRelayBase(),
    room: lRoom.value,
    role: 'sender',
    onSignal: () => {}, // 占位：PeerLink 建立后会通过 setOnSignal 接管
    onPeerConnected: (role) => {
      if (role === 'receiver' && !lSending.value && !lDone.value) {
        lPeerOnline.value = true;
        lStatus.value = '对方已加入，可点「开始传输」';
      }
    },
  });
  p2pEarlySig.connect();
}

// 房间一生成（且当前已是 P2P 模式）即连提前信令
watch(lRoom, () => ensureEarlySig());
// 切到 P2P 模式（房间可能已先生成于 http 模式）时补连提前信令；切走则断开
watch(localTransport, (mode) => {
  if (mode === 'p2p') ensureEarlySig();
  else if (p2pEarlySig) {
    p2pEarlySig.close();
    p2pEarlySig = null;
    lPeerOnline.value = false;
  }
});

async function runP2PLocalSend() {
  if (!lRoom.value || !lPassphrase.value) { lStatus.value = '请先生成房间'; return; }
  if (!files.value.length) { lStatus.value = '没有待发送文件'; return; }
  lSending.value = true; lProgress.value = 0; lDone.value = false;
  lStatus.value = 'P2P 信令协商中…';
  const sender = createP2PSender({
    relayBase: resolveRelayBase(),
    room: lRoom.value,
    pass: lPassphrase.value,
    files: files.value.map((f) => f.file),
    onState: (s, d) => {
      if (s === 'signaling') { lStatus.value = 'P2P 信令已接通，等待 ICE 协商…'; }
      else if (s === 'connecting') { lPeerOnline.value = true; lStatus.value = 'ICE 协商中，正在建立直连…'; }
      else if (s === 'connected') { lPeerOnline.value = true; lStatus.value = 'P2P 直连已建立，开始传输…'; }
      else if (s === 'transferring') { lPeerOnline.value = true; lStatus.value = 'P2P 传输中…'; }
      else if (s === 'done') { lDone.value = true; lStatus.value = 'P2P 发送完成'; }
      else if (s === 'error') { lPeerOnline.value = false; lStatus.value = `P2P 出错：${d || ''}`; }
      else if (s === 'aborted') { lPeerOnline.value = false; lStatus.value = '已取消'; }
    },
    // 对端信令到达（offer/answer）：更新状态反映协商进展。
    // 不再守卫 lPeerOnline——提前信令已在对方加入时亮灯，这里负责"点了发送后"的状态推进。
    onPeerJoined: () => {
      if (!lSending.value) return; // 还没点发送，不重复提示（提前信令的 onPeerConnected 已处理）
      lStatus.value = '对端已响应，ICE 协商中…';
    },
    // 对端经信令房上线（WS 连上即触发，早于 SDP）：兜底点亮在线灯（提前信令 WS 异常时仍能亮）
    onPeerPresent: (role) => {
      if (role === 'receiver') { lPeerOnline.value = true; lStatus.value = '对方已就位，可点「开始传输」'; }
    },
    onProgress: (p) => { lProgress.value = p.total ? p.sent / p.total : 0; },
    onFail: (e) => { lStatus.value = `P2P 传输失败：${e.message}`; lDone.value = false; },
  });
  p2pSender = sender;
  try {
    await sender.connect(p2pEarlySig || undefined); // 复用提前连好的信令 WS
    p2pEarlySig = null; // 所有权已转移给 sender，避免重复 close
  } catch (e: any) {
    lStatus.value = `P2P 连接失败：${e?.message || e}`;
    lSending.value = false;
  }
}

function startLocalSend() {
  if (localTransport.value === 'p2p') { void runP2PLocalSend(); return; }
  sender.startSend(files.value.map((f) => ({ file: f.file })));
}
function cancelLocalSend() {
  if (p2pSender) { p2pSender.abort(); p2pSender = null; }
  if (p2pEarlySig) { p2pEarlySig.close(); p2pEarlySig = null; }
  sender.cancel();
}
function copyLocalLink() { navigator.clipboard?.writeText(sender.link); lStatus.value = '链接已复制'; }

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
  // E2EE 使用 WebCrypto（tus-crypto.ts），AES-NI 硬件加速
  uploading.value = true;
  try {
    if (!transferId.value) transferId.value = generateUUID();
    const e2eeMeta = { salt: newSalt(), chunkSize: E2EE_CHUNK_SIZE };
    const resp = await createTransfer(transferId.value, message.value, e2eeMeta, TTL_HOURS);
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

/** 一键复制：分享链接 + 解密口令（类似百度网盘分享格式） */
function copyShareAll() {
  if (!shareLink.value || !passphrase.value) return;
  const text = `分享链接：${shareLink.value}\n解密口令：${passphrase.value}`;
  navigator.clipboard?.writeText(text);
}

function copyLoginCode() {
  if (!loginCode.value) return;
  navigator.clipboard?.writeText(loginCode.value.replace(/\s/g, ''));
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

// 组件卸载时清理本地直传连接 + 提前信令
onUnmounted(() => { sender.close(); if (p2pEarlySig) { p2pEarlySig.close(); p2pEarlySig = null; } });
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
          <div class="seg seg-static">
            <span class="on">24 小时（房间自动清除）</span>
          </div>
          <small class="faint">分享码、登录码、文件统一 24 小时后自动清除；过期或乱写分享码返回找不到</small>
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
      <!-- 分享信息（给接收方）：链接 + 解密口令 -->
      <div class="code-section">
        <div class="code-label muted">分享链接</div>
        <div class="code-link">{{ shareLink }}</div>

        <div class="code-label muted" style="margin-top:6px">解密口令</div>
        <div class="pass-display">{{ passphrase }}</div>

        <div class="code-actions" style="margin-top:8px">
          <button class="btn sm primary" @click="copyShareAll">一键复制</button>
          <button class="btn sm" @click="onRefresh">刷新换码</button>
          <a class="btn sm" :href="zipUrl(code)" v-if="storage !== 'r2'">打包下载全部</a>
          <button class="btn sm danger" @click="showTerminateDialog = true" v-if="!uploading">取消分享</button>
        </div>
        <p class="share-hint">📤 把<b>分享链接</b>和<b>解密口令</b>一起发给对方——对方必须输入口令才能解密下载。</p>
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

      <div class="opt" v-if="!lRoom">
        <label>直传方式</label>
        <div class="seg">
          <button :class="{ on: localTransport === 'http' }" @click="localTransport = 'http'">HTTP 中继</button>
          <button :class="{ on: localTransport === 'p2p' }" @click="localTransport = 'p2p'">P2P 直连</button>
        </div>
      </div>
      <p v-if="localTransport === 'p2p'" class="hint">P2P 直连：文件端到端不经服务器中转（仅信令过 relay），适合同网/可穿透场景；NAT 穿透失败请切回 HTTP 中继。</p>

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
          <span class="dot" :class="{ on: lSelfActive }"></span>
          我（发送端）：{{ lSelfActive ? (lSending ? '传输中…' : '已就绪，等待对方') : '未开始' }}
        </div>
        <div class="presence">
          <span class="dot" :class="{ on: lPeerOnline }"></span>
          对方（接收端）：{{ lPeerOnline ? '已在线 ✓' : '等待加入…' }}
        </div>
        <div class="actions">
          <button v-if="!lSending" class="btn primary" :disabled="lDone || !lRoom" @click="startLocalSend">
            {{ lDone ? '已完成' : lPeerOnline ? '对方已就位，开始传输' : '开始传输' }}
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
