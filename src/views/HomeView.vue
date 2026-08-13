<script setup lang="ts">
import { inject, computed, type Ref } from 'vue';
import { useRoute } from 'vue-router';
import SendPanel from '@/components/SendPanel.vue';
import ReceivePanel from '@/components/ReceivePanel.vue';
import ManagePanel from '@/components/ManagePanel.vue';

type TabType = 'send' | 'receive' | 'manage';
const tab = inject<Ref<TabType>>('homeTab')!;

const route = useRoute();
const initialCode = computed(() => (route.query.code as string) || '');
</script>

<template>
  <div class="home">
    <div class="panel card">
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
.foot { margin-top: 18px; font-size: 12px; text-align: center; }

@media (max-width: 900px) {
  .panel {
    max-width: 100%; padding: 12px;
    background: transparent; border: none; border-radius: 0; box-shadow: none;
  }
}
</style>
