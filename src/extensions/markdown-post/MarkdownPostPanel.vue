<script setup lang="ts">
import { ref, computed } from 'vue';
import { renderMarkdown, wrapPost } from './markdown-post';

const src = ref('');
const previewHtml = computed(() => renderMarkdown(src.value));
const postText = computed(() => wrapPost(src.value));

function copyPost() {
  navigator.clipboard?.writeText(postText.value).catch(() => {});
}
</script>

<template>
  <div class="md-post">
    <div class="cols">
      <div class="col">
        <label class="col-label">Markdown 源</label>
        <textarea v-model="src" placeholder="在此粘贴 Markdown…" spellcheck="false"></textarea>
      </div>
      <div class="col">
        <label class="col-label">预览</label>
        <div class="preview" v-html="previewHtml"></div>
      </div>
    </div>
    <div class="actions">
      <button class="btn" @click="copyPost" :disabled="!src.trim()">复制成帖（带品牌尾）</button>
    </div>
  </div>
</template>

<style scoped>
.md-post { display: flex; flex-direction: column; gap: 14px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.col { display: flex; flex-direction: column; gap: 6px; }
.col-label { font-size: 12px; color: var(--text-faint); }
textarea {
  width: 100%; height: 280px; resize: vertical;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text); padding: 12px;
  font-size: 13px; line-height: 1.6;
}
.preview {
  height: 280px; overflow: auto; padding: 12px 14px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: 13.5px; line-height: 1.7; color: var(--text-dim);
}
.preview :deep(h1), .preview :deep(h2), .preview :deep(h3) { color: var(--text); margin: 10px 0 6px; }
.preview :deep(a) { color: var(--accent); }
.preview :deep(code) { background: var(--panel-2); padding: 1px 5px; border-radius: 5px; }
.preview :deep(ul) { padding-left: 18px; }
.preview :deep(blockquote) { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--text-faint); }
.preview :deep(p) { margin: 6px 0; }
.actions { display: flex; gap: 10px; }

@media (max-width: 640px) {
  .cols { grid-template-columns: 1fr; }
}
</style>
