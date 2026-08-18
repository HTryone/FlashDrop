<script setup lang="ts">
// 诊断玻璃体（仅「更多」显示）：健康总览 + 实时日志流 + 会话列表 + 打包 ZIP 导出。
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { diagStore } from '../../diagnostics/store';
import type { LogEntry } from '../../diagnostics/types';
import { diagnosticsExport } from '../../tauri/diagnostics';
import DiagHealthBar from './DiagHealthBar.vue';
import DiagLogStream from './DiagLogStream.vue';
import DiagSessionList from './DiagSessionList.vue';

const emit = defineEmits<{ close: []; exported: [path: string] }>();

const entries = ref<LogEntry[]>(diagStore.all());
let unsub: (() => void) | undefined;
onMounted(() => {
  unsub = diagStore.subscribe((e) => (entries.value = e));
});
onUnmounted(() => unsub?.());

const errorCount = computed(() => entries.value.filter((e) => e.level === 'error').length);
const warnCount = computed(() => entries.value.filter((e) => e.level === 'warn').length);

// 各子系统状态灯：取该 channel 最近一条的严重度。
const channels = ['tus', 'https', 'p2p', 'ui', 'global', 'ipc', 'crash', 'perf', 'crypto', 'net', 'perm', 'worker', 'bg'] as const;
const status = computed(() => {
  const m: Record<string, 'ok' | 'warn' | 'err'> = {};
  for (const c of channels) m[c] = 'ok';
  for (const e of entries.value) {
    if (!channels.includes(e.channel as any)) continue;
    if (e.level === 'error') m[e.channel] = 'err';
    else if (e.level === 'warn' && m[e.channel] !== 'err') m[e.channel] = 'warn';
  }
  return m;
});

const exporting = ref(false);
async function onExport() {
  exporting.value = true;
  try {
    const path = await diagnosticsExport(false);
    emit('exported', path);
  } catch (e) {
    emit('exported', `导出失败: ${String(e)}`);
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div class="glass">
    <div class="head">
      <div>
        <h3>诊断 · 更多</h3>
        <p class="sub">收发两端全链路 · 最近 7 天</p>
      </div>
      <button class="x" @click="emit('close')">收起</button>
    </div>
    <DiagHealthBar :errors="errorCount" :warns="warnCount" :status="status" :channels="channels" />
    <DiagLogStream :entries="entries" />
    <DiagSessionList :entries="entries" />
    <button class="exp" :disabled="exporting" @click="onExport">
      {{ exporting ? '导出中…' : '打包 ZIP 导出' }}
    </button>
  </div>
</template>

<style scoped>
.glass {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: min(680px, 92vw); max-height: 82vh; overflow: auto;
  background: rgba(255, 255, 255, 0.66); border: 0.5px solid rgba(120, 140, 160, 0.22);
  border-radius: 20px; padding: 18px 20px; backdrop-filter: blur(14px);
  box-shadow: 0 10px 40px rgba(40, 60, 90, 0.12);
}
.head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; }
.head h3 { margin: 0; font-size: 15px; font-weight: 600; color: #2C4A63; }
.head .sub { margin: 2px 0 0; font-size: 11px; color: #7C8794; }
.x { background: rgba(255, 255, 255, 0.5); border: 0.5px solid rgba(120, 140, 160, 0.3); color: #485058; border-radius: 999px; padding: 5px 14px; font-size: 12px; cursor: pointer; transition: transform .15s cubic-bezier(.2, .8, .3, 1); }
.x:hover { transform: scale(1.04); background: rgba(255, 255, 255, 0.7); }
.x:active { transform: scale(0.96); }
.exp {
  margin-top: 14px; width: 100%;
  background: rgba(55, 138, 221, 0.16); border: 0.5px solid rgba(55, 138, 221, 0.5);
  color: #1F5E9E; border-radius: 12px; padding: 11px; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: transform .15s cubic-bezier(.2, .8, .3, 1);
}
.exp:hover:not(:disabled) { transform: scale(1.03); background: rgba(55, 138, 221, 0.24); }
.exp:active:not(:disabled) { transform: scale(0.97); }
.exp:disabled { opacity: 0.6; cursor: default; }
</style>
