<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { extensions } from '@/extensions';

const route = useRoute();
const router = useRouter();

const ext = computed(() => extensions.find((e) => e.id === route.params.id) || null);

function goHome() {
  router.push('/');
}
</script>

<template>
  <div class="ext-page card">
    <button class="back" @click="goHome">‹ 返回</button>
    <h2 v-if="ext" class="ext-title">{{ ext.icon }} {{ ext.title }}</h2>
    <p v-if="!ext" class="faint">未找到该模块。</p>
    <component :is="ext!.component" v-if="ext" />
  </div>
</template>

<style scoped>
.ext-page { width: 100%; max-width: 680px; padding: 22px; }
.back { background: none; border: none; color: var(--accent); padding: 0; margin-bottom: 12px; font-size: 14px; }
.ext-title { margin: 0 0 16px; font-size: 18px; }

@media (max-width: 900px) {
  .ext-page {
    max-width: 100%; padding: 12px;
    background: transparent; border: none; border-radius: 0; box-shadow: none;
  }
}
</style>
