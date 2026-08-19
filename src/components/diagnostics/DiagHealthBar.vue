<script setup lang="ts">
// 健康总览条：错误/警告计数 + 各子系统状态灯；点击状态灯过滤日志流（§5）。
const props = defineProps<{
  errors: number;
  warns: number;
  status: Record<string, 'ok' | 'warn' | 'err'>;
  channels: readonly string[];
  active?: string | null;
}>();
const emit = defineEmits<{ select: [c: string] }>();

const label: Record<string, string> = {
  tus: 'tus', https: 'https', p2p: 'p2p', ui: 'UI', global: '全局',
  ipc: '桥接', crash: '崩溃', perf: '性能', crypto: '加密',
  net: '网络', perm: '权限', worker: 'Worker', bg: '后台',
};

function onClick(c: string) {
  emit('select', props.active === c ? '' : c);
}
</script>

<template>
  <div class="bar">
    <div class="counts">
      <span class="c err"><i />错误 {{ errors }}</span>
      <span class="c warn"><i />警告 {{ warns }}</span>
    </div>
    <div class="lights">
      <button
        v-for="c in channels"
        :key="c"
        class="light"
        :class="[status[c], { on: active === c }]"
        @click="onClick(c)"
      >
        <i />{{ label[c] ?? c }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.bar {
  background: rgba(22, 28, 44, 0.6); border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 14px; padding: 12px 14px;
  backdrop-filter: blur(12px) saturate(150%); -webkit-backdrop-filter: blur(12px) saturate(150%);
}
.counts { display: flex; gap: 14px; margin-bottom: 10px; }
.c { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim); }
.c i { width: 7px; height: 7px; border-radius: 50%; }
.c.err i { background: var(--danger); box-shadow: 0 0 6px var(--danger); }
.c.warn i { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
.lights { display: flex; flex-wrap: wrap; gap: 8px; }
.light {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500;
  color: var(--text-dim); background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 999px; padding: 7px 13px;
  cursor: pointer; transition: background .15s, color .15s, transform .1s;
}
.light:active { transform: scale(0.96); }
.light.on { background: rgba(109, 139, 255, 0.18); border-color: rgba(109, 139, 255, 0.5); color: var(--text); }
.light i { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
.light.warn i { background: var(--warn); } .light.err i { background: var(--danger); }

@media (max-width: 640px) {
  .lights { gap: 10px; }
  .light { font-size: 13px; padding: 9px 15px; }
  .light i { width: 8px; height: 8px; }
}
</style>
