<script setup lang="ts">
// 底部圆形长条：主页(左) / 更多(右)。主页=收起浮层看主程序，更多=唤起诊断玻璃。
defineProps<{ open: boolean }>();
defineEmits<{ home: []; more: [] }>();
</script>

<template>
  <div class="dock">
    <button :class="{ on: !open }" @click="$emit('home')">主页</button>
    <button :class="{ on: open }" @click="$emit('more')">更多</button>
  </div>
</template>

<style scoped>
.dock {
  position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
  display: flex; background: rgba(255, 255, 255, 0.8);
  border: 0.5px solid rgba(120, 140, 160, 0.25); border-radius: 999px;
  overflow: hidden; backdrop-filter: blur(10px); box-shadow: 0 2px 10px rgba(40, 60, 90, 0.08);
}
.dock button {
  background: none; border: none; padding: 7px 20px; font-size: 12px;
  color: #5C656E; cursor: pointer; transition: transform .15s cubic-bezier(.2, .8, .3, 1);
}
.dock button.on { background: rgba(55, 138, 221, 0.18); color: #1F5E9E; font-weight: 600; }
.dock button:active { transform: scale(0.95); }
</style>
