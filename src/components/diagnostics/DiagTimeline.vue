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
.tl { list-style: none; margin: 0; padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 4px; border-top: 0.5px solid rgba(120, 140, 160, 0.15); }
.tl li { display: flex; gap: 8px; align-items: baseline; font-size: 10.5px; line-height: 1.5; font-family: ui-monospace, monospace; }
.tl li.error { color: #A8473C; }
.tl li.warn { color: #9A6E1E; }
.tl li.info, .tl li.debug { color: #5C656E; }
.ts { color: #9AA3AC; flex: 0 0 auto; }
.ch { color: #6E97C0; flex: 0 0 auto; }
.msg { word-break: break-all; }
</style>
