<script setup lang="ts">
import type { ReceivedFile } from '@/types/transfer';
import { useReceiveFile } from '@/transfer/tus/useReceiveFile';
import ProgressBar from './ProgressBar.vue';
import { formatBytes } from '@/composables/format';

const props = defineProps<{
  file: ReceivedFile;
  code: string;
  e2eeKey: string | null;
  encrypted: boolean;
}>();

// 核心下载逻辑（状态机 / 进度 / 速度 / 取消 / 错误分类）已全部下沉到 useReceiveFile.ts。
// 本组件仅承担框架层职责：模板渲染 + props 透传 + 事件绑定。
const { busy, done, err, progress, speed, phase, isNetworkError, onDownload, cancelDownload } = useReceiveFile(props);
</script>

<template>
  <div class="row" :class="{ active: busy }">
    <div class="tag">接收</div>
    <div class="info">
      <div class="name" :title="file.name">{{ file.name }}</div>
      <div class="sub muted">
        <span class="sub-l">{{ formatBytes(file.size) }}<span v-if="busy" class="prog-text"> · {{ phase }} {{ (progress * 100).toFixed(0) }}%</span></span>
        <span v-if="busy" class="speed">{{ speed.toFixed(1) }} MB/s</span>
      </div>
      <ProgressBar v-if="busy" :value="progress * 100" />
      <div v-if="err" class="err-line">⚠ {{ err }}<span v-if="isNetworkError" class="err-hint">（多为网络不稳定或跨境链路拥塞，请重试或更换网络）</span></div>
    </div>
    <template v-if="encrypted && !e2eeKey">
      <span class="lock-hint muted">🔒 输入口令后下载</span>
    </template>
      <span v-else-if="done" class="done-hint">✓ 已保存到本机</span>
      <button v-else-if="!busy" class="btn sm primary" @click="onDownload">
        {{ err ? '重新下载' : (e2eeKey ? '解密下载' : '下载') }}
      </button>
      <button v-else class="btn sm cancel" @click="cancelDownload">取消</button>
  </div>
</template>

<style scoped>
.row {
  display: flex; align-items: center; gap: 12px;
  background: var(--panel); border: 1px solid rgba(255, 255, 255, 0.12);
  border-left: 3px solid var(--accent-2);
  border-radius: var(--radius-sm); padding: 10px 12px;
}
.row.active {
  border-color: var(--accent-2);
  box-shadow: 0 0 0 1px rgba(56, 225, 200, 0.25);
}
.tag {
  flex: none; font-size: 11px; font-weight: 700; letter-spacing: 1px;
  color: #07101f; background: var(--accent-2); border-radius: 6px; padding: 3px 8px;
}
.info { flex: 1; min-width: 0; }
.name { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: 12px; margin-top: 3px; display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.sub-l { min-width: 0; }
.prog-text { color: var(--accent-2); }
.speed { flex: none; white-space: nowrap; color: var(--accent-2); font-variant-numeric: tabular-nums; }
.err { color: var(--danger); }
.err-line { color: var(--danger); font-size: 12px; margin-top: 6px; line-height: 1.4; }
.err-hint { opacity: 0.82; margin-left: 2px; }
.lock-hint { font-size: 12px; white-space: nowrap; }
.done-hint { font-size: 12px; white-space: nowrap; color: var(--accent-2); }
.btn.cancel {
  color: var(--danger);
  border-color: var(--danger);
  background: transparent;
}

</style>
