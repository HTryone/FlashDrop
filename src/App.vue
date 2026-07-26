<script setup lang="ts">
import { ref, computed } from 'vue';
import SendPanel from './components/SendPanel.vue';
import ReceivePanel from './components/ReceivePanel.vue';
import ManagePanel from './components/ManagePanel.vue';
import ExtensionsDrawer from './components/ExtensionsDrawer.vue';

type TabType = 'send' | 'receive' | 'manage';
const tab = ref<TabType>('send');
const drawerOpen = ref(false);

// 非安全上下文（http 非 localhost）下 WebCrypto 不可用，端到端加密会失败
const insecure = ref(!globalThis.crypto?.subtle);

const params = new URLSearchParams(location.search);
const codeParam = params.get('code');
if (codeParam) tab.value = 'receive';

const initialCode = computed(() => codeParam || '');

function onGotLoginCode(rawCode: string) {
  // 发送后自动切到管理页，方便用户保存登录码
  // 不强制切换，只是提示
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="logo gradient-text">⚡ 闪传</span>
        <span class="tag">FlashDrop</span>
      </div>
      <nav class="tabs">
        <button :class="{ on: tab === 'send' }" @click="tab = 'send'">发送</button>
        <button :class="{ on: tab === 'receive' }" @click="tab = 'receive'">接收</button>
        <button :class="{ on: tab === 'manage' }" @click="tab = 'manage'">我的传输</button>
      </nav>
      <button class="ext-btn" @click="drawerOpen = true" title="扩展模块">⚙ 扩展</button>
    </header>

    <div v-if="insecure" class="insecure-banner">
      ⚠️ 当前为 <strong>非安全连接</strong>，端到端加密不可用。请改用 <strong>https://</strong> 开头的地址访问（直接输 http 会自动跳转）。
    </div>

    <main class="main">
      <div class="panel card">
        <SendPanel v-show="tab === 'send'" @got-login-code="onGotLoginCode" />
        <ReceivePanel v-if="tab === 'receive'" :initial-code="initialCode" />
        <ManagePanel v-if="tab === 'manage'" />
      </div>
      <footer class="foot faint">
        分片续传 · 断点下载 · 端到端加密 · 大文件极速传输
      </footer>
    </main>

    <ExtensionsDrawer :open="drawerOpen" @close="drawerOpen = false" />
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
.main { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 28px 18px 40px; }

.insecure-banner {
  background: rgba(255, 184, 0, 0.12); color: #ffd479;
  border-bottom: 1px solid rgba(255, 184, 0, 0.35);
  padding: 10px 18px; font-size: 13px; text-align: center; line-height: 1.6;
}
.insecure-banner strong { color: #ffe2a8; }
.panel { width: 100%; max-width: 680px; padding: 22px; }
.foot { margin-top: 18px; font-size: 12px; text-align: center; }

@media (max-width: 640px) {
  .tabs button { padding: 7px 12px; font-size: 12px; }
  .ext-btn { display: none; } /* 小屏隐藏扩展按钮 */
}
</style>
