<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import SendPanel from '@/components/SendPanel.vue';
import ReceivePanel from '@/components/ReceivePanel.vue';
import ManagePanel from '@/components/ManagePanel.vue';

type TabType = 'send' | 'receive' | 'manage';
const tab = ref<TabType>('send');

// 兼容旧版深链：?code= 直接进接收；?tab=local 也进接收
const route = useRoute();
const codeParam = (route.query.code as string) || '';
const tabParam = route.query.tab as string;
if (codeParam) tab.value = 'receive';
else if (tabParam === 'local') tab.value = 'receive';

const initialCode = computed(() => codeParam || '');
</script>

<template>
  <div class="home">
    <div class="panel card">
      <nav class="tabs">
        <button :class="{ on: tab === 'send' }" @click="tab = 'send'">发送</button>
        <button :class="{ on: tab === 'receive' }" @click="tab = 'receive'">接收</button>
        <button :class="{ on: tab === 'manage' }" @click="tab = 'manage'">我的传输</button>
      </nav>
      <SendPanel v-show="tab === 'send'" />
      <ReceivePanel v-if="tab === 'receive'" :initial-code="initialCode" />
      <ManagePanel v-if="tab === 'manage'" />
    </div>
    <footer class="foot faint">
      分片续传 · 断点下载 · 端到端加密 · 本地实时直传 · 大文件极速传输
    </footer>
  </div>
</template>

<style scoped>
.home { width: 100%; display: flex; flex-direction: column; align-items: center; }
.panel { width: 100%; max-width: 680px; padding: 22px; }
.tabs { display: flex; gap: 4px; margin-bottom: 18px; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 999px; padding: 3px; }
.tabs button { background: none; border: none; color: var(--text-dim); padding: 7px 16px; border-radius: 999px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.tabs button.on { background: var(--accent-grad); color: #07101f; }
.foot { margin-top: 18px; font-size: 12px; text-align: center; }

@media (max-width: 900px) {
  .panel {
    max-width: 100%; padding: 12px;
    background: transparent; border: none; border-radius: 0; box-shadow: none;
  }
}
</style>
