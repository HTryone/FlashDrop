<script setup lang="ts">
import { ref, provide, watch } from 'vue';
import { useRoute } from 'vue-router';
import ExtensionPanel from './views/ExtensionPanel.vue';

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
  display: flex; align-items: center; gap: 16px;
  padding: 14px 22px; border-bottom: 1px solid var(--border);
  background: rgba(18, 23, 37, 0.7); backdrop-filter: blur(8px);
  position: sticky; top: 0; z-index: 10;
}
.brand { display: flex; align-items: baseline; gap: 8px; }
.logo { font-size: 20px; font-weight: 800; }
.tag { font-size: 12px; color: var(--text-faint); letter-spacing: 1px; }
.tabs { display: flex; gap: 4px; margin-left: 8px; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 999px; padding: 3px; }
.tabs button { background: none; border: none; color: var(--text-dim); padding: 7px 16px; border-radius: 999px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.tabs button.on { background: var(--accent-grad); color: #07101f; }
.ext-btn { margin-left: auto; background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 8px 14px; border-radius: 999px; font-size: 13px; }
.ext-btn:hover { border-color: var(--accent); }
.ext-btn.on { border-color: var(--accent); color: var(--accent); }
.main { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 28px 18px 40px; }
.ext-panel-host { width: 100%; max-width: 980px; }

@media (max-width: 900px) {
  .topbar { padding: 12px 14px; }
  .main { padding: 12px 6px 24px; }
}
</style>
