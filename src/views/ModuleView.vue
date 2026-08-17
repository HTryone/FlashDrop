<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { fetchDocs, renderMarkdown, slugify } from '@/extensions/doc';
import type { DocItem } from '@/extensions/types';

const props = defineProps<{ moduleId: string; showBack?: boolean }>();
const emit = defineEmits<{ back: [] }>();

interface Heading {
  id: string;
  text: string;
  level: number;
}
interface DocNav {
  doc: DocItem;
  headings: Heading[];
  open: boolean;
}

const docs = ref<DocItem[]>([]);
const nav = ref<DocNav[]>([]);
const activeId = ref<string>('');
const activeHeadingId = ref<string>('');
const loading = ref(true);
const navOpen = ref(false);

function parseHeadings(src: string): Heading[] {
  const used = new Set<string>();
  const out: Heading[] = [];
  for (const line of src.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^\s{0,3}(#{1,2})\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const text = m[2].trim();
    out.push({ level: m[1].length, text, id: slugify(text, used) });
  }
  return out;
}

async function load() {
  loading.value = true;
  docs.value = await fetchDocs(props.moduleId);
  nav.value = docs.value.map((d) => ({ doc: d, headings: parseHeadings(d.markdown), open: false }));
  loading.value = false;
  if (docs.value.length && !docs.value.some((d) => d.id === activeId.value)) {
    activeId.value = docs.value[0].id;
  }
}
onMounted(load);
watch(() => props.moduleId, load);

watch(activeId, (id) => {
  activeHeadingId.value = nav.value.find((n) => n.doc.id === id)?.headings[0]?.id || '';
});

const active = computed(() => docs.value.find((d) => d.id === activeId.value) || null);
const activeNav = computed(() => nav.value.find((n) => n.doc.id === activeId.value) || null);

// 如果正文第一个 h1 与文档名重复，自动隐藏，避免目录和正文双重复展示
const contentHtml = computed(() => {
  if (!active.value) return '';
  const title = active.value.title.trim();
  const html = renderMarkdown(active.value.markdown);
  if (!title) return html;
  return html;
});
const idx = computed(() => docs.value.findIndex((d) => d.id === activeId.value));
const prev = computed(() => (idx.value > 0 ? docs.value[idx.value - 1] : null));
const next = computed(() =>
  idx.value >= 0 && idx.value < docs.value.length - 1 ? docs.value[idx.value + 1] : null,
);

function go(id: string) {
  activeId.value = id;
  navOpen.value = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function goHeading(id: string) {
  activeHeadingId.value = id;
  navOpen.value = false;
  const el = document.getElementById(id);
  if (el) {
    const top = el.getBoundingClientRect().top + window.scrollY - 84;
    window.scrollTo({ top, behavior: 'smooth' });
  }
}
function toggleDoc(n: DocNav) {
  const opening = !n.open;
  nav.value.forEach((x) => (x.open = false));
  n.open = opening;
  activeId.value = n.doc.id;
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

// 滚动时只高亮当前篇的 h1/h2，绝不切换文档（否则回滚到顶会把 activeId 重置回第一篇）
let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    // 只看当前打开文档的标题，不混入其它未渲染文档的标题
    const headings = nav.value.find((n) => n.doc.id === activeId.value)?.headings || [];
    if (!headings.length) return;
    const threshold = 100; // 视口顶部 100px 内的标题算"当前"
    let current = headings[0];
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el && el.getBoundingClientRect().top <= threshold) current = h;
    }
    activeHeadingId.value = current.id;
  });
}
onMounted(() => window.addEventListener('scroll', onScroll, { passive: true }));
onUnmounted(() => window.removeEventListener('scroll', onScroll));
</script>

<template>
  <div class="module" :class="{ open: navOpen }">
    <!-- 左侧二级目录：文档 → 标题 -->
    <nav class="toc">
      <div class="toc-head">
        <span class="toc-title">目录</span>
        <button class="toc-close" @click="closeNav">✕</button>
      </div>
      <div class="toc-tree">
        <div
          v-for="n in nav"
          :key="n.doc.id"
          class="toc-doc"
          :class="{ on: n.doc.id === activeId }"
        >
          <button class="toc-doc-name" @click="go(n.doc.id)">
            <span class="toc-arrow" :class="{ open: n.open }" @click.stop="toggleDoc(n)"></span>
            <span class="toc-label">{{ n.doc.title }}</span>
          </button>
          <div v-show="n.open" class="toc-headings">
            <button
              v-for="h in n.headings"
              :key="h.id"
              class="toc-h"
              :class="['level-' + h.level, { on: h.id === activeHeadingId }]"
              @click="goHeading(h.id)"
            >
              {{ h.text }}
            </button>
          </div>
        </div>
      </div>
    </nav>

    <!-- 右侧 markdown 教程 -->
    <article class="doc">
      <div class="doc-bar">
        <button v-if="showBack" class="doc-back" @click="emit('back')">‹ 返回</button>
        <button class="nav-trigger" @click="toggleNav">☰ 目录</button>
      </div>
      <span id="doc-top"></span>

      <p v-if="loading" class="faint">加载中…</p>
      <p v-else-if="!docs.length" class="faint">暂无内容。</p>
      <template v-else>
        <div class="doc-body" @click="onDocClick" v-html="contentHtml"></div>
        <div class="pager">
          <button class="pg" :disabled="!prev" @click="prev && go(prev.id)">‹ 上一篇</button>
          <span class="pg-info">{{ idx + 1 }} / {{ docs.length }}</span>
          <button class="pg" :disabled="!next" @click="next && go(next.id)">下一篇 ›</button>
        </div>
      </template>
    </article>

    <div class="shade" @click="closeNav"></div>
  </div>
