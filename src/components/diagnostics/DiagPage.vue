<script setup lang="ts">
// 诊断完整页（真实「更多」页面，非浮层）：健康总览 + 实时日志流 + 会话列表 + 打包 ZIP 导出。
// 深色毛玻璃，融入暗色主题（§5 / 用户定：iOS/Telegram 风，不刺眼）。
import { ref, computed, onMounted, onUnmounted, inject } from 'vue';
import { diagStore } from '../../diagnostics/store';
import type { LogEntry } from '../../diagnostics/types';
import { diagnosticsExport } from '../../tauri/diagnostics';
import DiagHealthBar from './DiagHealthBar.vue';
import DiagLogStream from './DiagLogStream.vue';
import DiagSessionList from './DiagSessionList.vue';

const emit = defineEmits<{ exported: [path: string] }>();
// 保存提示由 App 通过 provide 注入（本页嵌在扩展页内，事件传不到 App 根）。
const diagToast = inject<(path: string) => void>('diagToast');

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
    diagToast?.(path);
    emit('exported', path);
  } catch (e) {
    const msg = `导出失败: ${String(e)}`;
    diagToast?.(msg);
    emit('exported', msg);
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div class="page more">
    <header class="head">
      <div class="title">
        <h2>诊断</h2>
        <p class="sub">收发两端全链路 · 最近 7 天</p>
      </div>
    </header>
    <div class="body">
      <DiagHealthBar :errors="errorCount" :warns="warnCount" :status="status" :channels="channels" />
      <DiagLogStream :entries="entries" />
      <DiagSessionList :entries="entries" />
      <button class="exp" :disabled="exporting" @click="onExport">
        {{ exporting ? '导出中…' : '打包 ZIP 导出' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.page { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.head {
  display: flex; align-items: center; justify-content: space-between;
  padding: max(16px, env(safe-area-inset-top)) 20px 12px;
}
.title h2 { margin: 0; font-size: 20px; font-weight: 700; color: var(--text); letter-spacing: .3px; }
.title .sub { margin: 3px 0 0; font-size: 12px; color: var(--text-dim); }
.body {
  flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: 4px 16px calc(96px + env(safe-area-inset-bottom)); /* 底部留白给 tab 栏 */
  display: flex; flex-direction: column; gap: 12px;
}
.exp {
  margin-top: 4px; width: 100%;
  background: linear-gradient(120deg, rgba(109, 139, 255, 0.22), rgba(56, 225, 200, 0.18));
  border: 1px solid rgba(109, 139, 255, 0.4);
  color: var(--text); border-radius: 12px; padding: 12px; font-size: 14px; font-weight: 600;
  cursor: pointer; transition: transform .15s cubic-bezier(.2, .8, .3, 1), filter .15s;
  backdrop-filter: blur(8px);
}
.exp:hover:not(:disabled) { transform: scale(1.02); filter: brightness(1.08); }
.exp:active:not(:disabled) { transform: scale(0.98); }
.exp:disabled { opacity: 0.6; cursor: default; }
</style>
