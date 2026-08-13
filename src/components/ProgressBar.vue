<script setup lang="ts">
// 通用「传输方块」：文件名 + 尺寸 + 状态文案 + 百分比 + 进度条 + 可选速度/错误 + 操作插槽。
// 纯展示，所有进度/状态/速度计算在各自组件内完成（遵循 Vue 仅框架层铁律）。
// 不传 name 时退化为纯进度条（兼容 SendPanel 顶部整体进度条），右侧带百分比。
import { computed } from 'vue';
import { formatBytes } from '@/composables/format';

const props = withDefaults(defineProps<{
  name?: string;          // 不传 → 仅渲染纯进度条
  size?: number;          // 字节；传了才显示尺寸
  statusText?: string;    // 状态文案（待发送 / 已发送 / 发送完成 / phase…）
  value: number;          // 0–100
  done?: boolean;
  speed?: number;         // MB/s，传了才显示（位于百分比左侧）
  error?: string;
  active?: boolean;       // 进行中高亮（边框 + 辉光）
  accentLeft?: boolean;   // 左侧强调色边框（接收行用）
  showPercent?: boolean;
}>(), {
  value: 0,
  showPercent: true,
});

const pct = computed(() => Math.max(0, Math.min(100, props.value)));
const sizeText = computed(() => (props.size != null ? formatBytes(props.size) : ''));
const isBlock = computed(() => !!props.name);
</script>

<template>
  <!-- 纯进度条模式（无 name）：兼容 SendPanel 顶部整体条，右侧带百分比 -->
  <div v-if="!isBlock" class="bar-wrap">
    <div
      class="bar"
      :class="{ done }"
      role="progressbar"
      :aria-valuenow="Math.round(pct)"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div class="fill" :style="{ width: pct + '%' }"></div>
    </div>
    <span v-if="showPercent" class="pct-bar">{{ Math.round(pct) }}%</span>
  </div>

  <!-- 完整方块模式 -->
  <div
    v-else
    class="row"
    :class="{ done, error: !!error, active, 'accent-left': accentLeft }"
  >
    <slot name="leading" />
    <div class="info">
      <div class="name" :title="name">{{ name }}</div>
      <div class="sub muted">
        <span class="sub-l">
          <template v-if="sizeText">{{ sizeText }}</template><template v-if="statusText"> · {{ statusText }}</template><template v-if="error"> · <span class="err">{{ error }}</span></template>
        </span>
        <!-- 速度位于百分比左侧，整组略向内收（不贴右缘） -->
        <span class="sub-r">
          <span v-if="speed != null" class="speed">{{ speed.toFixed(1) }} MB/s</span>
          <span v-if="showPercent" class="pct">{{ Math.round(pct) }}%</span>
        </span>
      </div>
      <div
        class="bar"
        :class="{ done }"
        role="progressbar"
        :aria-valuenow="Math.round(pct)"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="fill" :style="{ width: pct + '%' }"></div>
      </div>
    </div>
    <slot name="actions" />
  </div>
</template>

<style scoped>
.bar-wrap { display: flex; align-items: center; gap: 10px; }
.bar {
  flex: 1; height: 8px;
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
.pct-bar {
  flex: none; min-width: 42px; text-align: right;
  font-size: 13px; color: var(--accent-2); font-variant-numeric: tabular-nums;
}
.row {
  display: flex; align-items: center; gap: 12px;
  background: var(--panel); border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-sm); padding: 10px 12px;
}
.row.done { border-color: rgba(75, 227, 160, 0.35); }
.row.error { border-color: rgba(255, 107, 129, 0.4); }
.row.active {
  border-color: var(--accent-2);
  box-shadow: 0 0 0 1px rgba(56, 225, 200, 0.25);
}
.row.accent-left { border-left: 3px solid var(--accent-2); }
.info { flex: 1; min-width: 0; }
.name { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: 12px; margin: 3px 0 6px; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.sub-l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-r { display: flex; align-items: baseline; gap: 8px; flex: none; margin-right: 2px; }
.err { color: var(--danger); }
.pct { font-size: 13px; color: var(--accent-2); font-variant-numeric: tabular-nums; }
.speed { font-size: 12px; color: var(--accent-2); font-variant-numeric: tabular-nums; }
</style>
