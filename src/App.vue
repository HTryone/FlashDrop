<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import ExtensionsDrawer from './components/ExtensionsDrawer.vue';

const drawerOpen = ref(false);
const router = useRouter();

function selectExt(id: string) {
  drawerOpen.value = false;
  router.push('/ext/' + id);
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="logo gradient-text">⚡ 闪传</span>
        <span class="tag">FlashDrop</span>
      </div>
      <button class="ext-btn" @click="drawerOpen = true" title="扩展模块">⚙ 更多</button>
    </header>

    <main class="main">
      <router-view />
    </main>

    <ExtensionsDrawer :open="drawerOpen" @close="drawerOpen = false" @select="selectExt" />
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
.ext-btn { margin-left: auto; background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 8px 14px; border-radius: 999px; font-size: 13px; }
.ext-btn:hover { border-color: var(--accent); }
.main { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 28px 18px 40px; }

@media (max-width: 640px) {
  .ext-btn { display: none; } /* 小屏隐藏扩展按钮 */
}

/* 手机/平板：面板铺满并去掉外层卡片框，减少层层叠靠 */
@media (max-width: 900px) {
  .topbar { padding: 12px 14px; }
  .main { padding: 12px 6px 24px; }
}
</style>
