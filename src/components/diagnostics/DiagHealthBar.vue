<script setup lang="ts">
// 健康总览条：错误/警告计数 + 各子系统状态灯（§5）。
defineProps<{
  errors: number;
  warns: number;
  status: Record<string, 'ok' | 'warn' | 'err'>;
  channels: readonly string[];
}>();

const label: Record<string, string> = {
  tus: 'tus', https: 'https', p2p: 'p2p', ui: 'UI', global: '全局',
  ipc: '桥接', crash: '崩溃', perf: '性能', crypto: '加密',
  net: '网络', perm: '权限', worker: 'Worker', bg: '后台',
};
</script>

<template>
  <div class="bar">
    <div class="counts">
      <span class="c err"><i />错误 {{ errors }}</span>
      <span class="c warn"><i />警告 {{ warns }}</span>
    </div>
    <div class="lights">
      <span v-for="c in channels" :key="c" class="light" :class="status[c]">
        <i />{{ label[c] ?? c }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.bar { background: rgba(255, 255, 255, 0.7); border: 0.5px solid rgba(120, 140, 160, 0.18); border-radius: 12px; padding: 10px 12px; margin-bottom: 12px; }
.counts { display: flex; gap: 14px; margin-bottom: 8px; }
.c { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #485058; }
.c i { width: 7px; height: 7px; border-radius: 50%; }
.c.err i { background: #E24B4A; } .c.warn i { background: #BA7517; }
.lights { display: flex; flex-wrap: wrap; gap: 8px; }
.light { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #5C656E; background: rgba(255, 255, 255, 0.6); border: 0.5px solid rgba(120, 140, 160, 0.2); border-radius: 999px; padding: 3px 9px; }
.light i { width: 6px; height: 6px; border-radius: 50%; background: #639922; }
.light.warn i { background: #BA7517; } .light.err i { background: #E24B4A; }
</style>
