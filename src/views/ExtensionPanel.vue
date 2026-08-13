<script setup lang="ts">
import { ref, computed } from 'vue';
import { extensions } from '@/extensions';
import ModuleView from './ModuleView.vue';

defineProps<{ open: boolean }>();

// null = 模块选择页（目录）；选中后展示该模块整页
const active = ref<string | null>(null);

const current = computed(() => extensions.find((e) => e.id === active.value) ?? null);
const docModuleId = computed(() =>
  current.value?.kind === 'doc' ? current.value.moduleId ?? '' : '',
);

function openModule(id: string) {
  active.value = id;
}
function back() {
  active.value = null;
}
</script>

<template>
  <div class="ext-panel">
    <!-- 模块选择页（目录） -->
    <div v-if="!current" class="picker">
      <h2 class="picker-title">更多</h2>
      <div class="cards">
        <button
          v-for="e in extensions"
          :key="e.id"
          class="card"
          @click="openModule(e.id)"
        >
          <span class="c-icon">{{ e.icon }}</span>
          <span class="c-title">{{ e.title }}</span>
          <span class="c-desc">{{ e.desc }}</span>
        </button>
      </div>
    </div>

    <!-- 模块整页 -->
    <div v-else class="module-page">
      <button class="back" @click="back">‹ 返回</button>
      <ModuleView v-if="current.kind === 'doc'" :module-id="docModuleId" />
      <component v-else :is="current.component" />
    </div>
  </div>
</template>

<style scoped>
.ext-panel { width: 100%; padding: 16px 18px; }
.picker-title { font-size: 18px; margin: 2px 0 16px; color: var(--text); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.card {
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start; text-align: left;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  padding: 16px; cursor: pointer; color: var(--text);
}
.card:hover { border-color: var(--accent); }
.c-icon { font-size: 26px; }
.c-title { font-size: 15px; font-weight: 600; }
.c-desc { font-size: 12px; color: var(--text-dim); }

.module-page { display: flex; flex-direction: column; }
.back {
  align-self: flex-start; background: var(--panel-2); border: 1px solid var(--border);
  color: var(--text); padding: 6px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 8px;
}

@media (max-width: 900px) {
  .cards { grid-template-columns: repeat(2, 1fr); }
  .card { padding: 12px; }
  .c-icon { font-size: 22px; }
}
</style>
