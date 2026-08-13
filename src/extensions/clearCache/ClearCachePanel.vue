<script setup lang="ts">
import { ref } from 'vue';

const cleared = ref(false);

function doClearCache() {
  try {
    localStorage.clear();
    cleared.value = true;
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div class="clear-cache">
    <p class="muted">这会清除本机浏览器中保存的偏好与临时数据（不影响已上传到服务器的文件）。</p>
    <button v-if="!cleared" class="btn danger" @click="doClearCache">确认清空本机缓存</button>
    <p v-else class="ok">✓ 已清空本机缓存</p>
  </div>
</template>

<style scoped>
.clear-cache { font-size: 14px; }
.ok { color: var(--ok); font-weight: 600; }
</style>
