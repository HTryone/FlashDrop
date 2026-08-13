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
// 代码块复制按钮（事件委托：点击 .code-copy 复制同块 <pre> 文本）
function onDocClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  const btn = t.closest('.code-copy') as HTMLElement | null;
  if (!btn) return;
  const pre = btn.closest('.code-block')?.querySelector('pre');
  if (!pre) return;
  navigator.clipboard?.writeText(pre.textContent || '').then(() => {
    const old = btn.textContent;
    btn.textContent = '已复制 ✓';
    setTimeout(() => (btn.textContent = old), 1200);
  });
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
        <div class="doc-body" @click="onDocClick" v-html="active ? renderMarkdown(active.markdown) : ''"></div>
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
/* ===== 文档正文：GitHub 深色配色 + Typora 阅读舒适 ===== */
.doc-body {
  --md-fg: #e6edf3;
  --md-muted: #7d8590;
  --md-border: #30363d;
  --md-subtle: #161b22;
  --md-code: #a5d6ff;
  --md-pre: #c9d1d9;
  --md-link: #58a6ff;
  --md-head: #f0f6fc;
  max-width: 860px;
  font-size: 15px;
  line-height: 1.75;
  color: var(--md-fg);
}
.doc-body :deep(*:first-child) { margin-top: 0; }
.doc-body :deep(*:last-child) { margin-bottom: 0; }

/* 标题：显式字号分级 + 字重 + 紧凑字距 + h1/h2 下边框分隔 */
.doc-body :deep(h1), .doc-body :deep(h2), .doc-body :deep(h3), .doc-body :deep(h4), .doc-body :deep(h5), .doc-body :deep(h6) {
  color: var(--md-head); margin: 26px 0 12px; font-weight: 600; line-height: 1.3;
}
.doc-body :deep(h1) { font-size: 1.9em; letter-spacing: -.02em; }
.doc-body :deep(h2) { font-size: 1.5em; letter-spacing: -.01em; }
.doc-body :deep(h3) { font-size: 1.25em; }
.doc-body :deep(h4) { font-size: 1.05em; }
.doc-body :deep(h5) { font-size: .95em; color: var(--md-muted); }
.doc-body :deep(h6) { font-size: .9em; color: var(--md-muted); }
.doc-body :deep(h1), .doc-body :deep(h2) {
  padding-bottom: 8px; border-bottom: 1px solid var(--md-border);
}

/* 链接 */
.doc-body :deep(a) { color: var(--md-link); text-decoration: none; }
.doc-body :deep(a):hover { text-decoration: underline; }

/* 行内代码 */
.doc-body :deep(code) {
  background: rgba(110,118,129,.28); color: var(--md-code);
  padding: 2px 6px; border-radius: 5px; font-size: .88em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* 代码块：外层容器承载边框/圆角/语言标签/复制按钮；内部 pre 去边框 */
.doc-body :deep(.code-block) {
  position: relative; background: var(--md-subtle); border: 1px solid var(--md-border);
  border-radius: 8px; margin: 16px 0; box-shadow: 0 1px 6px rgba(0,0,0,.35); overflow: hidden;
}
.doc-body :deep(.code-head) {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px 6px 14px; border-bottom: 1px solid var(--md-border);
  background: rgba(255,255,255,.02);
}
.doc-body :deep(.code-lang) {
  font-size: 11px; color: var(--md-muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-transform: uppercase; letter-spacing: .05em;
}
.doc-body :deep(.code-copy) {
  background: var(--panel-2); border: 1px solid var(--md-border); color: var(--md-muted);
  font-size: 11px; padding: 3px 10px; border-radius: 5px; cursor: pointer; transition: .15s;
}
.doc-body :deep(.code-copy):hover { color: var(--md-fg); border-color: var(--accent); }
.doc-body :deep(.code-block pre) {
  margin: 0; border: none; border-radius: 0; box-shadow: none; background: none;
}
.doc-body :deep(pre) {
  background: var(--md-subtle); border: 1px solid var(--md-border); border-radius: 8px;
  padding: 16px; margin: 16px 0; overflow-x: auto; line-height: 1.6; font-size: 13px;
  box-shadow: 0 1px 6px rgba(0,0,0,.35);
}
.doc-body :deep(pre code) {
  background: none; color: var(--md-pre); padding: 0; border-radius: 0; font-size: 1em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* 列表 */
.doc-body :deep(ul), .doc-body :deep(ol) { padding-left: 24px; }
.doc-body :deep(li) { margin: 6px 0; }
.doc-body :deep(li)::marker { color: var(--md-muted); }
.doc-body :deep(li > ul), .doc-body :deep(li > ol) { margin: 4px 0; }

/* 任务列表 */
.doc-body :deep(input[type="checkbox"]) {
  margin-right: 7px; vertical-align: middle; accent-color: var(--accent); width: 15px; height: 15px;
}

/* 引用：强调色左边框 + 浅底色 + 右侧圆角 */
.doc-body :deep(blockquote) {
  margin: 16px 0; padding: 10px 16px; border-left: 4px solid var(--accent);
  background: rgba(47,129,247,.07); border-radius: 0 8px 8px 0;
  color: var(--md-muted);
}
.doc-body :deep(blockquote p) { margin: 0; }

.doc-body :deep(p) { margin: 0 0 16px; }

/* 图片 */
.doc-body :deep(img) {
  max-width: 100%; border-radius: 8px; margin: 16px 0; display: block;
  box-shadow: 0 1px 10px rgba(0,0,0,.4);
}

/* 表格：GitHub 风，表头深底 + 斑马纹 + 悬停高亮 */
.doc-body :deep(table) { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 13.5px; }
.doc-body :deep(th), .doc-body :deep(td) {
  border: 1px solid var(--md-border); padding: 8px 13px; text-align: left;
}
.doc-body :deep(th) { background: var(--md-subtle); color: var(--md-head); font-weight: 600; }
.doc-body :deep(tbody tr):nth-child(2n) { background: rgba(255,255,255,.03); }
.doc-body :deep(tbody tr):hover { background: rgba(47,129,247,.06); }

/* 分隔线：居中渐隐，优雅不突兀 */
.doc-body :deep(hr) {
  border: 0; height: 1px; margin: 24px 0;
  background: linear-gradient(90deg, transparent, var(--md-border), transparent);
}

.doc-body :deep(del) { color: var(--md-muted); }
/* 高亮 ==文字== 与键盘键 <kbd> */
.doc-body :deep(mark) { background: rgba(187,128,9,.35); color: var(--md-fg); padding: 0 3px; border-radius: 3px; }
.doc-body :deep(kbd) {
  background: var(--panel-2); border: 1px solid var(--md-border); border-bottom-width: 2px;
  border-radius: 5px; padding: 1px 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .85em; color: var(--md-fg);
}
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
