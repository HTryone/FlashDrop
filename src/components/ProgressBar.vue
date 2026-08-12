<script setup lang="ts">
// 纯展示进度条：value 取值 0–100（内部 clamp），done 控制完成态绿色。
// 不含任何业务逻辑，进度/速度计算在各自组件内完成。
const props = defineProps<{ value: number; done?: boolean }>();
const pct = () => Math.max(0, Math.min(100, props.value));
</script>

<template>
  <div
    class="bar"
    :class="{ done }"
    role="progressbar"
    :aria-valuenow="Math.round(pct())"
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <div class="fill" :style="{ width: pct() + '%' }"></div>
  </div>
</template>

<style scoped>
.bar {
  height: 8px;
  background: var(--bg-soft);
  border-radius: 999px;
  overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28);
}
.fill {
  height: 100%;
  background: var(--accent-grad);
  border-radius: 999px;
  transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
.bar.done .fill {
  background: var(--ok);
  box-shadow: 0 0 8px rgba(75, 227, 160, 0.45);
}
</style>
