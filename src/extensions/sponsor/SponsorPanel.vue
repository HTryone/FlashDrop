<script setup lang="ts">
import { sponsors } from './sponsor';

function go(link: string) {
  if (link) window.open(link, '_blank', 'noopener');
}
</script>

<template>
  <div class="sponsor">
    <div v-for="(s, i) in sponsors" :key="i" class="sponsor-card">
      <div class="thumb">
        <img v-if="s.imageUrl" :src="s.imageUrl" :alt="s.title" />
        <div v-else class="thumb-empty">二维码 / 图片待配置</div>
      </div>
      <div class="info">
        <h3>{{ s.title }}</h3>
        <p class="muted">{{ s.desc }}</p>
        <button v-if="s.link" class="btn primary" @click="go(s.link)">前往赞助 ↗</button>
        <p v-else class="faint small">赞助地址待配置</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sponsor { display: flex; flex-direction: column; gap: 16px; }
.sponsor-card { display: flex; gap: 16px; align-items: flex-start; }
.thumb {
  width: 140px; height: 140px; flex: none;
  border-radius: var(--radius-sm); overflow: hidden;
  background: var(--panel-2); border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb-empty { font-size: 12px; color: var(--text-faint); text-align: center; padding: 8px; }
.info { flex: 1; }
.info h3 { margin: 0 0 6px; font-size: 16px; }
.info .muted { margin: 0 0 12px; line-height: 1.6; }
.small { font-size: 12px; }

@media (max-width: 520px) {
  .sponsor-card { flex-direction: column; }
  .thumb { width: 100%; height: 180px; }
}
</style>
