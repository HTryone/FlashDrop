<script setup lang="ts">
import { ref } from 'vue';
import { tutorial, formatInline, type Block } from './usage';

const activeId = ref<string>(tutorial[0]?.id ?? '');

function go(id: string) {
  activeId.value = id;
  document.getElementById('sec-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
</script>

<template>
  <div class="usage">
    <!-- 左侧悬停目录：教程章节标题 -->
    <nav class="toc">
      <div class="toc-title">目录</div>
      <button
        v-for="s in tutorial"
        :key="s.id"
        class="toc-item"
        :class="{ on: s.id === activeId }"
        @click="go(s.id)"
      >
        {{ s.title }}
      </button>
    </nav>

    <!-- 右侧内容 -->
    <article class="doc">
      <section
        v-for="s in tutorial"
        :key="s.id"
        :id="'sec-' + s.id"
        class="sec"
      >
        <h2 class="sec-title">{{ s.title }}</h2>

        <template v-for="(b, i) in s.blocks" :key="i">
          <!-- 段落 -->
          <p v-if="b.type === 'p'" class="para" v-html="formatInline(b.text || '')" />

          <!-- 无序列表 -->
          <ul v-else-if="b.type === 'ul'" class="lst">
            <li v-for="(it, j) in b.items" :key="j" v-html="formatInline(it)" />
          </ul>

          <!-- 有序列表 -->
          <ol v-else-if="b.type === 'ol'" class="lst ol">
            <li v-for="(it, j) in b.items" :key="j" v-html="formatInline(it)" />
          </ol>

          <!-- 提示框 -->
          <div
            v-else-if="b.type === 'callout'"
            class="callout"
            :class="b.variant || 'note'"
            v-html="formatInline(b.text || '')"
          />

          <!-- 代码/结构块 -->
          <pre v-else-if="b.type === 'code'" class="code"><code>{{ b.text }}</code></pre>

          <!-- 表格 -->
          <table v-else-if="b.type === 'table'" class="tbl">
            <thead>
              <tr>
                <th v-for="(h, j) in b.headers" :key="j">{{ h }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, r) in b.rows" :key="r">
                <td v-for="(c, cj) in row" :key="cj" v-html="formatInline(c)" />
              </tr>
            </tbody>
          </table>
        </template>
      </section>
    </article>
  </div>
</template>

<style scoped>
/* 左目录 + 右内容，整体同底 */
.usage { display: grid; grid-template-columns: 220px 1fr; gap: 32px; width: 100%; align-items: start; }

/* 左侧目录：悬停、不随内容滚走，避开顶栏 */
.toc {
  position: sticky; top: 74px; align-self: start;
  display: flex; flex-direction: column; gap: 2px;
  padding-right: 8px;
}
.toc-title { font-size: 12px; color: var(--text-faint); margin: 4px 0 8px 10px; }
.toc-item {
  text-align: left; background: none; border: none; border-left: 2px solid transparent;
  color: var(--text-dim); padding: 6px 10px; font-size: 13px; cursor: pointer; line-height: 1.4;
}
.toc-item:hover { color: var(--text); }
.toc-item.on { color: var(--accent); border-left-color: var(--accent); font-weight: 600; }

/* 右侧内容 */
.doc { min-width: 0; }
.sec { margin-bottom: 28px; scroll-margin-top: 80px; }
.sec-title {
  font-size: 18px; margin: 0 0 12px; padding-bottom: 8px;
  border-bottom: 1px solid var(--border); color: var(--text);
}
.para { line-height: 1.85; font-size: 14px; color: var(--text-dim); margin: 8px 0; }
.para :deep(strong) { color: var(--text); }
.lst { margin: 8px 0; padding-left: 20px; line-height: 1.85; font-size: 14px; color: var(--text-dim); }
.lst.ol { list-style: decimal; }
.lst li { margin-bottom: 5px; }
.lst :deep(strong) { color: var(--text); }
.lst :deep(code) { background: var(--panel-2); padding: 1px 6px; border-radius: 5px; font-size: 12.5px; color: var(--accent-2); }

/* 提示框 */
.callout {
  margin: 12px 0; padding: 11px 14px; border-radius: 10px; font-size: 13.5px; line-height: 1.7;
  border: 1px solid var(--border); border-left-width: 4px; color: var(--text-dim);
}
.callout :deep(strong) { color: var(--text); }
.callout.tip { background: rgba(56, 139, 253, 0.08); border-left-color: #58a6ff; }
.callout.warn { background: rgba(210, 153, 34, 0.1); border-left-color: #e3b341; }
.callout.secure { background: rgba(63, 185, 80, 0.1); border-left-color: #3fb950; }
.callout.note { border-left-color: var(--text-faint); } /* 无卡片背景，统一底色 */

/* 代码/结构块 */
.code {
  margin: 12px 0; padding: 12px 14px; border-radius: 10px; overflow-x: auto;
  background: #0d1117; border: 1px solid var(--border); color: #c9d1d9; font-size: 12.5px; line-height: 1.7;
}

/* 表格 */
.tbl { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
.tbl th, .tbl td {
  border: 1px solid var(--border); padding: 9px 11px; text-align: left; vertical-align: top;
  color: var(--text-dim); line-height: 1.6;
}
.tbl th { color: var(--text); font-weight: 600; }
.tbl :deep(strong) { color: var(--text); }
.tbl :deep(code) { background: var(--panel-2); padding: 1px 5px; border-radius: 5px; font-size: 12px; color: var(--accent-2); }

@media (max-width: 760px) {
  .usage { grid-template-columns: 1fr; gap: 14px; }
  .toc { position: static; flex-direction: row; flex-wrap: wrap; gap: 6px; padding-right: 0; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
  .toc-title { width: 100%; margin: 0 0 4px; }
  .toc-item { border-left: none; border: 1px solid var(--border); border-radius: 999px; font-size: 12px; }
  .toc-item.on { border-color: var(--accent); }
  .tbl { font-size: 12px; }
  .tbl th, .tbl td { padding: 7px 8px; }
}
</style>
