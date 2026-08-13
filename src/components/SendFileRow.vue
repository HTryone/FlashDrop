<script setup lang="ts">
import { computed } from 'vue';
import type { QueuedFile } from '@/types/transfer';
import ProgressBar from './ProgressBar.vue';

const props = defineProps<{ qf: QueuedFile; disabled?: boolean }>();
defineEmits<{ remove: [] }>();

const label = computed(() => {
  switch (props.qf.status) {
    case 'done': return '已完成';
    case 'uploading': return '传输中';
    case 'error': return '失败';
    default: return '待发送';
  }
});

const pct = computed(() => {
  if (!props.qf.file.size) return 0;
  return Math.min(100, Math.round((props.qf.uploaded / props.qf.file.size) * 100));
});
</script>

<template>
  <ProgressBar
    :name="qf.relativePath || qf.file.name"
    :size="qf.file.size"
    :statusText="label"
    :value="pct"
    :done="qf.status === 'done'"
    :error="qf.error"
    :show-percent="qf.status !== 'pending'"
  >
    <template #actions>
      <button class="rm" title="移除" :disabled="disabled" @click="$emit('remove')">✕</button>
    </template>
  </ProgressBar>
</template>

<style scoped>
.rm {
  background: none; border: none; color: var(--text-faint);
  font-size: 14px; padding: 4px; border-radius: 6px; flex: none;
}
.rm:hover { color: var(--danger); background: rgba(255, 107, 129, 0.1); }
.rm:disabled { color: var(--text-faint); opacity: 0.4; cursor: not-allowed; }
.rm:disabled:hover { background: none; color: var(--text-faint); }
</style>
