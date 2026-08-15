<script setup lang="ts">
import { ref, provide, watch, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

type TabType = 'send' | 'receive' | 'manage';
const activeTab = ref<TabType>('send');
provide('homeTab', activeTab);

const route = useRoute();
const router = useRouter();
watch(
  () => route.fullPath,
  () => {
    if (route.path !== '/') return;
    const code = route.query.code as string;
    const t = route.query.tab as string;
    if (code) activeTab.value = 'receive';
    else if (t === 'local') activeTab.value = 'receive';
  },
  { immediate: true },
);

// 「更多」= 路由 /ext*；点击切换，刷新后停在对应模块
const inExt = computed(() => route.path.startsWith('/ext'));
function toggleExt() {
  router.push(inExt.value ? '/' : '/ext');
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="logo gradient-text">⚡ 闪传</span>
        <span class="tag">FlashDrop</span>
      </div>
      <nav v-if="route.path === '/'" class="tabs">
        <button :class="{ on: activeTab === 'send' }" @click="activeTab = 'send'">发送</button>
        <button :class="{ on: activeTab === 'receive' }" @click="activeTab = 'receive'">接收</button>
        <button :class="{ on: activeTab === 'manage' }" @click="activeTab = 'manage'">我的传输</button>
      </nav>
      <button class="ext-btn" :class="{ on: inExt }" @click="toggleExt">
        {{ inExt ? '✕ 关闭' : '⚙ 更多' }}
      </button>
    </header>

    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app { min-height: 100%; display: flex; flex-direction: column; }
.topbar {
  display: flex; align-items: center; gap: 12px;
  padding: max(14px, env(safe-area-inset-top)) 22px 14px; border-bottom: 1px solid var(--border);
  background: rgba(18, 23, 37, 0.7); backdrop-filter: blur(8px);
  position: sticky; top: 0; z-index: 10;
  flex-wrap: nowrap;
}
.brand { display: flex; align-items: baseline; gap: 8px; flex-shrink: 0; }
.logo { font-size: 20px; font-weight: 800; white-space: nowrap; }
.tag { font-size: 12px; color: var(--text-faint); letter-spacing: 1px; }
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
.ext-btn { flex-shrink: 0; margin-left: auto; background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 8px 14px; border-radius: 999px; font-size: 13px; white-space: nowrap; }
.ext-btn:hover { border-color: var(--accent); }
.ext-btn.on { border-color: var(--accent); color: var(--accent); }
.main { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 28px 18px 40px; }

@media (max-width: 640px) {
  .topbar { padding: max(12px, env(safe-area-inset-top)) 12px 12px; gap: 10px; }
  .tag { display: none; }
  .logo { font-size: 18px; }
  .tabs { margin-left: 4px; }
  .tabs button { padding: 7px 12px; font-size: 13px; }
  .ext-btn { padding: 8px 12px; }
  .main { padding: 12px 6px 24px; }
}
</style>
