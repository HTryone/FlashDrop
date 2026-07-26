<script setup lang="ts">
import { ref, computed } from 'vue';
import type { QueuedFile, StorageType } from '@/types/transfer';
import { createTransfer, refreshCode, fileUrl, zipUrl } from '@/api/transfer';
import { uploadAll } from '@/composables/useTusUpload';
import { newSalt, E2EE_CHUNK_SIZE } from '@/crypto/e2ee';
import SendFileRow from './SendFileRow.vue';

const files = ref<QueuedFile[]>([]);
const message = ref('');
const e2eeEnabled = ref(false);
const passphrase = ref('');
const storagePref = ref<StorageType>('local'); // 偏好（实际以服务端为准）

const transferId = ref('');
const code = ref('');
const storage = ref<StorageType>('local');
const started = ref(false);
const uploading = ref(false);
const dragOver = ref(false);
const error = ref('');

const totalSize = computed(() => files.value.reduce((s, f) => s + f.file.size, 0));
const doneCount = computed(() => files.value.filter((f) => f.status === 'done').length);
const allDone = computed(() => files.value.length > 0 && doneCount.value === files.value.length);

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

async function start() {
  error.value = '';
  if (!files.value.length) {
    error.value = '请先选择要发送的文件';
    return;
  }
  if (e2eeEnabled.value && passphrase.value.length < 4) {
    error.value = '端到端加密口令至少 4 位';
    return;
  }
  uploading.value = true;
  try {
    if (!transferId.value) transferId.value = crypto.randomUUID();
    let e2eeMeta: { salt: string; chunkSize: number } | null = null;
    if (e2eeEnabled.value) e2eeMeta = { salt: newSalt(), chunkSize: E2EE_CHUNK_SIZE };
    const resp = await createTransfer(transferId.value, message.value, e2eeMeta);
    code.value = resp.code;
    storage.value = resp.storage;
    started.value = true;

    const salt = e2eeMeta?.salt;
    await uploadAll(files.value, {
      transferId: transferId.value,
      e2ee: { enabled: e2eeEnabled.value, passphrase: passphrase.value },
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

function copyLink() {
  if (!shareLink.value) return;
  navigator.clipboard?.writeText(shareLink.value);
}

function fmt(n: number) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
</script>

<template>
  <div class="send">
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

    <!-- 存储 & 加密 -->
    <div class="opts">
      <div class="opt">
        <label>存储位置</label>
        <div class="seg">
          <button :class="{ on: storagePref === 'local' }" @click="storagePref = 'local'">本地磁盘</button>
          <button :class="{ on: storagePref === 'r2' }" @click="storagePref = 'r2'">线上 R2</button>
        </div>
        <small class="faint">实际落盘由服务端配置决定；当前服务：{{ storage === 'r2' ? 'R2' : '本地磁盘' }}</small>
      </div>
      <div class="opt">
        <label class="e2ee-label">
          <input type="checkbox" v-model="e2eeEnabled" />
          端到端加密（服务器零知识）
        </label>
        <input
          v-if="e2eeEnabled"
          v-model="passphrase"
          type="password"
          class="pass"
          placeholder="设一个口令，告诉接收方"
        />
      </div>
    </div>

    <div v-if="error" class="err-box">{{ error }}</div>

    <div class="actions">
      <button class="btn primary" :disabled="uploading || allDone" @click="start">
        {{ uploading ? '传输中…' : started ? '继续传输' : '开始传输' }}
      </button>
      <span v-if="allDone" class="ok-tag">✓ 全部完成</span>
    </div>

    <!-- 分享码 -->
    <div v-if="code" class="code-card">
      <div class="code-label muted">分享码</div>
      <div class="code-value gradient-text">{{ code }}</div>
      <div class="code-actions">
        <button class="btn sm" @click="copyLink">复制链接</button>
        <button class="btn sm" @click="onRefresh">刷新换码</button>
        <a class="btn sm" :href="zipUrl(code)" v-if="storage !== 'r2' && !e2eeEnabled">打包下载全部</a>
      </div>
      <div class="code-link faint">{{ shareLink }}</div>
    </div>
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
.sel-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; margin-bottom: 10px; }
.file-list { display: flex; flex-direction: column; gap: 8px; max-height: 260px; overflow: auto; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-size: 13px; color: var(--text-dim); }
textarea, .pass {
  background: var(--bg-soft); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 10px; font-size: 13.5px; resize: vertical;
}
textarea:focus, .pass:focus { outline: none; border-color: var(--accent); }
.opts { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.opt { display: flex; flex-direction: column; gap: 8px; }
.opt label { font-size: 13px; color: var(--text-dim); }
.opt small { font-size: 11.5px; }
.seg { display: flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.seg button { flex: 1; background: var(--bg-soft); border: none; color: var(--text-dim); padding: 9px; font-size: 13px; }
.seg button.on { background: var(--accent-grad); color: #07101f; font-weight: 700; }
.e2ee-label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.e2ee-label input { width: 16px; height: 16px; accent-color: var(--accent); }
.err-box { color: var(--danger); font-size: 13px; background: rgba(255, 107, 129, 0.1); padding: 8px 12px; border-radius: var(--radius-sm); }
.actions { display: flex; align-items: center; gap: 12px; }
.ok-tag { color: var(--ok); font-weight: 600; }
.code-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; text-align: center; }
.code-label { font-size: 12px; }
.code-value { font-size: 40px; font-weight: 800; letter-spacing: 4px; margin: 4px 0 12px; }
.code-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.code-link { font-size: 11.5px; margin-top: 10px; word-break: break-all; }
@media (max-width: 640px) { .opts { grid-template-columns: 1fr; } }
</style>
