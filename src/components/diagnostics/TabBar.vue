<script setup lang="ts">
// 底部 tab 导航（真实平级页面切换，非浮层）：主页 / 更多。
// 仅原生端显示（Web 不渲染，由 App 的 v-if 控制）。
// 布局形态由「视口宽度」主导，不依赖系统标识：
//   窄屏（手机比例）→ 底部居中玻璃胶囊，文字单行、两栏等宽；
//   宽屏（桌面/平板横屏）→ 右下角贴边的两个玻璃便签，质感一致。
const props = defineProps<{ active: 'home' | 'more' }>();
const emit = defineEmits<{ switch: ['home' | 'more'] }>();

function onSwitch(to: 'home' | 'more') {
  emit('switch', to);
}
</script>

<template>
  <nav class="tabbar">
    <button :class="{ on: active === 'home' }" @click="onSwitch('home')">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 11.2 12 4l9 7.2V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
      </svg>
      <span class="lbl">主页</span>
    </button>
    <button :class="{ on: active === 'more' }" @click="onSwitch('more')">
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
  position: fixed; left: 50%; bottom: max(18px, env(safe-area-inset-bottom));
  transform: translateX(-50%);
  display: flex; gap: 2px; padding: 5px;
  /* 苹果风：近乎透明 + 重模糊 + 细高光边 */
  background: rgba(22, 28, 44, 0.42);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  backdrop-filter: blur(34px) saturate(180%);
  -webkit-backdrop-filter: blur(34px) saturate(180%);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.18);
  z-index: 40;
}
.tabbar button {
  flex: 1 1 0;                       /* 两按钮等宽，比例不失调 */
  display: flex; align-items: center; justify-content: center; gap: 8px;
  background: none; border: none; color: var(--text-dim);
  padding: 10px 24px; border-radius: 999px;
  font-size: 13.5px; font-weight: 600; line-height: 1;
  white-space: nowrap;               /* 文字强制单行，绝不换行 */
  cursor: pointer; flex-shrink: 0;
  transition: color .25s ease, background .25s ease, transform .12s ease;
}
.tabbar button.on {
  color: #fff;
  background: rgba(255, 255, 255, 0.14);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
}
.tabbar button:active { transform: scale(0.96); }
.tabbar .ico {
  width: 16px; height: 16px; fill: none; stroke: currentColor;
  stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round;
  flex: 0 0 auto;
}
.tabbar .lbl { white-space: nowrap; flex: 0 0 auto; }

/* —— 宽屏（桌面/平板横屏）：右下角贴边，两个玻璃便签 ——
   由视口宽度主导（断点 768px），不依赖系统标识；质感与窄屏玻璃一致。 */
@media (min-width: 768px) {
  .tabbar {
    left: auto;
    right: max(18px, env(safe-area-inset-right));
    bottom: max(18px, env(safe-area-inset-bottom));
    transform: none;
    flex-direction: column;
    gap: 10px; padding: 0;
    background: none; border: none; box-shadow: none;
    backdrop-filter: none; -webkit-backdrop-filter: none;
  }
  .tabbar button {
    width: 62px; height: 62px;
    flex: 0 0 auto; flex-direction: column; gap: 4px;
    padding: 0;
    background: rgba(22, 28, 44, 0.42);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 18px;
    backdrop-filter: blur(34px) saturate(180%);
    -webkit-backdrop-filter: blur(34px) saturate(180%);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.18);
  }
  .tabbar button.on {
    color: #fff;
    background: rgba(255, 255, 255, 0.20);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.30), 0 10px 30px rgba(0, 0, 0, 0.34);
  }
  .tabbar .ico { width: 20px; height: 20px; }
  .tabbar .lbl { font-size: 11.5px; }
}
</style>
