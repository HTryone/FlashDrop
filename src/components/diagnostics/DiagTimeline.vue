<script setup lang="ts">
// 单会话时间线：连接 → 协商 → 分片 → 落盘 → 校验 → 完成/失败（§1.2 / §1.3 铁律检查点）。
import type { LogEntry } from '../../diagnostics/types';

defineProps<{ entries: LogEntry[] }>();

function ts(t: number): string {
  return new Date(t).toTimeString().slice(0, 8);
}
</script>

<template>
  <ol class="tl">
    <li v-for="(e, i) in entries" :key="i" :class="e.level">
      <span class="ts">{{ ts(e.ts) }}</span>
      <span class="ch">{{ e.channel }}</span>
      <span class="msg">{{ e.msg }}</span>
    </li>
  </ol>
</template>

<style scoped>
.tl { list-style: none; margin: 0; padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid rgba(255, 255, 255, 0.07); }
.tl li { display: flex; gap: 8px; align-items: baseline; font-size: 10.5px; line-height: 1.5; font-family: ui-monospace, monospace; }
.tl li.error { color: #ff9aa9; }
.tl li.warn { color: #ffd98a; }
.tl li.info, .tl li.debug { color: var(--text-dim); }
.ts { color: var(--text-faint); flex: 0 0 auto; }
.ch { color: var(--accent); flex: 0 0 auto; }
.msg { word-break: break-all; }
</style>
