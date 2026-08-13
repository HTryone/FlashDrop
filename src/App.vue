<script setup lang="ts">
import { ref, provide, watch, defineAsyncComponent } from 'vue';
import { useRoute } from 'vue-router';

// 懒加载：仅当用户点开「更多」时才拉取该面板及其子模块（ModuleView / 扩展模块 / markdown 渲染）
const ExtensionPanel = defineAsyncComponent(() => import('./views/ExtensionPanel.vue'));

type TabType = 'send' | 'receive' | 'manage';
const activeTab = ref<TabType>('send');
provide('homeTab', activeTab);

const route = useRoute();
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

const extOpen = ref(false);
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="logo gradient-text">⚡ 闪传</span>
        <span class="tag">FlashDrop</span>
      </div>
      <nav v-if="!extOpen && route.path === '/'" class="tabs">
        <button :class="{ on: activeTab === 'send' }" @click="activeTab = 'send'">发送</button>
        <button :class="{ on: activeTab === 'receive' }" @click="activeTab = 'receive'">接收</button>
        <button :class="{ on: activeTab === 'manage' }" @click="activeTab = 'manage'">我的传输</button>
      </nav>
      <button class="ext-btn" :class="{ on: extOpen }" @click="extOpen = !extOpen">
        {{ extOpen ? '✕ 关闭' : '⚙ 更多' }}
      </button>
    </header>

    <main class="main">
      <router-view v-if="!extOpen" />
      <div v-else class="ext-panel-host">
        <ExtensionPanel :open="extOpen" @close="extOpen = false" />
      </div>
    </main>
  </div>
</template>

<style scoped>
.app { min-height: 100%; display: flex; flex-direction: column; }
.topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 22px; border-bottom: 1px solid var(--border);
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
.ext-panel-host { width: 100%; max-width: 980px; }

@media (max-width: 640px) {
  .topbar { padding: 12px 12px; gap: 10px; }
  .tag { display: none; }
  .logo { font-size: 18px; }
  .tabs { margin-left: 4px; }
  .tabs button { padding: 7px 12px; font-size: 13px; }
  .ext-btn { padding: 8px 12px; }
  .main { padding: 12px 6px 24px; }
}
</style>
