<script setup lang="ts">
import type { ReceivedFile } from '@/types/transfer';
import { useReceiveFile } from '@/transfer/tus/useReceiveFile';
import ProgressBar from './ProgressBar.vue';

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
  <ProgressBar
    :name="file.name"
    :size="file.size"
    :statusText="busy ? phase : ''"
    :value="progress * 100"
    :speed="busy ? speed : undefined"
    :error="err ? err + (isNetworkError ? '（多为网络不稳定或跨境链路拥塞，请重试或更换网络）' : '') : undefined"
    :done="done"
    :active="busy"
    accent-left
  >
    <template #leading>
      <div class="tag">接收</div>
    </template>
    <template #actions>
      <template v-if="encrypted && !e2eeKey">
        <span class="lock-hint muted">🔒 输入口令后下载</span>
      </template>
      <span v-else-if="done" class="done-hint">✓ 已保存</span>
      <button v-else-if="!busy" class="btn sm primary" @click="onDownload">
        {{ err ? '重新下载' : (e2eeKey ? '解密下载' : '下载') }}
      </button>
      <button v-else class="btn sm cancel" @click="cancelDownload">取消</button>
    </template>
  </ProgressBar>
</template>

<style scoped>
.tag {
  flex: none; font-size: 11px; font-weight: 700; letter-spacing: 1px;
  color: #07101f; background: var(--accent-2); border-radius: 6px; padding: 3px 8px;
}
.lock-hint { font-size: 12px; white-space: nowrap; }
.done-hint { font-size: 12px; white-space: nowrap; color: var(--accent-2); }
.btn.cancel {
  color: var(--danger);
  border-color: var(--danger);
  background: transparent;
}
</style>