</template>

<style scoped>
.module { width: 100%; display: grid; grid-template-columns: 240px 1fr; gap: 32px; align-items: start; }
.toc {
  position: sticky; top: 74px; align-self: start;
  display: flex; flex-direction: column; gap: 2px; padding-right: 8px;
  max-height: calc(100vh - 90px); overflow-y: auto;
}
.toc-head { display: none; }
.toc-title { font-size: 12px; color: var(--text-faint); margin: 4px 0 8px 10px; }

.toc-tree { display: flex; flex-direction: column; gap: 2px; }
.toc-doc { border-radius: 8px; overflow: hidden; }
.toc-doc-name {
  width: 100%; display: flex; align-items: center; gap: 6px;
  text-align: left; background: none; border: none; border-left: 2px solid transparent;
  color: var(--text-dim); padding: 7px 10px 7px 8px; font-size: 13px; line-height: 1.4; cursor: pointer;
  transition: background .15s, color .15s;
}
.toc-doc-name:hover { color: var(--text); background: var(--panel-2); }
.toc-doc.on > .toc-doc-name { color: var(--accent); border-left-color: var(--accent); font-weight: 600; }

.toc-arrow {
  flex: none; width: 30px; height: 30px;
  display: inline-flex; align-items: center; justify-content: center;
  margin-right: 2px; cursor: pointer; border-radius: 6px;
  transition: background .15s;
}
.toc-arrow:hover { background: var(--panel-2); }
.toc-arrow::after {
  content: ''; width: 0; height: 0;
  border-top: 7px solid transparent; border-bottom: 7px solid transparent; border-left: 9px solid currentColor;
  opacity: .8; transition: transform .2s;
}
.toc-arrow.open::after { transform: rotate(90deg); }

.toc-headings {
  display: flex; flex-direction: column; padding: 2px 0 6px 24px; border-left: 2px solid transparent;
}
.toc-doc.on > .toc-headings { border-left-color: var(--accent); }
.toc-h {
  text-align: left; background: none; border: none;
  color: var(--text-dim); padding: 4px 8px; font-size: 12.5px; line-height: 1.45; cursor: pointer;
  border-radius: 5px; transition: background .15s, color .15s;
}
.toc-h:hover { color: var(--text); background: var(--panel-2); }
.toc-h.on { color: var(--accent); font-weight: 600; }
.toc-h.level-2 { padding-left: 14px; opacity: .85; }

.doc { min-width: 0; }
.doc-bar { display: none; }
.nav-trigger { display: none; }
/* 文档正文样式已抽到 src/extensions/ssjs/doc-style.css（与生成器 docs生成器.html 共用同一份）。
   本组件末尾另起一个全局 <style> 通过 @import 引入，改一处两端同步生效。 */
.pager { display: flex; align-items: center; gap: 12px; margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--border); }
.pg { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 7px 14px; border-radius: 8px; font-size: 13px; }
.pg:disabled { opacity: 0.4; cursor: not-allowed; }
.pg-info { font-size: 12px; color: var(--text-faint); }
.faint { color: var(--text-faint); font-size: 13px; }

.shade { display: none; }

  /* 手机：侧滑平移 */
@media (max-width: 760px) {
  .module { position: relative; overflow: hidden; grid-template-columns: 1fr; }
  .toc {
    position: absolute; left: 0; top: 0; bottom: 0; width: 240px;
    background: var(--bg); border-right: 1px solid var(--border);
    padding: 12px 10px 12px 12px; z-index: 2;
    transform: translateX(-100%); transition: transform .25s ease;
  }
  .module.open .toc { transform: translateX(0); }
  .toc-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; padding: 0 4px; }
  .toc-title { margin: 0; }
  .toc-close { background: none; border: none; color: var(--text-faint); font-size: 16px; padding: 4px; }

  .doc { position: relative; z-index: 1; transition: transform .25s ease; }
  .module.open .doc { transform: translateX(240px); }

  .doc-bar {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 14px; gap: 10px;
  }
  .doc-back {
    background: var(--panel-2); border: 1px solid var(--border);
    color: var(--text); padding: 6px 12px; border-radius: 8px; font-size: 13px; cursor: pointer;
  }
  .doc-back:hover { border-color: var(--accent); }
  .nav-trigger {
    display: inline-flex; align-items: center; gap: 6px; margin-left: auto;
    background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
    padding: 6px 12px; border-radius: 8px; font-size: 13px; cursor: pointer;
  }
  .nav-trigger:hover { border-color: var(--accent); color: var(--text); }

  /* 手机侧滑目录只列文档名，不展开 h1/h2 */
  .toc-headings { display: none; }
  .toc-arrow { display: none; }
  .toc-doc-name { padding-left: 10px; }

  .shade {
    display: block; position: absolute; inset: 0; z-index: 1;
    background: rgba(0, 0, 0, .35); opacity: 0; pointer-events: none; transition: opacity .25s ease;
  }
  .module.open .shade { opacity: 1; pointer-events: auto; }
}
</style>

<!-- 文档正文统一样式：与生成器 docs生成器.html 共用 src/extensions/ssjs/doc-style.css，改一处两端同步生效 -->
<style>
@import './../extensions/ssjs/doc-style.css';
</style>
