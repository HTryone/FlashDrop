<script setup lang="ts">
import { ref } from 'vue';
import type { ReceivedFile } from '@/types/transfer';
import { decryptBlob } from '@/crypto/tus-crypto';
import { resolveTusBase } from '@/transfer/room';

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

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

interface PartInfo { key: string; offset: number; size: number }
interface DownloadManifest { parts: PartInfo[]; total: number; filename: string }

// 每次最多取 16MiB：上传已改为浏览器直传 R2，大对象流损坏根因已消除；16MiB 减少请求数/RTT。
// 若弱网 16MiB 在 FETCH_TIMEOUT 内下不完，单次 Range 会被 CF 截断，fetchRange 允许收下已传部分并推进。
const SUB_CHUNK = 16 * 1024 * 1024;
const CONCURRENCY = 6;
// 单路取数超时：不稳定网络下连接可能“挂死不报错”，必须主动掐断后重试，否则整链卡死。
// 取 55s：低于 CF 边缘 ~60s GET 硬超时，给“活着但慢”的连接留出自然完成/被截断的余量，避免误杀。
const FETCH_TIMEOUT = 55_000;

async function fetchRange(url: string, start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  if (signal) {
    signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: ctrl.signal });
    if (resp.status !== 206 && resp.status !== 200) throw new Error('分片下载失败 ' + resp.status);
    return await resp.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

// 单个分片：按 ≤16MB 子范围多次取；超时 / 截断自动重试；允许部分返回并推进（弱网不断档）
async function downloadPart(
  url: string,
  size: number,
  stats: { received: number },
  signal?: AbortSignal,
): Promise<ArrayBuffer[]> {
  const chunks: ArrayBuffer[] = [];
  let pos = 0;
  while (pos < size) {
    if (signal?.aborted) throw new Error('下载已取消');
    const end = Math.min(pos + SUB_CHUNK, size) - 1;
    const want = end - pos + 1;
    let buf: ArrayBuffer | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (signal?.aborted) throw new Error('下载已取消');
      try {
        const b = await fetchRange(url, pos, end, signal);
        if (b.byteLength > 0) { buf = b; break; }
      } catch {
        /* 超时 / 网络错误：继续重试 */
      }
      buf = null;
      if (attempt < 5) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    if (!buf) throw new Error('网络不稳定，下载中断，请重试');
    chunks.push(buf);
    stats.received += buf.byteLength;
    pos += buf.byteLength; // 部分返回也能推进，弱网不卡死
  }
  return chunks;
}

// 并发拉取所有分片；共享 AbortController，任一路失败或外层取消时立即终止所有后台请求
async function downloadAll(
  base: string,
  manifest: DownloadManifest,
  stats: { received: number },
  abortCtrl: AbortController,
): Promise<Blob> {
  const results: (ArrayBuffer[] | null)[] = new Array(manifest.parts.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < manifest.parts.length) {
      if (abortCtrl.signal.aborted) throw new Error('下载已取消');
      const i = next++;
      const part = manifest.parts[i];
      const url = `${base}/download/${props.code}/${props.file.id}/part/${encodeURIComponent(part.key)}`;
      results[i] = await downloadPart(url, part.size, stats, abortCtrl.signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, manifest.parts.length) }, worker));
  const sorted = manifest.parts
    .map((p, i) => ({ p, data: results[i]! }))
    .sort((a, b) => a.p.offset - b.p.offset);
  return new Blob(sorted.flatMap((s) => s.data));
}

async function onDownload() {
  err.value = '';
  done.value = false;
  busy.value = true;
  progress.value = 0;
  speed.value = 0;
  phase.value = '准备中…';
  const stats = { received: 0, total: 0 };
  const t0 = performance.now();
  const abortCtrl = new AbortController();
  activeAbort = abortCtrl; // 暴露给取消按钮
  // 进度 / 速度轮询：拉取阶段每 200ms 刷新一次 UI（解密瞬间完成，无需单独计速）
  const timer = setInterval(() => {
    const sec = (performance.now() - t0) / 1000;
    progress.value = stats.total ? Math.min(1, stats.received / stats.total) : 0;
    speed.value = sec > 0 ? stats.received / 1048576 / sec : 0;
  }, 200);
  try {
    const base = resolveTusBase();
    const manifestUrl = `${base}/download/${props.code}/${props.file.id}`;
    const mResp = await fetch(manifestUrl);
    if (!mResp.ok) throw new Error('获取下载信息失败 ' + mResp.status);
    const manifest: DownloadManifest = await mResp.json();
    stats.total = manifest.total;
    phase.value = '拉取加密数据中…';
    const cipher = await downloadAll(base, manifest, stats, abortCtrl);
    phase.value = '本地解密中…';
    const plain = props.e2eeKey ? await decryptBlob(cipher, props.e2eeKey) : cipher;
    phase.value = '已保存到本机';
    progress.value = 1;
    done.value = true;
    triggerDownload(plain, props.file.name);
  } catch (e: any) {
    const wasCancelled = abortCtrl.signal.aborted; // 用户主动取消时，catch 触发前信号已置位
    abortCtrl.abort(); // 出错/取消时立即终止所有后台 fetch，避免继续拉取浪费流量
    err.value = wasCancelled ? '已取消下载' : (e?.message || '下载失败');
  } finally {
    clearInterval(timer);
    busy.value = false;
    activeAbort = null;
  }
}

function cancelDownload() {
  activeAbort?.abort(); // 复用同一 abort 路径，立即中断所有后台 fetch（用户手动取消）
}

function fmt(n: number) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
</script>

<template>
  <div class="row" :class="{ active: busy }">
    <div class="tag">接收</div>
    <div class="info">
      <div class="name" :title="file.name">{{ file.name }}</div>
      <div class="sub muted">
        {{ fmt(file.size) }}
        <span v-if="busy" class="prog-text"> · {{ phase }} {{ (progress * 100).toFixed(0) }}% · {{ speed.toFixed(1) }} MB/s</span>
        <span v-if="err" class="err"> · {{ err }}</span>
      </div>
      <div v-if="busy" class="bar">
        <div class="fill" :style="{ width: (progress * 100) + '%' }"></div>
      </div>
    </div>
    <template v-if="encrypted && !e2eeKey">
      <span class="lock-hint muted">🔒 输入口令后下载</span>
    </template>
      <span v-else-if="done" class="done-hint">✓ 已保存到本机</span>
      <button v-else-if="!busy" class="btn sm primary" @click="onDownload">
        {{ e2eeKey ? '解密下载' : '下载' }}
      </button>
      <button v-else class="btn sm cancel" @click="cancelDownload">取消</button>
  </div>
</template>

<style scoped>
.row {
  display: flex; align-items: center; gap: 12px;
  background: var(--panel-2); border: 1px solid var(--border);
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
.sub { font-size: 12px; margin-top: 3px; }
.prog-text { color: var(--accent-2); }
.err { color: var(--danger); }
.lock-hint { font-size: 12px; white-space: nowrap; }
.done-hint { font-size: 12px; white-space: nowrap; color: var(--accent-2); }
.bar { height: 8px; background: var(--bg-soft); border-radius: 999px; overflow: hidden; margin-top: 8px; }
.fill { height: 100%; background: var(--accent-grad); transition: width 0.2s; }
.btn.cancel {
  color: var(--danger);
  border-color: var(--danger);
  background: transparent;
}
</style>
