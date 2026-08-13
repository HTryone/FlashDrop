<script setup lang="ts">
import { tutorial, formatInline, type Block } from './usage';

function go(id: string) {
  document.getElementById('sec-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
</script>

<template>
  <div class="usage">
    <!-- 目录导航 -->
    <nav class="toc">
      <span class="toc-title">目录</span>
      <button v-for="s in tutorial" :key="s.id" class="toc-item" @click="go(s.id)">
        {{ s.title }}
      </button>
    </nav>

    <!-- 章节 -->
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
  </div>
</template>

<style scoped>
.usage { width: 100%; max-width: 860px; }

/* 目录 */
.toc {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 10px 12px; margin-bottom: 18px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  position: sticky; top: 0; z-index: 5;
}
.toc-title { font-size: 12px; color: var(--text-faint); margin-right: 4px; }
.toc-item {
  background: var(--panel-2); border: 1px solid var(--border); color: var(--text-dim);
  padding: 5px 10px; border-radius: 999px; font-size: 12px; cursor: pointer;
}
.toc-item:hover { border-color: var(--accent); color: var(--text); }

/* 章节 */
.sec { margin-bottom: 26px; scroll-margin-top: 64px; }
.sec-title {
  font-size: 18px; margin: 0 0 12px; padding-bottom: 8px;
  border-bottom: 1px solid var(--border); color: var(--text);
}
.para { line-height: 1.8; font-size: 14px; color: var(--text-dim); margin: 8px 0; }
.para :deep(strong) { color: var(--text); }
.lst { margin: 8px 0; padding-left: 20px; line-height: 1.8; font-size: 14px; color: var(--text-dim); }
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
.callout.note { background: var(--panel); border-left-color: var(--text-faint); }

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
.tbl th { background: var(--panel); color: var(--text); font-weight: 600; }
.tbl :deep(strong) { color: var(--text); }
.tbl :deep(code) { background: var(--panel-2); padding: 1px 5px; border-radius: 5px; font-size: 12px; color: var(--accent-2); }

@media (max-width: 900px) {
  .toc { position: static; }
  .tbl { font-size: 12px; }
  .tbl th, .tbl td { padding: 7px 8px; }
}
</style>
