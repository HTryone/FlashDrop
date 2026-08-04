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

// 流式读取单个 Range：每段到达即回调 onChunk 刷新进度（治 UI 滞后）；
// 看门狗 abort / 网络中断时已收字节通过 partialBuf 抛给调用方，从断点续传（治流量浪费）。
async function fetchRange(
  url: string,
  start: number,
  end: number,
  onChunk: (delta: number) => void,
  signal?: AbortSignal,
): Promise<{ buf: ArrayBuffer; received: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  const chunks: Uint8Array[] = [];
  let received = 0;
  const assemble = () => {
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out.buffer;
  };
  try {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: ctrl.signal });
    if (resp.status !== 206 && resp.status !== 200) throw new Error('分片下载失败 ' + resp.status);
    const reader = resp.body!.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(new Uint8Array(value)); // 拷贝，避免流复用底层 buffer 导致数据损坏
      received += value.byteLength;
      onChunk(value.byteLength);
    }
    return { buf: assemble(), received };
  } catch (e) {
    if (received > 0) {
      // 看门狗 abort / 网络中断：已收字节保留，抛给调用方从断点续传
      const err = new Error('partial') as Error & { partialBytes: number; partialBuf: ArrayBuffer };
      err.partialBytes = received;
      err.partialBuf = assemble();
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 单个分片：按 ≤16MB 子范围多次取；看门狗 abort 后保留已收字节、从断点续传（零流量浪费）
async function downloadPart(
  url: string,
  size: number,
  onChunk: (delta: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer[]> {
  const chunks: ArrayBuffer[] = [];
  let pos = 0;
  while (pos < size) {
    if (signal?.aborted) throw new Error('下载已取消');
    const startPos = pos;
    const end = Math.min(pos + SUB_CHUNK, size) - 1;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (signal?.aborted) throw new Error('下载已取消');
      try {
        const { buf, received } = await fetchRange(url, pos, end, onChunk, signal);
        chunks.push(buf);
        pos += received;
        break;
      } catch (e: any) {
        if (signal?.aborted) throw new Error('下载已取消');
        if (e?.partialBuf) {
          // 看门狗 abort 前已收一部分：保存已收字节，外层 while 从断点继续
          chunks.push(e.partialBuf);
          pos += e.partialBytes;
          break;
        }
        if (attempt < 5) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    if (pos <= startPos) throw new Error('网络不稳定，下载中断，请重试');
  }
  return chunks;
}

// 并发拉取所有分片；共享 AbortController，任一路失败或外层取消时立即终止所有后台请求
async function downloadAll(
  base: string,
  manifest: DownloadManifest,
  onChunk: (delta: number) => void,
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
      results[i] = await downloadPart(url, part.size, onChunk, abortCtrl.signal);
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
    const cipher = await downloadAll(base, manifest, onChunk, abortCtrl);
    phase.value = '本地解密中…';
    const plain = props.e2eeKey
      ? await decryptBlob(cipher, props.e2eeKey, (r) => { phase.value = `本地解密中… ${(r * 100).toFixed(0)}%`; })
      : cipher;
    phase.value = '已保存到本机';
    progress.value = 1;
    done.value = true;
    triggerDownload(plain, props.file.name);
  } catch (e: any) {
    const wasCancelled = abortCtrl.signal.aborted; // 用户主动取消时，catch 触发前信号已置位
    abortCtrl.abort(); // 出错/取消时立即终止所有后台 fetch，避免继续拉取浪费流量
    err.value = wasCancelled ? '已取消下载' : (e?.message || '下载失败');
  } finally {
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
