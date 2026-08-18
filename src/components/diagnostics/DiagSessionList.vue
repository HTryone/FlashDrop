<script setup lang="ts">
// 会话列表：按 traceId 聚合每次传输；点开展示该会话时间线（§5 / §1.2 / §1.3）。
import { ref, computed } from 'vue';
import type { LogEntry } from '../../diagnostics/types';
import DiagTimeline from './DiagTimeline.vue';

const props = defineProps<{ entries: LogEntry[] }>();
const expanded = ref<string | null>(null);

const sessions = computed(() => {
  const map = new Map<string, LogEntry[]>();
  for (const e of props.entries) {
    const id = e.traceId ?? 'untraced';
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push(e);
  }
  return [...map.entries()]
    .map(([id, es]) => ({ id, count: es.length, es }))
    .sort((a, b) => (b.es[b.es.length - 1]?.ts ?? 0) - (a.es[a.es.length - 1]?.ts ?? 0));
});

function toggle(id: string) {
  expanded.value = expanded.value === id ? null : id;
}
</script>

<template>
  <div class="sess">
    <span class="t">会话 · 按 traceId 聚合</span>
    <div v-for="s in sessions" :key="s.id" class="item" :class="{ bad: s.es.some((e) => e.level === 'error') }">
      <button class="row" @click="toggle(s.id)">
        <span class="id">{{ s.id === 'untraced' ? '未关联' : s.id.slice(0, 8) }}</span>
        <span class="n">{{ s.count }} 条</span>
        <span class="arrow">{{ expanded === s.id ? '▾' : '▸' }}</span>
      </button>
      <DiagTimeline v-if="expanded === s.id" :entries="s.es" />
    </div>
    <div v-if="!sessions.length" class="empty">暂无会话</div>
  </div>
</template>

<style scoped>
.sess { margin-bottom: 4px; }
.t { font-size: 12px; color: #7C8794; display: block; margin-bottom: 6px; }
.item { border: 0.5px solid rgba(120, 140, 160, 0.2); border-radius: 10px; margin-bottom: 6px; overflow: hidden; background: rgba(255, 255, 255, 0.6); }
.item.bad { border-color: rgba(226, 75, 74, 0.4); }
.row { width: 100%; display: flex; align-items: center; gap: 10px; background: none; border: none; padding: 9px 12px; cursor: pointer; font-size: 12px; color: #485058; }
.id { font-family: ui-monospace, monospace; color: #2C4A63; }
.n { color: #7C8794; margin-left: auto; }
.arrow { color: #9AA3AC; }
.empty { font-size: 12px; color: #9AA3AC; padding: 6px; }
</style>
