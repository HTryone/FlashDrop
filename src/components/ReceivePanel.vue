<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { TransferDetail } from '@/types/transfer';
import { getTransfer, zipUrl } from '@/api/transfer';
import { deriveKey } from '@/crypto/e2ee';
import ReceiveFileRow from './ReceiveFileRow.vue';

const props = defineProps<{ initialCode?: string }>();

const codeInput = ref('');
const detail = ref<TransferDetail | null>(null);
const loading = ref(false);
const error = ref('');
const passphrase = ref('');
const e2eeKey = ref<string | null>(null);
const unlockErr = ref('');

async function load(code?: string) {
  const c = (code ?? codeInput.value).trim().toUpperCase();
  if (!c) return;
  error.value = '';
  loading.value = true;
  detail.value = null;
  e2eeKey.value = null;
  try {
    const d = await getTransfer(c);
    detail.value = d;
    codeInput.value = c;
    if (d.e2ee) passphrase.value = ''; // 需要重新输入口令
  } catch (e: any) {
    error.value = e?.message || '获取失败';
  } finally {
    loading.value = false;
  }
}

async function unlock() {
  unlockErr.value = '';
  if (!detail.value?.e2ee) return;
  if (passphrase.value.length < 4) {
    unlockErr.value = '口令至少 4 位';
    return;
  }
  try {
    e2eeKey.value = await deriveKey(passphrase.value, detail.value.e2ee.salt);
  } catch (e: any) {
    unlockErr.value = '解密失败：口令可能不正确';
  }
}

function fmt(n: number) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtTime(ts: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function remainText(expiresAt: number): string {
  if (!expiresAt) return '';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return '已过期';
  const h = Math.floor(ms / 3600000);
  if (h >= 1) return `剩余约 ${h} 小时`;
  const m = Math.ceil(ms / 60000);
  return `剩余约 ${m} 分钟`;
}

onMounted(() => {
  if (props.initialCode) load(props.initialCode);
});
</script>

<template>
  <div class="recv">
    <div class="code-input">
      <input v-model="codeInput" placeholder="输入 6 位分享码" maxlength="6" @keyup.enter="load()" />
      <button class="btn primary" :disabled="loading" @click="load()">{{ loading ? '查询中…' : '获取文件' }}</button>
    </div>

    <div v-if="error" class="err-box">{{ error }}</div>

    <div v-if="detail" class="result">
      <div class="meta">
        <span class="badge" :class="detail.storage">{{ detail.storage === 'r2' ? 'R2 存储' : '本地存储' }}</span>
        <span v-if="detail.e2ee" class="badge e2ee">🔒 端到端加密</span>
      </div>

      <div v-if="detail.message" class="msg">
        <span class="muted">留言：</span>{{ detail.message }}
      </div>

      <div class="expire-row faint">
        ⏳ 有效期至 {{ fmtTime(detail.expiresAt) }} · {{ remainText(detail.expiresAt) }}
      </div>

      <div v-if="detail.e2ee && !e2eeKey" class="unlock">
        <p class="muted">该传输已加密，输入发送方给的口令以解密：</p>
        <div class="unlock-row">
          <input v-model="passphrase" type="password" placeholder="口令" @keyup.enter="unlock()" />
          <button class="btn primary sm" @click="unlock()">解锁</button>
        </div>
        <div v-if="unlockErr" class="err-box sm">{{ unlockErr }}</div>
      </div>

      <div class="files-head">
        <span>共 {{ detail.files.length }} 个文件</span>
        <a
          v-if="detail.storage !== 'r2' && !detail.e2ee"
          class="btn sm"
          :href="zipUrl(codeInput)"
        >打包下载全部 (zip)</a>
        <span v-else-if="detail.e2ee" class="faint">加密传输请逐文件解密下载</span>
      </div>

      <div class="file-list">
        <ReceiveFileRow
          v-for="f in detail.files"
          :key="f.id"
          :file="f"
          :code="codeInput"
          :e2ee-key="e2eeKey"
          :encrypted="!!detail.e2ee"
        />
      </div>
    </div>

    <div v-if="!detail && !loading" class="empty muted">
      粘贴对方发来的分享码，或打开对方发来的带码链接，即可看到文件列表。
    </div>
  </div>
</template>

<style scoped>
.recv { display: flex; flex-direction: column; gap: 16px; }
.code-input { display: flex; gap: 10px; }
.code-input input {
  flex: 1; background: var(--bg-soft); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 11px 14px; font-size: 15px; letter-spacing: 2px;
  text-transform: uppercase;
}
.code-input input:focus { outline: none; border-color: var(--accent); }
.result { display: flex; flex-direction: column; gap: 14px; }
.meta { display: flex; gap: 8px; }
.badge { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); }
.badge.local { color: var(--accent-2); border-color: rgba(56, 225, 200, 0.4); }
.badge.r2 { color: var(--accent); border-color: rgba(109, 139, 255, 0.4); }
.badge.e2ee { color: var(--warn); border-color: rgba(255, 205, 107, 0.4); }
.msg { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 13.5px; }
.expire-row { font-size: 12px; padding: 6px 0; }
.unlock { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.unlock-row { display: flex; gap: 8px; }
.unlock-row input { flex: 1; background: var(--bg-soft); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius-sm); padding: 9px 12px; }
.unlock-row input:focus { outline: none; border-color: var(--accent); }
.files-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
.file-list { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow: auto; }
.empty { font-size: 13.5px; line-height: 1.7; padding: 10px 0; }
.err-box { color: var(--danger); font-size: 13px; background: rgba(255, 107, 129, 0.1); padding: 8px 12px; border-radius: var(--radius-sm); }
.err-box.sm { padding: 6px 10px; font-size: 12px; }
</style>
