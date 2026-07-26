<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { QueuedFile, StorageType } from '@/types/transfer';
import { createTransfer, refreshCode, setMessage, terminateTransfer, fileUrl, zipUrl } from '@/api/transfer';
import { uploadAll } from '@/composables/useTusUpload';
import { newSalt, E2EE_CHUNK_SIZE, randomPassphrase } from '@/crypto/e2ee';
import SendFileRow from './SendFileRow.vue';
import LocalTransfer from './LocalTransfer.vue';

const emit = defineEmits<{
  (e: 'gotLoginCode', code: string): void;
}>();

// 发送模式：中转发送（带分享码/登录码/有效期/口令）| 本地直传（WebSocket 实时，无有效期/口令）
const sendMode = ref<'relay' | 'local'>('relay');

const files = ref<QueuedFile[]>([]);
const message = ref('');
// E2EE 始终开启，不可关闭
const passphrase = ref(randomPassphrase());
const storagePref = ref<StorageType>('local');
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
</script>

<template>
  <div class="send">
    <!-- 模式切换：中转发送 / 本地直传 -->
    <div class="seg mode-seg">
      <button :class="{ on: sendMode === 'relay' }" @click="sendMode = 'relay'">中转发送</button>
      <button :class="{ on: sendMode === 'local' }" @click="sendMode = 'local'">本地直传</button>
    </div>

    <template v-if="sendMode === 'relay'">
    <!-- 拖拽 / 选择区 -->
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

    <!-- 已选文件 -->
    <div v-if="files.length" class="selected">
      <div class="sel-head">
        <span>已选 {{ files.length }} 个 · {{ fmt(totalSize) }}</span>
        <span class="sel-status" :class="selStatusClass">{{ selStatus }}</span>
        <button class="btn sm ghost" @click="clearSelected" :disabled="uploading">清空所选</button>
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

    <!-- 存储 -->
    <div class="opts">
      <div class="opt">
        <label>存储位置</label>
        <div class="seg">
          <button :class="{ on: storagePref === 'local' }" @click="storagePref = 'local'">本地直传</button>
          <button :class="{ on: storagePref === 'r2' }" @click="storagePref = 'r2'">线上 R2</button>
        </div>
        <small class="faint">实际落盘由服务端配置决定；当前服务：{{ storage === 'r2' ? 'R2' : '本地直传' }}</small>
      </div>
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

    <LocalTransfer v-else side="send" />
  </div>
</template>

<style scoped>
.send { display: flex; flex-direction: column; gap: 16px; }
.drop {
  border: 1.5px dashed var(--border); border-radius: var(--radius);
  padding: 28px; text-align: center; transition: 0.2s; background: var(--bg-soft);
}
.drop.over { border-color: var(--accent); background: rgba(109, 139, 255, 0.08); }
.drop-icon { font-size: 30px; }
.drop-title { font-weight: 600; margin-top: 6px; }
.drop-sub { font-size: 12px; margin: 8px 0; }
.drop-btns { display: flex; gap: 10px; justify-content: center; }
.selected { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; }
.sel-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; margin-bottom: 10px; gap: 8px; flex-wrap: wrap; }
.sel-status { font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
.sel-status.idle { color: var(--accent-2); border-color: rgba(56, 225, 200, 0.4); }
.sel-status.busy { color: var(--warn); border-color: rgba(255, 205, 107, 0.4); }
.sel-status.done { color: var(--ok); border-color: rgba(86, 217, 130, 0.4); }
.file-list { display: flex; flex-direction: column; gap: 8px; max-height: 260px; overflow: auto; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-size: 13px; color: var(--text-dim); }
textarea, .pass {
  background: var(--bg-soft); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 10px; font-size: 13.5px; resize: vertical;
}
textarea:focus, .pass:focus { outline: none; border-color: var(--accent); }
.e2ee-field { background: rgba(109, 139, 255, 0.06); border: 1px solid rgba(109, 139, 255, 0.2); border-radius: var(--radius); padding: 12px; }
.e2ee-field .hint { font-size: 11.5px; }
.badge {
  display: inline-block; background: var(--accent); color: #07101f;
  font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 4px; margin-left: 6px;
}
.pass-row { display: flex; gap: 8px; align-items: center; }
.pass-row .pass { flex: 1; font-family: monospace; letter-spacing: 0.5px; }
.opts { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.opt { display: flex; flex-direction: column; gap: 8px; }
.opt label { font-size: 13px; color: var(--text-dim); }
.opt small { font-size: 11.5px; }
.seg { display: flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.seg button { flex: 1; background: var(--bg-soft); border: none; color: var(--text-dim); padding: 9px; font-size: 13px; }
.seg button.on { background: var(--accent-grad); color: #07101f; font-weight: 700; }
.mode-seg { width: fit-content; margin-bottom: 4px; }
.err-box { color: var(--danger); font-size: 13px; background: rgba(255, 107, 129, 0.1); padding: 8px 12px; border-radius: var(--radius-sm); }
.actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ok-tag { color: var(--ok); font-weight: 600; }
.hint-start { font-size: 12px; }

/* 分享码卡片 */
.code-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.code-section { text-align: center; }
.code-label { font-size: 12px; }
.code-value { font-size: 40px; font-weight: 800; letter-spacing: 4px; margin: 4px 0 12px; }
.login-code-value {
  font-size: 22px; font-weight: 700; letter-spacing: 3px; font-family: monospace;
  color: var(--accent); margin: 6px 0 10px; user-select: all;
}
.code-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.code-link { font-size: 11.5px; margin-top: 10px; word-break: break-all; }
.divider { height: 1px; background: var(--border); margin: 16px 0; }

/* 弹窗 */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 999;
  display: flex; align-items: center; justify-content: center;
}
.modal-box {
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 24px; max-width: 420px; width: 90%;
}
.modal-box h3 { margin: 0 0 12px; font-size: 16px; }
.modal-box p { font-size: 13.5px; color: var(--text-dim); line-height: 1.6; margin: 8px 0; }
.modal-box ul { font-size: 13px; color: var(--text-dim); line-height: 1.8; padding-left: 20px; margin: 8px 0; }
.warn-text { color: var(--danger) !important; font-size: 12.5px !important; }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
.btn.danger { background: var(--danger); color: #fff; }
.btn.danger:hover { opacity: 0.9; }

@media (max-width: 640px) { .opts { grid-template-columns: 1fr; } .pass-row { flex-wrap: wrap; } }
</style>
