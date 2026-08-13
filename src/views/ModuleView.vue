<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { fetchDocs, renderMarkdown, type DocItem } from '@/extensions/markdown-post/markdown-post';

const props = defineProps<{ moduleId: string }>();

const docs = ref<DocItem[]>([]);
const activeId = ref<string>('');
const loading = ref(true);

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
}
</script>

<template>
  <div class="module">
    <p v-if="loading" class="faint">加载中…</p>
    <p v-else-if="!docs.length" class="faint">暂无内容。</p>
    <template v-else>
      <div class="layout">
        <nav class="toc">
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
        <article class="doc">
          <h2 v-if="active" class="doc-title">{{ active.title }}</h2>
          <div class="doc-body" v-html="active ? renderMarkdown(active.markdown) : ''"></div>
          <div class="pager">
            <button class="pg" :disabled="!prev" @click="prev && go(prev.id)">‹ 上一页</button>
            <span class="pg-info">{{ idx + 1 }} / {{ docs.length }}</span>
            <button class="pg" :disabled="!next" @click="next && go(next.id)">下一页 ›</button>
          </div>
        </article>
      </div>
    </template>
  </div>
</template>

<style scoped>
.module { width: 100%; }
.layout { display: grid; grid-template-columns: 220px 1fr; gap: 32px; align-items: start; }
.toc { display: flex; flex-direction: column; gap: 2px; position: sticky; top: 74px; align-self: start; }
.toc-item {
  text-align: left; background: none; border: none; border-left: 2px solid transparent;
  color: var(--text-dim); padding: 6px 10px; border-radius: 0; font-size: 13px; line-height: 1.4;
}
.toc-item:hover { color: var(--text); }
.toc-item.on { color: var(--accent); border-left-color: var(--accent); font-weight: 600; }
.doc { min-width: 0; }
.doc-title { margin: 0 0 12px; font-size: 18px; scroll-margin-top: 80px; }
.doc-body { font-size: 13.5px; line-height: 1.7; color: var(--text-dim); }
.doc-body :deep(h1), .doc-body :deep(h2), .doc-body :deep(h3) { color: var(--text); margin: 10px 0 6px; }
.doc-body :deep(a) { color: var(--accent); }
.doc-body :deep(code) { background: var(--panel-2); padding: 1px 5px; border-radius: 5px; }
.doc-body :deep(ul) { padding-left: 18px; }
.doc-body :deep(blockquote) { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--text-faint); }
.doc-body :deep(p) { margin: 6px 0; }
.pager { display: flex; align-items: center; gap: 12px; margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--border); }
.pg { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 7px 14px; border-radius: 8px; font-size: 13px; }
.pg:disabled { opacity: 0.4; cursor: not-allowed; }
.pg-info { font-size: 12px; color: var(--text-faint); }
.faint { color: var(--text-faint); font-size: 13px; }

@media (max-width: 760px) {
  .layout { grid-template-columns: 1fr; gap: 14px; }
  .toc { position: static; flex-direction: row; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
  .toc-item { border-left: none; border: 1px solid var(--border); border-radius: 999px; font-size: 12px; }
  .toc-item.on { border-color: var(--accent); }
}
</style>
