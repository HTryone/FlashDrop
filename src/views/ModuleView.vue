<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { fetchDocs, renderMarkdown } from '@/extensions/doc';
import type { DocItem } from '@/extensions/types';

const props = defineProps<{ moduleId: string }>();

const docs = ref<DocItem[]>([]);
const activeId = ref<string>('');
const loading = ref(true);
const navOpen = ref(false);

async function load() {
  loading.value = true;
  docs.value = await fetchDocs(props.moduleId);
  loading.value = false;
  if (docs.value.length && !docs.value.some((d) => d.id === activeId.value)) {
    activeId.value = docs.value[0].id;
  }
}
onMounted(load);
watch(() => props.moduleId, load);

const active = computed(() => docs.value.find((d) => d.id === activeId.value) || null);
const idx = computed(() => docs.value.findIndex((d) => d.id === activeId.value));
const prev = computed(() => (idx.value > 0 ? docs.value[idx.value - 1] : null));
const next = computed(() =>
  idx.value >= 0 && idx.value < docs.value.length - 1 ? docs.value[idx.value + 1] : null,
);

function go(id: string) {
  activeId.value = id;
  navOpen.value = false;
  const el = document.getElementById('doc-top');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function toggleNav() {
  navOpen.value = !navOpen.value;
}
function closeNav() {
  navOpen.value = false;
}
</script>

<template>
  <div class="module" :class="{ open: navOpen }">
    <!-- 左侧一级目录 -->
    <nav class="toc">
      <div class="toc-head">
        <span class="toc-title">目录</span>
        <button class="toc-close" @click="closeNav">✕</button>
      </div>
      <button
        v-for="d in docs"
        :key="d.id"
        class="toc-item"
        :class="{ on: d.id === activeId }"
        @click="go(d.id)"
      >
        {{ d.title }}
      </button>
    </nav>

    <!-- 右侧 markdown 教程 -->
    <article class="doc">
      <button class="nav-trigger" @click="toggleNav">☰ 目录</button>
      <span id="doc-top"></span>

      <p v-if="loading" class="faint">加载中…</p>
      <p v-else-if="!docs.length" class="faint">暂无内容。</p>
      <template v-else>
        <h2 v-if="active" class="doc-title">{{ active.title }}</h2>
        <div class="doc-body" v-html="active ? renderMarkdown(active.markdown) : ''"></div>
        <div class="pager">
          <button class="pg" :disabled="!prev" @click="prev && go(prev.id)">‹ 上一页</button>
          <span class="pg-info">{{ idx + 1 }} / {{ docs.length }}</span>
          <button class="pg" :disabled="!next" @click="next && go(next.id)">下一页 ›</button>
        </div>
      </template>
    </article>

    <div class="shade" @click="closeNav"></div>
  </div>
</template>

<style scoped>
.module { width: 100%; display: grid; grid-template-columns: 220px 1fr; gap: 32px; align-items: start; }
.toc {
  position: sticky; top: 74px; align-self: start;
  display: flex; flex-direction: column; gap: 2px; padding-right: 8px;
}
.toc-head { display: none; }
.toc-title { font-size: 12px; color: var(--text-faint); margin: 4px 0 8px 10px; }
.toc-item {
  text-align: left; background: none; border: none; border-left: 2px solid transparent;
  color: var(--text-dim); padding: 6px 10px; font-size: 13px; line-height: 1.4; cursor: pointer;
}
.toc-item:hover { color: var(--text); }
.toc-item.on { color: var(--accent); border-left-color: var(--accent); font-weight: 600; }

.doc { min-width: 0; }
.nav-trigger { display: none; }
.doc-title { margin: 0 0 12px; font-size: 18px; scroll-margin-top: 80px; }
.doc-body { font-size: 13.5px; line-height: 1.8; color: var(--text-dim); }
.doc-body :deep(h1), .doc-body :deep(h2), .doc-body :deep(h3) { color: var(--text); margin: 10px 0 6px; }
.doc-body :deep(a) { color: var(--accent); }
.doc-body :deep(code) { background: var(--panel-2); padding: 1px 5px; border-radius: 5px; }
.doc-body :deep(ul), .doc-body :deep(ol) { padding-left: 18px; }
.doc-body :deep(li) { margin: 3px 0; }
.doc-body :deep(input[type="checkbox"]) { margin-right: 6px; vertical-align: middle; }
.doc-body :deep(blockquote) { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--text-faint); }
.doc-body :deep(p) { margin: 6px 0; }
.doc-body :deep(img) { max-width: 100%; border-radius: 8px; margin: 8px 0; display: block; }
.doc-body :deep(table) { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 13px; }
.doc-body :deep(th), .doc-body :deep(td) { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
.doc-body :deep(th) { background: var(--panel-2); color: var(--text); }
.doc-body :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
.doc-body :deep(del) { color: var(--text-faint); }
.doc-body :deep(h4), .doc-body :deep(h5), .doc-body :deep(h6) { color: var(--text); margin: 8px 0 4px; }
.pager { display: flex; align-items: center; gap: 12px; margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--border); }
.pg { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 7px 14px; border-radius: 8px; font-size: 13px; }
.pg:disabled { opacity: 0.4; cursor: not-allowed; }
.pg-info { font-size: 12px; color: var(--text-faint); }
.faint { color: var(--text-faint); font-size: 13px; }

.shade { display: none; }

/* 手机：侧滑平移 */
@media (max-width: 760px) {
  .module { position: relative; overflow: hidden; }
  .toc {
    position: absolute; left: 0; top: 0; bottom: 0; width: 220px;
    background: var(--bg); border-right: 1px solid var(--border);
    padding: 12px 10px 12px 12px; z-index: 2;
    transform: translateX(-100%); transition: transform .25s ease;
  }
  .module.open .toc { transform: translateX(0); }
  .toc-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; padding: 0 4px; }
  .toc-title { margin: 0; }
  .toc-close { background: none; border: none; color: var(--text-faint); font-size: 16px; padding: 4px; }

  .doc { position: relative; z-index: 1; transition: transform .25s ease; }
  .module.open .doc { transform: translateX(220px); }

  .nav-trigger {
    display: inline-flex; align-items: center; gap: 6px;
    background: none; border: 1px solid var(--border); color: var(--text-dim);
    padding: 6px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; cursor: pointer;
  }
  .nav-trigger:hover { border-color: var(--accent); color: var(--text); }

  .shade {
    display: block; position: absolute; inset: 0; z-index: 1;
    background: rgba(0, 0, 0, .35); opacity: 0; pointer-events: none; transition: opacity .25s ease;
  }
  .module.open .shade { opacity: 1; pointer-events: auto; }
}
</style>
