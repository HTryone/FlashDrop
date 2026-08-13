<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Component } from 'vue';
import { extensions } from '@/extensions';
import ModuleView from './ModuleView.vue';

defineProps<{ open: boolean }>();

type NavId = string;

interface NavEntry {
  id: string;
  title: string;
  icon: string;
  kind: 'panel' | 'action' | 'doc';
  component?: Component;
  moduleId?: string;
}

const active = ref<NavId>(extensions[0]?.id ?? '');
const mobileNavOpen = ref(false);

const nav = computed<NavEntry[]>(() => [
  ...extensions.map((e) => ({
    id: e.id,
    title: e.title,
    icon: e.icon,
    kind: e.kind,
    component: e.component,
    moduleId: e.moduleId,
  })),
]);

const current = computed(() => nav.value.find((n) => n.id === active.value) || nav.value[0]);
const docModuleId = computed(() =>
  current.value?.kind === 'doc' ? current.value.moduleId ?? '' : '',
);

function select(id: NavId) {
  active.value = id;
  mobileNavOpen.value = false;
}
</script>

<template>
  <div class="ext-panel">
    <!-- 手机：顶部菜单按钮 + 当前项 -->
    <div class="mobile-bar">
      <button class="menu-btn" @click="mobileNavOpen = !mobileNavOpen">☰ 菜单</button>
      <span class="cur">{{ current?.icon }} {{ current?.title }}</span>
    </div>

    <div class="cols">
      <!-- 左导航 -->
      <aside class="nav" :class="{ show: mobileNavOpen }">
        <button
          v-for="e in extensions"
          :key="e.id"
          class="nav-item"
          :class="{ on: active === e.id }"
          @click="select(e.id)"
        >
          <span class="ni-icon">{{ e.icon }}</span><span class="ni-text">{{ e.title }}</span>
        </button>
      </aside>

      <!-- 右内容 -->
      <section class="content">
        <ModuleView v-if="current?.kind === 'doc'" :module-id="docModuleId" />
        <component v-else :is="current?.component" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.ext-panel { width: 100%; display: flex; flex-direction: column; }
.mobile-bar { display: none; }
.cols { display: grid; grid-template-columns: 220px 1fr; align-items: stretch; min-height: 60vh; }
.nav { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-right: 1px solid var(--border); }
.nav-item {
  display: flex; align-items: center; gap: 10px; text-align: left;
  background: transparent; border: 1px solid transparent; color: var(--text-dim);
  padding: 10px 12px; border-radius: 8px; font-size: 14px;
}
.nav-item:hover { background: var(--panel); }
.nav-item.on { background: var(--panel); border-color: var(--accent); color: var(--text); }
.ni-icon { font-size: 18px; }
.content { padding: 8px 18px; min-width: 0; }

@media (max-width: 900px) {
  .mobile-bar {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; border-bottom: 1px solid var(--border);
  }
  .menu-btn {
    background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
    padding: 8px 14px; border-radius: 8px; font-size: 13px;
  }
  .cur { font-size: 14px; color: var(--text); }
  .cols { display: block; position: relative; }
  .nav {
    display: none; position: absolute; inset: 0; z-index: 5;
    background: var(--bg-soft); padding: 12px; gap: 8px; border-right: none;
  }
  .nav.show { display: flex; }
  .content { padding: 12px 6px; }
}
</style>
