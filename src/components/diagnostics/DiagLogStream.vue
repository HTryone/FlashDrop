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
  return d.toTimeString().slice(0, 8);
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
        <span class="ts">{{ ts(e.ts) }}</span>
        <span class="lv">{{ e.level[0].toUpperCase() }}</span>
        <span class="ch">{{ e.channel }}</span>
        <span class="msg">{{ e.msg }}</span>
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
.row { display: flex; gap: 7px; align-items: baseline; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10.5px; line-height: 1.55; padding: 4px 8px; border-radius: 7px; }
.row.error { background: rgba(255, 107, 129, 0.12); color: #ff9aa9; }
.row.warn { background: rgba(255, 205, 107, 0.12); color: #ffd98a; }
.row.info { background: rgba(255, 255, 255, 0.04); color: var(--text-dim); }
.row.debug { background: rgba(255, 255, 255, 0.02); color: var(--text-faint); }
.ts { color: var(--text-faint); flex: 0 0 auto; }
.lv { font-weight: 700; flex: 0 0 auto; }
.ch { color: var(--accent); flex: 0 0 auto; }
.msg { word-break: break-all; }
.empty { font-size: 12px; color: var(--text-faint); padding: 8px; }
</style>
