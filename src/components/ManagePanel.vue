<script setup lang="ts">
import { ref } from 'vue';
import { getLoginTransfer, terminateTransfer } from '@/api/transfer';
import type { LoginTransferDetail } from '@/types/transfer';

const loginInput = ref('');
const loading = ref(false);
const error = ref('');
const detail = ref<LoginTransferDetail | null>(null);
const showTerminate = ref(false);

async function onLookup() {
  const raw = loginInput.value.replace(/\s/g, '');
  if (!raw || raw.length < 16) {
    error.value = '请输入 16 位登录码';
    return;
  }
  loading.value = true;
  error.value = '';
  detail.value = null;
  try {
    detail.value = await getLoginTransfer(raw);
  } catch (e: any) {
    error.value = e?.message || '查询失败';
  } finally {
    loading.value = false;
  }
}

async function confirmTerminate() {
  if (!detail.value) return;
  try {
    await terminateTransfer(detail.value.transferId);
    alert('传输已终止，分享码和登录码均已失效。页面即将刷新。');
    location.reload();
  } catch (e: any) {
    error.value = e?.message || '终止失败';
  }
}

function fmtSize(n: number) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtTime(ts: number) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function remainMs(expiresAt: number): number {
  if (!expiresAt) return 0;
  return Math.max(0, expiresAt - Date.now());
}

function formatLoginCode(raw: string): string {
  if (!raw || raw.length !== 16) return raw;
  return raw.slice(0, 4) + ' ' + raw.slice(4, 8) + ' ' + raw.slice(8, 12) + ' ' + raw.slice(12, 16);
}
</script>

<template>
  <div class="manage">
    <!-- 登录码输入 -->
    <div class="login-box">
      <label>输入你的 16 位登录码</label>
      <p class="hint muted">发送文件时生成的登录码，用于在任意设备查看和管理你的传输</p>
      <div class="login-row">
        <input
          v-model="loginInput"
          type="text"
          class="login-input"
          placeholder="XXXX XXXX XXXX XXXX"
          maxlength="19"
          @keyup.enter="onLookup"
        />
        <button class="btn primary" :disabled="loading" @click="onLookup">
          {{ loading ? '查询中…' : '查看' }}
        </button>
      </div>
      <div v-if="error" class="err-box">{{ error }}</div>
    </div>

    <!-- 传输详情 -->
    <div v-if="detail" class="detail-card" :class="{ expired: detail.expired || detail.terminated }">
      <!-- 状态标签 -->
      <div class="status-bar">
        <span v-if="detail.terminated" class="tag tag-danger">已终止</span>
        <span v-else-if="detail.expired" class="tag tag-warn">已过期</span>
        <span v-else class="tag tag-ok">有效中</span>
        <span v-if="!detail.expired && !detail.terminated" class="faint expire-hint">
          剩余 {{ Math.ceil(remainMs(detail.expiresAt) / 3600000) }} 小时
        </span>
      </div>

      <!-- 基本信息 -->
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">留言</span>
          <span class="info-val">{{ detail.message || '(无)' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">分享码</span>
          <span class="info-val mono">{{ detail.code || '(已作废)' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">登录码</span>
          <span class="info-val mono accent">{{ formatLoginCode(detail.loginCode) }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">创建时间</span>
          <span class="info-val">{{ fmtTime(detail.createdAt) }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">总大小</span>
          <span class="info-val">{{ fmtSize(detail.totalSize) }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">文件数</span>
          <span class="info-val">{{ detail.files.length }} 个</span>
        </div>
      </div>

      <!-- 文件列表 -->
      <div v-if="detail.files.length" class="file-section">
        <div class="section-title">文件列表</div>
        <div class="file-list">
          <div v-for="f in detail.files" :key="f.id" class="file-item">
            <span class="fname" :title="f.name">{{ f.name }}</span>
            <span class="fsize faint">{{ fmtSize(f.size) }}</span>
          </div>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div v-if="!detail.expired && !detail.terminated" class="actions">
        <button class="btn danger" @click="showTerminate = true">取消分享（终止传输）</button>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="!detail && !loading && !error" class="empty-state">
      <div class="empty-icon">📦</div>
      <p>输入登录码后可在此管理你的传输内容</p>
      <p class="muted hint">登录码在发送文件时自动生成，请妥善保存</p>
    </div>

    <!-- 终止确认弹窗 -->
    <Teleport to="body">
      <div v-if="showTerminate" class="modal-overlay" @click.self="showTerminate = false">
        <div class="modal-box">
          <h3>⚠️ 确认终止此传输？</h3>
          <p>此操作将：</p>
          <ul>
            <li><strong>作废分享码</strong> — 接收方无法再下载</li>
            <li><strong>作废登录码</strong> — 你无法再通过此码管理</li>
            <li>页面将自动刷新，本地记忆清除</li>
          </ul>
          <div class="modal-actions">
            <button class="btn ghost" @click="showTerminate = false">取消</button>
            <button class="btn danger" @click="confirmTerminate">确认终止</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.manage { display: flex; flex-direction: column; gap: 20px; }

/* 登录码输入 */
.login-box { text-align: center; }
.login-box label { font-size: 16px; font-weight: 600; }
.hint { font-size: 12.5px; margin-top: 4px; }
.login-row { display: flex; gap: 10px; margin-top: 12px; justify-content: center; }
.login-input {
  background: var(--bg-soft); border: 2px solid var(--border); color: var(--text);
  border-radius: var(--radius); padding: 12px 16px; font-size: 18px;
  font-family: monospace; letter-spacing: 3px; width: 280px; text-align: center;
  outline: none; transition: border-color 0.2s;
}
.login-input:focus { border-color: var(--accent); }
.err-box { color: var(--danger); font-size: 13px; margin-top: 10px; }

/* 详情卡片 */
.detail-card {
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 20px;
}
.detail-card.expired { opacity: 0.7; border-color: var(--text-faint); }

.status-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.tag {
  display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700;
}
.tag-ok { background: rgba(75, 227, 160, 0.15); color: var(--ok); }
.tag-warn { background: rgba(255, 190, 0, 0.15); color: #ffbe00; }
.tag-danger { background: rgba(255, 107, 129, 0.15); color: var(--danger); }
.expire-hint { font-size: 12px; }

.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.info-item { display: flex; flex-direction: column; gap: 3px; }
.info-label { font-size: 11.5px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
.info-val { font-size: 14px; font-weight: 500; word-break: break-all; }
.info-val.mono { font-family: monospace; letter-spacing: 0.5px; }
.info-val.accent { color: var(--accent); }

.file-section { margin-top: 16px; }
.section-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--text-dim); }
.file-list { display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow: auto; }
.file-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 10px; background: var(--panel-2); border-radius: var(--radius-sm); font-size: 13px;
}
.fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px; }
.fsize { font-size: 12px; white-space: nowrap; }

.actions { display: flex; justify-content: flex-end; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }

/* 空状态 */
.empty-state { text-align: center; padding: 40px 20px; color: var(--text-dim); }
.empty-icon { font-size: 48px; margin-bottom: 12px; }

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
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
.btn.danger { background: var(--danger); color: #fff; }
.btn.danger:hover { opacity: 0.9; }

@media (max-width: 640px) {
  .login-input { width: 100%; font-size: 16px; }
  .login-row { flex-direction: column; }
  .info-grid { grid-template-columns: 1fr; }
  .fname { max-width: 200px; }
}
</style>
