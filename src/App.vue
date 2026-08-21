<script setup lang="ts">
import { ref, provide, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { isPhone } from './tauri/client';
import { requestNotificationAtLaunch } from './tauri/notify';
import ExtensionPanel from './views/ExtensionPanel.vue';
import TabBar from './components/diagnostics/TabBar.vue';

type TabType = 'send' | 'receive' | 'manage';
const activeTab = ref<TabType>('send');
provide('homeTab', activeTab);

const route = useRoute();
const router = useRouter();

// 扩展页（更多）= 路由 /ext*；其余 = 首页。两者为平级完整页面，out-in 切换旧页完全退出。
const isExt = computed(() => route.path.startsWith('/ext'));
// 底部玻璃 tab 栏（主页/更多）全平台保留：窄屏底部胶囊，宽屏右下便签。
const showTabBar = true;

watch(
  () => route.fullPath,
  () => {
    if (route.path !== '/') return;
    const code = route.query.code as string;
    const t = route.query.tab as string;
    if (code) activeTab.value = 'receive';
    else if (t === 'local' || t === 'receive') activeTab.value = 'receive';
  },
  { immediate: true },
);

// 导出保存提示（诊断页嵌在扩展页内，通过 provide/inject 触发，无需事件冒泡）。
const toast = ref<{ path: string } | null>(null);
let toastTimer: number | undefined;
function showToast(path: string) {
  toast.value = { path };
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = null), 4000);
}
provide('diagToast', showToast);

function onSwitch(to: 'home' | 'more') {
  router.push(to === 'more' ? '/ext' : '/');
}

// 触屏滑动切换：右滑→主页，左滑→更多（仅横向明显滑动才触发，避免与列表滚动冲突）。
let sx = 0, sy = 0, st = 0;
function onTouchStart(e: TouchEvent) {
  const t = e.touches[0];
  sx = t.clientX; sy = t.clientY; st = Date.now();
}
function onTouchEnd(e: TouchEvent) {
  if (!showTabBar) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - sx, dy = t.clientY - sy;
  if (Date.now() - st > 600) return;
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
  router.push(dx < 0 ? '/ext' : '/');
}

onMounted(() => {
  const mobile = typeof navigator !== 'undefined' &&
    (navigator.maxTouchPoints > 0 || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
  provide('isMobile', mobile);
  if (isPhone()) void requestNotificationAtLaunch();
});
onBeforeUnmount(() => window.clearTimeout(toastTimer));
</script>

<template>
  <div class="app" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
    <transition name="page" mode="out-in">
    <!-- 扩展页（更多）：完整页面，含「日志」等模块 -->
    <ExtensionPanel v-if="isExt" key="ext" class="ext-page" />

      <!-- 首页：顶栏 + 发送/接收/我的传输 -->
      <div v-else key="home" class="page">
        <header class="topbar">
          <div class="brand">
            <img class="brand-logo" src="/logo.svg" alt="ArkPulse" />
            <span class="tag gradient-text">ArkPulse</span>
          </div>
          <nav v-if="route.path === '/'" class="tabs">
            <button :class="{ on: activeTab === 'send' }" @click="activeTab = 'send'">发送</button>
            <button :class="{ on: activeTab === 'receive' }" @click="activeTab = 'receive'">接收</button>
            <button :class="{ on: activeTab === 'manage' }" @click="activeTab = 'manage'">我的传输</button>
          </nav>
        </header>
        <main class="main">
          <router-view />
        </main>
      </div>
    </transition>

    <!-- 原生端底部玻璃 tab：主页 / 更多（更多 = 扩展页） -->
    <TabBar v-if="showTabBar" :active="isExt ? 'more' : 'home'" @switch="onSwitch" />

    <transition name="toast">
      <div v-if="toast" class="diag-toast">
        <span class="dot" />
        <div class="txt">已保存<small>{{ toast.path }}</small></div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.app { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
.page { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow-y: auto; position: relative; }
.ext-page { flex: 1; min-height: 0; overflow-y: auto; position: relative; }
.topbar {
  display: flex; align-items: center; gap: 12px;
  padding: max(14px, env(safe-area-inset-top)) 22px 14px; border-bottom: 1px solid var(--border);
  background: rgba(18, 23, 37, 0.7); backdrop-filter: blur(8px);
  flex-wrap: nowrap;
}
.brand { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.brand-logo { width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0; display: block; }
.tag { font-size: 18px; font-weight: 800; letter-spacing: .5px; }
.tabs {
  display: flex; gap: 4px; margin-left: 8px;
  background: var(--bg-soft); border: 1px solid var(--border);
  border-radius: 999px; padding: 3px;
  flex: 1 1 auto; min-width: 0;
  overflow-x: auto; scrollbar-width: none; -ms-overflow-style: none;
}
.tabs::-webkit-scrollbar { display: none; }
.tabs button { background: none; border: none; color: var(--text-dim); padding: 7px 16px; border-radius: 999px; font-size: 13px; font-weight: 600; white-space: nowrap; flex-shrink: 0; }
.tabs button.on { background: var(--accent-grad); color: #07101f; }
.main { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 28px 18px max(40px, env(safe-area-inset-bottom) + 74px); }

@media (max-width: 899px) {
  .tag { display: none; }
}
@media (max-width: 640px) {
  .topbar { padding: max(12px, env(safe-area-inset-top)) 12px 12px; gap: 10px; }
  .tabs { margin-left: 4px; }
  .tabs button { padding: 7px 12px; font-size: 13px; }
  .more-entry { padding: 7px 12px; }
  .main { padding: 12px 6px max(24px, env(safe-area-inset-bottom) + 74px); }
}

/* 真实页面切换（out-in）：旧页完全退出后再呈现新页，杜绝叠加/浮层 */
.page-enter-active, .page-leave-active { transition: opacity .22s ease, transform .22s ease; }
.page-enter-from { opacity: 0; transform: translateX(20px); }
.page-leave-to { opacity: 0; transform: translateX(-20px); }

.diag-toast {
  position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 9px;
  background: rgba(18, 23, 37, 0.82); border: 0.5px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px; padding: 9px 13px; max-width: 90vw;
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
}
.diag-toast .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ok); flex: 0 0 auto; box-shadow: 0 0 8px var(--ok); }
.diag-toast .txt { font-size: 12px; color: var(--text); }
.diag-toast .txt small { display: block; color: var(--text-dim); font-size: 10.5px; margin-top: 1px; word-break: break-all; }
.toast-enter-active, .toast-leave-active { transition: all .4s cubic-bezier(.2, .8, .3, 1); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 12px); }
</style>
