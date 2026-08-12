<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { TransferDetail } from '@/types/transfer';
import { getTransfer, zipUrl } from '@/api/transfer';
import { deriveKey } from '@/crypto/tus-crypto';
import ReceiveFileRow from './ReceiveFileRow.vue';
import LocalTransfer from './LocalTransfer.vue';

const props = defineProps<{ initialCode?: string }>();

// 接收模式：中转接收（分享码/口令）| 本地直传（房间码，无口令）—— 两块均常驻展示，不再用 tab 切换
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
    <!-- ① 中转接收（常驻展示） -->
    <section class="panel-block receive-block">
      <h3 class="block-title"><span class="recv-badge">接收</span> 中转接收（分享码）</h3>
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

      <div v-if="!detail && !loading" class="empty">
        <strong class="empty-title">📥 如何接收文件</strong>
        <ol class="steps">
          <li>把对方发来的 <b>6 位分享码</b>粘贴到上方输入框（或打开对方发来的带码链接）；</li>
          <li>点「获取文件」，稍候即可看到文件列表；</li>
          <li>若文件已加密，输入对方给的<b>口令</b>并点「解锁」；</li>
          <li>点「解密下载」，文件会自动保存到本机（无需选择保存位置）。</li>
        </ol>
      </div>
    </section>

    <hr class="block-sep" />

    <!-- ② 本地直传（常驻展示） -->
    <section class="panel-block">
      <LocalTransfer side="receive" />
    </section>
  </div>
</template>

<style scoped>
.recv { display: flex; flex-direction: column; gap: 16px; }
.panel-block { display: flex; flex-direction: column; gap: 14px; }
.block-title { margin: 0; font-size: 15px; color: var(--text); }
.block-sep { border: none; border-top: 1px solid var(--border); margin: 4px 0; }
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
.empty { background: rgba(56, 225, 200, 0.05); border: 1px solid rgba(56, 225, 200, 0.22); border-radius: var(--radius-sm); padding: 12px 14px; }
.empty-title { color: var(--accent-2); font-size: 13.5px; }
.steps { margin: 8px 0 0; padding-left: 20px; font-size: 12.5px; color: var(--text-dim); line-height: 1.9; }
.steps b { color: var(--text); }
.receive-block { border: 1px solid rgba(56, 225, 200, 0.35); border-radius: var(--radius-sm); padding: 14px; background: rgba(56, 225, 200, 0.04); }
.recv-badge { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 1px; color: #07101f; background: var(--accent-2); border-radius: 6px; padding: 2px 8px; margin-right: 8px; vertical-align: middle; }
.err-box { color: var(--danger); font-size: 13px; background: rgba(255, 107, 129, 0.1); padding: 8px 12px; border-radius: var(--radius-sm); }
.err-box.sm { padding: 6px 10px; font-size: 12px; }
</style>
