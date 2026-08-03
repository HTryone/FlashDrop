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
const err = ref('');

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

// 每次最多取 30MB（铁证：≤30MB 响应完整，90MB 被 CF 截断）
const SUB_CHUNK = 30 * 1024 * 1024;
const CONCURRENCY = 4;

async function fetchRange(url: string, start: number, end: number): Promise<ArrayBuffer> {
  const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (resp.status !== 206 && resp.status !== 200) throw new Error('分片下载失败 ' + resp.status);
  return await resp.arrayBuffer();
}

// 单个分片：若本身 >30MB（旧上传 90MB/片），按 ≤30MB 子范围多次取，与上传一致
async function downloadPart(url: string, size: number): Promise<ArrayBuffer[]> {
  const chunks: ArrayBuffer[] = [];
  let pos = 0;
  while (pos < size) {
    const end = Math.min(pos + SUB_CHUNK, size) - 1;
    const buf = await fetchRange(url, pos, end);
    if (buf.byteLength !== end - pos + 1) throw new Error('下载不完整，请重试');
    chunks.push(buf);
    pos = end + 1;
  }
  return chunks;
}

// 并发拉取所有分片，按 offset 拼成完整密文 Blob
async function downloadAll(base: string, manifest: DownloadManifest): Promise<Blob> {
  const results: (ArrayBuffer[] | null)[] = new Array(manifest.parts.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < manifest.parts.length) {
      const i = next++;
      const part = manifest.parts[i];
      const url = `${base}/download/${props.code}/${props.file.id}/part/${encodeURIComponent(part.key)}`;
      results[i] = await downloadPart(url, part.size);
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
  busy.value = true;
  try {
    const base = resolveTusBase();
    const manifestUrl = `${base}/download/${props.code}/${props.file.id}`;
    const mResp = await fetch(manifestUrl);
    if (!mResp.ok) throw new Error('获取下载信息失败 ' + mResp.status);
    const manifest: DownloadManifest = await mResp.json();
    const cipher = await downloadAll(base, manifest);
    if (props.e2eeKey) {
      const plain = await decryptBlob(cipher, props.e2eeKey);
      triggerDownload(plain, props.file.name);
    } else {
      triggerDownload(cipher, props.file.name);
    }
  } catch (e: any) {
    err.value = e?.message || '下载失败';
  } finally {
    busy.value = false;
  }
}

function fmt(n: number) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
</script>

<template>
  <div class="row">
    <div class="info">
      <div class="name" :title="file.name">{{ file.name }}</div>
      <div class="sub muted">{{ fmt(file.size) }}<span v-if="err" class="err"> · {{ err }}</span></div>
    </div>
    <template v-if="encrypted && !e2eeKey">
      <span class="lock-hint muted">🔒 输入口令后下载</span>
    </template>
    <button v-else class="btn sm primary" :disabled="busy" @click="onDownload">
      {{ e2eeKey ? '解密下载' : (busy ? '下载中…' : '下载') }}
    </button>
  </div>
</template>

<style scoped>
.row {
  display: flex; align-items: center; gap: 12px;
  background: var(--panel-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 10px 12px;
}
.info { flex: 1; min-width: 0; }
.name { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: 12px; margin-top: 3px; }
.err { color: var(--danger); }
.lock-hint { font-size: 12px; white-space: nowrap; }
</style>
