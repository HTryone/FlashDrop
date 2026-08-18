<script setup lang="ts">
// 实时日志流：滚动 + 关键字过滤 + level 染色（§5）。
import { ref, computed } from 'vue';
import type { LogEntry } from '../../diagnostics/types';

const props = defineProps<{ entries: LogEntry[] }>();
const kw = ref('');

const filtered = computed(() => {
  const k = kw.value.trim().toLowerCase();
  const list = k
    ? props.entries.filter((e) => `${e.channel} ${e.scope} ${e.msg}`.toLowerCase().includes(k))
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
      <input v-model="kw" class="kw" placeholder="过滤关键字" />
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
.top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.t { font-size: 12px; color: #7C8794; }
.kw { width: 160px; font-size: 12px; padding: 5px 10px; border-radius: 8px; border: 0.5px solid rgba(120, 140, 160, 0.25); background: rgba(255, 255, 255, 0.7); color: #485058; }
.rows { max-height: 200px; overflow: auto; display: flex; flex-direction: column; gap: 3px; }
.row { display: flex; gap: 7px; align-items: baseline; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10.5px; line-height: 1.55; padding: 4px 8px; border-radius: 7px; }
.row.error { background: #FBEDEA; color: #A8473C; }
.row.warn { background: #FBF2E2; color: #9A6E1E; }
.row.info { background: rgba(255, 255, 255, 0.7); color: #5C656E; }
.row.debug { background: rgba(255, 255, 255, 0.5); color: #8A929B; }
.ts { color: #9AA3AC; flex: 0 0 auto; }
.lv { font-weight: 700; flex: 0 0 auto; }
.ch { color: #6E97C0; flex: 0 0 auto; }
.msg { word-break: break-all; }
.empty { font-size: 12px; color: #9AA3AC; padding: 8px; }
</style>
