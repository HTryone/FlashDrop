<script setup lang="ts">
// 底部 tab 导航（真实平级页面切换，非浮层）：主页 / 更多。
// 仅原生端显示（Web 不渲染，由 App 的 v-if 控制）。深色毛玻璃，融入暗色主题。
defineProps<{ active: 'home' | 'more' }>();
const emit = defineEmits<{ switch: ['home' | 'more'] }>();
</script>

<template>
  <nav class="tabbar">
    <button :class="{ on: active === 'home' }" @click="emit('switch', 'home')">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 11.2 12 4l9 7.2V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
      </svg>
      <span class="lbl">主页</span>
    </button>
    <button :class="{ on: active === 'more' }" @click="emit('switch', 'more')">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.4" />
        <path d="M12 7.4v4.6l3 1.8" />
      </svg>
      <span class="lbl">更多</span>
    </button>
  </nav>
</template>

<style scoped>
.tabbar {
  position: fixed; left: 50%; bottom: max(16px, env(safe-area-inset-bottom));
  transform: translateX(-50%);
  display: flex; gap: 4px; padding: 5px;
  background: rgba(18, 23, 37, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  backdrop-filter: blur(22px) saturate(160%);
  -webkit-backdrop-filter: blur(22px) saturate(160%);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  z-index: 40;
}
.tabbar button {
  display: flex; align-items: center; gap: 7px;
  background: none; border: none; color: var(--text-dim);
  padding: 9px 24px; border-radius: 999px; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: all .22s cubic-bezier(.2, .8, .3, 1);
}
.tabbar button.on {
  background: rgba(109, 139, 255, 0.18);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px rgba(109, 139, 255, 0.35);
}
.tabbar button:active { transform: scale(0.95); }
.tabbar .ico { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
</style>
