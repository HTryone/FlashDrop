<script setup lang="ts">
import { ref } from 'vue';
import { tutorial, formatInline, type Block } from './usage';

const activeId = ref<string>(tutorial[0]?.id ?? '');
const navOpen = ref(false);

function go(id: string) {
  activeId.value = id;
  navOpen.value = false;
  document.getElementById('sec-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function toggleNav() {
  navOpen.value = !navOpen.value;
}
function closeNav() {
  navOpen.value = false;
}
</script>

<template>
  <div class="usage" :class="{ open: navOpen }">
    <!-- 桌面：左侧悬停目录；手机：左侧滑出目录 -->
    <nav class="toc">
      <div class="toc-head">
        <span class="toc-title">目录</span>
        <button class="toc-close" @click="closeNav">✕</button>
      </div>
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
      <!-- 手机：触发侧滑的目录按钮 -->
      <button class="nav-trigger" @click="toggleNav">☰ 目录</button>

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

    <!-- 手机遮罩，点击收回 -->
    <div class="shade" @click="closeNav"></div>
  </div>
</template>

<style scoped>
/* 桌面：左目录 + 右内容 */
.usage { display: grid; grid-template-columns: 220px 1fr; gap: 32px; width: 100%; align-items: start; }

.toc {
  position: sticky; top: 74px; align-self: start;
  display: flex; flex-direction: column; gap: 2px;
  padding-right: 8px;
}
.toc-head { display: none; }
.toc-title { font-size: 12px; color: var(--text-faint); margin: 4px 0 8px 10px; }
.toc-item {
  text-align: left; background: none; border: none; border-left: 2px solid transparent;
  color: var(--text-dim); padding: 6px 10px; font-size: 13px; cursor: pointer; line-height: 1.4;
}
.toc-item:hover { color: var(--text); }
.toc-item.on { color: var(--accent); border-left-color: var(--accent); font-weight: 600; }

.doc { min-width: 0; }
.nav-trigger { display: none; }
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
.callout.note { border-left-color: var(--text-faint); }

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

.shade { display: none; }

/* 手机：侧滑平移 */
@media (max-width: 760px) {
  .usage { display: block; position: relative; overflow: hidden; }

  .toc {
    position: absolute; left: 0; top: 0; bottom: 0; width: 220px;
    background: var(--bg); border-right: 1px solid var(--border);
    padding: 12px 10px 12px 12px; z-index: 2;
    transform: translateX(-100%); transition: transform .25s ease;
  }
  .usage.open .toc { transform: translateX(0); }

  .toc-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; padding: 0 4px; }
  .toc-title { margin: 0; }
  .toc-close { background: none; border: none; color: var(--text-faint); font-size: 16px; padding: 4px; }

  .doc { position: relative; z-index: 1; transition: transform .25s ease; }
  .usage.open .doc { transform: translateX(220px); }

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
  .usage.open .shade { opacity: 1; pointer-events: auto; }
}
</style>
