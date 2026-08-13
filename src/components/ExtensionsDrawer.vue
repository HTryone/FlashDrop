<script setup lang="ts">
import { extensions } from '@/extensions';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; select: [id: string] }>();

function pick(id: string) {
  emit('select', id);
}
</script>

<template>
  <transition name="fade">
    <div v-if="props.open" class="overlay" @click.self="emit('close')">
      <aside class="drawer">
        <header class="drawer-head">
          <span>更多</span>
          <button class="x" @click="emit('close')">✕</button>
        </header>

        <div class="ext-list">
          <button v-for="ext in extensions" :key="ext.id" class="ext-item" @click="pick(ext.id)">
            <span class="ext-icon">{{ ext.icon }}</span>
            <span class="ext-text">
              <strong>{{ ext.title }}</strong>
              <small class="muted">{{ ext.desc }}</small>
            </span>
            <span class="ext-arrow">›</span>
          </button>
          <p class="faint hint">新增模块只需在 <code>src/extensions/index.ts</code> 注册一项，顺序可调。</p>
        </div>
      </aside>
    </div>
  </transition>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0; background: rgba(4, 7, 14, 0.55);
  display: flex; justify-content: flex-end; z-index: 50;
  backdrop-filter: blur(2px);
}
.drawer {
  width: 420px; max-width: 92vw; height: 100%;
  background: var(--bg-soft); border-left: 1px solid var(--border);
  display: flex; flex-direction: column; padding: 18px;
  animation: slidein 0.22s ease;
}
@keyframes slidein { from { transform: translateX(40px); opacity: 0.4; } to { transform: none; opacity: 1; } }
.drawer-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 16px; font-weight: 700; margin-bottom: 14px;
}
.x { background: none; border: none; color: var(--text-dim); font-size: 18px; }
.ext-list { display: flex; flex-direction: column; gap: 10px; overflow: auto; }
.ext-item {
  display: flex; align-items: center; gap: 12px; text-align: left;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 12px; color: var(--text);
}
.ext-item:hover { border-color: var(--accent); }
.ext-icon { font-size: 22px; }
.ext-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.ext-text small { font-size: 12px; }
.ext-arrow { color: var(--text-faint); font-size: 20px; }
.hint { font-size: 12px; margin-top: 12px; line-height: 1.6; }
.hint code { background: var(--panel-2); padding: 1px 5px; border-radius: 5px; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
