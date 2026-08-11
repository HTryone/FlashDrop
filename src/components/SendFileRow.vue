<script setup lang="ts">
import { computed } from 'vue';
import type { QueuedFile } from '@/types/transfer';

const props = defineProps<{ qf: QueuedFile; disabled?: boolean }>();
defineEmits<{ remove: [] }>();

const pct = computed(() => {
  if (!props.qf.file.size) return 0;
  return Math.min(100, Math.round((props.qf.uploaded / props.qf.file.size) * 100));
});

const label = computed(() => {
  switch (props.qf.status) {
    case 'done': return '已完成';
    case 'uploading': return '传输中';
    case 'error': return '失败';
    default: return '待发送';
  }
});

function fmt(n: number) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
</script>

<template>
  <div class="row" :class="qf.status">
    <div class="info">
      <div class="name" :title="qf.relativePath">{{ qf.relativePath || qf.file.name }}</div>
      <div class="sub muted">
        {{ fmt(qf.file.size) }} · <span :class="qf.status === 'error' ? 'err' : ''">{{ label }}</span>
        <span v-if="qf.error" class="err"> · {{ qf.error }}</span>
      </div>
      <div class="bar"><div class="fill" :style="{ width: pct + '%' }"></div></div>
    </div>
    <button class="rm" title="移除" :disabled="disabled" @click="$emit('remove')">✕</button>
  </div>
</template>

<style scoped>
.row {
  display: flex; align-items: center; gap: 12px;
  background: var(--panel-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 10px 12px;
}
.row.done { border-color: rgba(75, 227, 160, 0.35); }
.row.error { border-color: rgba(255, 107, 129, 0.4); }
.info { flex: 1; min-width: 0; }
.name { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: 12px; margin: 3px 0 6px; }
.err { color: var(--danger); }
.bar { height: 6px; background: #0c1120; border-radius: 4px; overflow: hidden; }
.fill { height: 100%; background: var(--accent-grad); transition: width 0.2s; }
.row.done .fill { background: var(--ok); }
.rm {
  background: none; border: none; color: var(--text-faint);
  font-size: 14px; padding: 4px; border-radius: 6px;
}
.rm:hover { color: var(--danger); background: rgba(255, 107, 129, 0.1); }
.rm:disabled { color: var(--text-faint); opacity: 0.4; cursor: not-allowed; }
.rm:disabled:hover { background: none; color: var(--text-faint); }
</style>
