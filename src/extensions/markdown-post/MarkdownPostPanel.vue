<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { fetchPosts, renderMarkdown, type Post } from './markdown-post';

const posts = ref<Post[]>([]);
const loading = ref(true);

onMounted(async () => {
  posts.value = await fetchPosts();
  loading.value = false;
});
</script>

<template>
  <div class="posts">
    <p v-if="loading" class="faint">加载中…</p>
    <p v-else-if="!posts.length" class="faint">暂无内容。</p>
    <article v-for="p in posts" :key="p.id" class="post">
      <h3 v-if="p.title" class="post-title">{{ p.title }}</h3>
      <div class="post-body" v-html="renderMarkdown(p.markdown)"></div>
    </article>
  </div>
</template>

<style scoped>
.posts { display: flex; flex-direction: column; gap: 18px; }
.post { padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.post:last-child { border-bottom: none; }
.post-title { margin: 0 0 8px; font-size: 16px; color: var(--text); }
.post-body { font-size: 13.5px; line-height: 1.7; color: var(--text-dim); }
.post-body :deep(h1), .post-body :deep(h2), .post-body :deep(h3) { color: var(--text); margin: 10px 0 6px; }
.post-body :deep(a) { color: var(--accent); }
.post-body :deep(code) { background: var(--panel-2); padding: 1px 5px; border-radius: 5px; }
.post-body :deep(ul) { padding-left: 18px; }
.post-body :deep(blockquote) { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--text-faint); }
.post-body :deep(p) { margin: 6px 0; }
.faint { color: var(--text-faint); font-size: 13px; }
</style>
