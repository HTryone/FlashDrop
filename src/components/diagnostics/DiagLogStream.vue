<script setup lang="ts">
// 实时日志流：按 channel 过滤 + level 染色（§5）。
import { computed } from 'vue';
import type { LogEntry } from '../../diagnostics/types';

const props = defineProps<{ entries: LogEntry[]; channel?: string | null }>();
defineEmits<{ clear: [] }>();

const filtered = computed(() => {
  const list = props.channel
    ? props.entries.filter((e) => e.channel === props.channel)
    : props.entries;
  return list.slice(-200); // 仅展示最近 200 条，避免 DOM 爆炸
});

function ts(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 行首符号：perf 通道用 ⚡ 强调性能埋点，其余按 level 映射。
function sym(e: LogEntry): string {
  if (e.channel === 'perf') return '⚡';
  switch (e.level) {
    case 'error': return '❌';
    case 'warn': return '⚠';
    case 'info': return 'ℹ';
    default: return '·';
  }
}
</script>

<template>
  <div class="stream">
    <div class="top">
      <span class="t">实时日志流</span>
      <span v-if="channel" class="filter">{{ channel }} <i @click="$emit('clear')">✕</i></span>
    </div>
    <div class="rows">
      <div v-for="(e, i) in filtered" :key="i" class="row" :class="e.level">
        <div class="head">
          <span class="ts">{{ ts(e.ts) }}</span>
          <span class="sym" :class="e.level">{{ sym(e) }}</span>
          <span class="ch">{{ e.channel }}</span>
        </div>
        <div class="body">{{ e.msg }}</div>
      </div>
      <div v-if="!filtered.length" class="empty">暂无日志</div>
    </div>
  </div>
</template>

<style scoped>
.stream { margin-bottom: 12px; }
.top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; padding: 0 2px; }
.t { font-size: 12px; color: var(--text-dim); }
.filter {
  font-size: 12px; color: var(--accent); background: rgba(109, 139, 255, 0.12);
  border: 1px solid rgba(109, 139, 255, 0.35); border-radius: 999px;
  padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px;
}
.filter i { font-style: normal; cursor: pointer; padding: 0 2px; }
.rows {
  display: flex; flex-direction: column; gap: 3px;
  max-height: 38vh; overflow-y: auto; -webkit-overflow-scrolling: touch;
  border: 1px solid var(--border); border-radius: 10px; padding: 4px 6px;
  background: rgba(255, 255, 255, 0.02);
  scrollbar-width: thin; scrollbar-color: var(--border) transparent;
}
.rows::-webkit-scrollbar { width: 6px; }
.rows::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.rows::-webkit-scrollbar-track { background: transparent; }
.row { display: flex; flex-direction: column; gap: 3px; align-items: stretch; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10.5px; line-height: 1.45; padding: 5px 8px; border-radius: 7px; }
.row.error { background: rgba(255, 107, 129, 0.12); }
.row.warn { background: rgba(255, 205, 107, 0.12); }
.row.info { background: rgba(255, 255, 255, 0.04); }
.row.debug { background: rgba(255, 255, 255, 0.02); }
/* 第一行：日期 + 符号 + channel */
.head { display: flex; gap: 8px; align-items: center; }
.ts { color: var(--text-faint); flex: 0 0 auto; }
.sym { font-weight: 700; flex: 0 0 auto; }
.sym.error { color: #ff9aa9; } .sym.warn { color: var(--warn); }
.sym.info { color: var(--accent); } .sym.debug { color: var(--text-faint); }
.ch { font-size: 10px; color: var(--accent); background: rgba(109, 139, 255, 0.12); border: 1px solid rgba(109, 139, 255, 0.3); border-radius: 999px; padding: 1px 7px; }
/* 第二行：实际内容 */
.body { word-break: break-all; }
.row.error .body { color: #ffd0d8; } .row.warn .body { color: #ffe6b0; }
.row.info .body { color: var(--text-dim); } .row.debug .body { color: var(--text-faint); }
.empty { font-size: 12px; color: var(--text-faint); padding: 8px; }
</style>
