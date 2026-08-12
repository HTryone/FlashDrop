<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ReceivedFile } from '@/types/transfer';
import { resolveTusBase } from '@/transfer/room';
import { streamDownloadToSink, type DownloadManifest } from '@/transfer/tus/stream-download';
import ProgressBar from './ProgressBar.vue';
import { formatBytes } from '@/composables/format';

const props = defineProps<{
  file: ReceivedFile;
  code: string;
  e2eeKey: string | null;
  encrypted: boolean;
}>();

const busy = ref(false);
const done = ref(false);
const err = ref('');
const progress = ref(0); // 0~1
const speed = ref(0);    // MB/s
const phase = ref('');
let activeAbort: AbortController | null = null; // 当前下载的 AbortController，供“取消”按钮中断后台请求

// 网络类错误（超时/失败）才提示网络原因；取消、授权失败不算网络问题
const isNetworkError = computed(() => {
  const m = err.value;
  if (!m) return false;
  if (m.includes('取消') || m.includes('授权')) return false;
  return true;
});

async function onDownload() {
  err.value = '';
  done.value = false;
  busy.value = true;
  progress.value = 0;
  speed.value = 0;
  phase.value = '准备中…';
  const stats = { received: 0, total: 0 };
  const samples: { t: number; r: number }[] = []; // 5s 滑动窗口，算真实瞬时速度（替代全程平均）
  // 每段密文到达即刷新进度 / 速度，不再依赖 setInterval 轮询（治 UI 滞后 + 速度失真）
  const onChunk = (delta: number) => {
    stats.received += delta;
    progress.value = stats.total ? Math.min(1, stats.received / stats.total) : 0;
    const now = performance.now();
    samples.push({ t: now, r: stats.received });
    while (samples.length > 1 && now - samples[0].t > 5000) samples.shift();
    if (samples.length >= 2) {
      const dt = (samples[samples.length - 1].t - samples[0].t) / 1000;
      if (dt > 0) speed.value = (samples[samples.length - 1].r - samples[0].r) / 1048576 / dt;
    }
  };
  const abortCtrl = new AbortController();
  activeAbort = abortCtrl; // 暴露给取消按钮
  try {
    const base = resolveTusBase();
    const manifestUrl = `${base}/download/${props.code}/${props.file.id}`;
    const mResp = await fetch(manifestUrl);
    if (!mResp.ok) throw new Error('获取下载信息失败 ' + mResp.status);
    const manifest: DownloadManifest = await mResp.json();
    stats.total = manifest.total;
    phase.value = '拉取加密数据中…';
    // 流式落盘（边下边解密边写盘）在中转下载模块内完成，此处只驱动进度与状态
    const res = await streamDownloadToSink({ manifest, e2eeKey: props.e2eeKey, onChunk, signal: abortCtrl.signal });
    phase.value = '已保存到本机';
    progress.value = 1;
    done.value = true;
    if (res.permissionFallback) {
      // FSA 授权失败，已降级 StreamSaver/Blob 浏览器下载，文件仍会落地；给轻提示让用户知情
      err.value = '保存目录授权失败，已改用浏览器默认下载';
    }
  } catch (e: any) {
    const wasCancelled = abortCtrl.signal.aborted; // 用户主动取消时，catch 触发前信号已置位
    abortCtrl.abort(); // 出错/取消时立即终止所有后台 fetch，避免继续拉取浪费流量
    if (e?.message === 'SAVE_DIR_DENIED') {
      err.value = '保存目录授权失败，请重试';
    } else {
      err.value = wasCancelled ? '已取消下载' : (e?.message || '下载失败');
    }
  } finally {
    busy.value = false;
    activeAbort = null;
  }
}

function cancelDownload() {
  activeAbort?.abort(); // 复用同一 abort 路径，立即中断所有后台 fetch（用户手动取消）
}

</script>

<template>
  <div class="row" :class="{ active: busy }">
    <div class="tag">接收</div>
    <div class="info">
      <div class="name" :title="file.name">{{ file.name }}</div>
      <div class="sub muted">
        <span class="sub-l">{{ formatBytes(file.size) }}<span v-if="busy" class="prog-text"> · {{ phase }} {{ (progress * 100).toFixed(0) }}%</span></span>
        <span v-if="busy" class="speed">{{ speed.toFixed(1) }} MB/s</span>
      </div>
      <ProgressBar v-if="busy" :value="progress * 100" />
      <div v-if="err" class="err-line">⚠ {{ err }}<span v-if="isNetworkError" class="err-hint">（多为网络不稳定或跨境链路拥塞，请重试或更换网络）</span></div>
    </div>
    <template v-if="encrypted && !e2eeKey">
      <span class="lock-hint muted">🔒 输入口令后下载</span>
    </template>
      <span v-else-if="done" class="done-hint">✓ 已保存到本机</span>
      <button v-else-if="!busy" class="btn sm primary" @click="onDownload">
        {{ err ? '重新下载' : (e2eeKey ? '解密下载' : '下载') }}
      </button>
      <button v-else class="btn sm cancel" @click="cancelDownload">取消</button>
  </div>
</template>

<style scoped>
.row {
  display: flex; align-items: center; gap: 12px;
  background: var(--panel); border: 1px solid rgba(255, 255, 255, 0.12);
  border-left: 3px solid var(--accent-2);
  border-radius: var(--radius-sm); padding: 10px 12px;
}
.row.active {
  border-color: var(--accent-2);
  box-shadow: 0 0 0 1px rgba(56, 225, 200, 0.25);
}
.tag {
  flex: none; font-size: 11px; font-weight: 700; letter-spacing: 1px;
  color: #07101f; background: var(--accent-2); border-radius: 6px; padding: 3px 8px;
}
.info { flex: 1; min-width: 0; }
.name { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: 12px; margin-top: 3px; display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.sub-l { min-width: 0; }
.prog-text { color: var(--accent-2); }
.speed { flex: none; white-space: nowrap; color: var(--accent-2); font-variant-numeric: tabular-nums; }
.err { color: var(--danger); }
.err-line { color: var(--danger); font-size: 12px; margin-top: 6px; line-height: 1.4; }
.err-hint { opacity: 0.82; margin-left: 2px; }
.lock-hint { font-size: 12px; white-space: nowrap; }
.done-hint { font-size: 12px; white-space: nowrap; color: var(--accent-2); }
.btn.cancel {
  color: var(--danger);
  border-color: var(--danger);
  background: transparent;
}

</style>
