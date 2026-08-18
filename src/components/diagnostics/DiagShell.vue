<script setup lang="ts">
// 诊断窗口级外壳：底部圆形长条（主页/更多）+ 上方玻璃体（仅「更多」显示）。
// 挂 App.vue 根，不进 send/receive/manage 导航（§5）。UI 纯响应式，不读平台标签（§3.3）。
import { ref, onMounted, onUnmounted } from 'vue';
import DiagDock from './DiagDock.vue';
import DiagGlass from './DiagGlass.vue';

const open = ref(false);
const toast = ref<{ path: string } | null>(null);
let toastTimer: number | undefined;

function showToast(path: string) {
  toast.value = { path };
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = null), 4000);
}

onMounted(() => {
  // 顶部「更多」(扩展) 与底部诊断「更多」互不干扰；此处仅控制诊断浮层显隐。
});
onUnmounted(() => window.clearTimeout(toastTimer));

defineExpose({ showToast });
</script>

<template>
  <div class="diag-shell">
    <DiagGlass v-if="open" @close="open = false" @exported="showToast" />
    <DiagDock :open="open" @home="open = false" @more="open = true" />
    <transition name="toast">
      <div v-if="toast" class="diag-toast">
        <span class="dot" />
        <div class="txt">已保存<small>{{ toast.path }}</small></div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.diag-shell { position: fixed; inset: 0; pointer-events: none; z-index: 50; }
.diag-shell > * { pointer-events: auto; }
.diag-toast {
  position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 9px;
  background: rgba(228, 240, 230, 0.94); border: 0.5px solid #A9CFB4;
  border-radius: 12px; padding: 9px 13px; max-width: 90vw;
  backdrop-filter: blur(8px);
}
.diag-toast .dot { width: 10px; height: 10px; border-radius: 50%; background: #5BAE78; flex: 0 0 auto; }
.diag-toast .txt { font-size: 12px; color: #2E5B3C; }
.diag-toast .txt small { display: block; color: #3E7A4F; font-size: 10.5px; margin-top: 1px; word-break: break-all; }
.toast-enter-active, .toast-leave-active { transition: all .4s cubic-bezier(.2, .8, .3, 1); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 12px); }
</style>
