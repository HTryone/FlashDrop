<script setup lang="ts">
import { ref } from 'vue';
import type { ReceivedFile } from '@/types/transfer';
import { fileUrl } from '@/api/transfer';
import { decryptBlob } from '@/crypto/e2ee';

const props = defineProps<{
  file: ReceivedFile;
  code: string;
  e2eeKey: string | null;
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

async function onDownload() {
  err.value = '';
  busy.value = true;
  try {
    if (props.e2eeKey) {
      const resp = await fetch(fileUrl(props.code, props.file.id));
      if (!resp.ok) throw new Error('下载失败 ' + resp.status);
      const cipher = await resp.blob();
      const plain = await decryptBlob(cipher, props.e2eeKey);
      triggerDownload(plain, props.file.name);
    } else {
      const a = document.createElement('a');
      a.href = fileUrl(props.code, props.file.id);
      a.download = props.file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
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
    <button class="btn sm primary" :disabled="busy" @click="onDownload">
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
</style>
