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
.sponsor { display: flex; flex-direction: column; gap: 32px; align-items: center; }
.sponsor-card {
  display: flex; flex-direction: column; align-items: center;
  gap: 16px; text-align: center;
  width: 100%; max-width: 360px;
}
.thumb {
  width: 280px; height: 280px; flex: none;
  border-radius: var(--radius-sm); overflow: hidden;
  background: #fff; border: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 12px rgba(0,0,0,.35);
}
.thumb img { width: 100%; height: 100%; object-fit: contain; }
.thumb-empty { font-size: 12px; color: var(--text-faint); text-align: center; padding: 8px; }
.info { flex: none; width: 100%; }
.info h3 { margin: 0 0 8px; font-size: 18px; }
.info .muted { margin: 0 0 16px; line-height: 1.6; }
.small { font-size: 12px; }

@media (max-width: 520px) {
  .thumb { width: min(100%, 280px); height: auto; aspect-ratio: 1 / 1; }
}
</style>
