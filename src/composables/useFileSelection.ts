import { ref, computed } from 'vue';
import type { QueuedFile } from '@/types/transfer';

/**
 * 通用文件拖拽/选择 composable
 * 管理文件列表、拖拽状态、增删查、格式化、UUID 生成
 */
export function useFileSelection() {
  const files = ref<QueuedFile[]>([]);
  const dragOver = ref(false);

  const totalSize = computed(() => files.value.reduce((s, f) => s + f.file.size, 0));
  const doneCount = computed(() => files.value.filter((f) => f.status === 'done').length);
  const allDone = computed(() => files.value.length > 0 && doneCount.value === files.value.length);

  function addFiles(list: FileList | File[], basePath = '') {
    for (const f of Array.from(list)) {
      const rel = basePath ? `${basePath}/${f.name}` : (f as any).webkitRelativePath || f.name;
      if (files.value.some((x) => x.relativePath === rel && x.file.size === f.size)) continue;
      files.value.push({ file: f, relativePath: rel, status: 'pending', uploaded: 0 });
    }
  }

  // 递归读取拖入的目录结构
  function traverse(entry: any, path = '') {
    return new Promise<void>((resolve) => {
      if (entry.isFile) {
        entry.file((f: File) => {
          const rel = path ? `${path}/${f.name}` : f.name;
          if (!files.value.some((x) => x.relativePath === rel && x.file.size === f.size)) {
            files.value.push({ file: f, relativePath: rel, status: 'pending', uploaded: 0 });
          }
          resolve();
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => {
          reader.readEntries(async (ents: any[]) => {
            if (!ents.length) return resolve();
            for (const e of ents) await traverse(e, path ? `${path}/${entry.name}` : entry.name);
            readBatch();
          });
        };
        readBatch();
      } else resolve();
    });
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver.value = false;
    const dt = e.dataTransfer;
    if (!dt) return;
    const items = dt.items;
    if (items && items.length && typeof (items[0] as any).webkitGetAsEntry === 'function') {
      for (const it of Array.from(items)) {
        const entry = (it as any).webkitGetAsEntry();
        if (entry) await traverse(entry);
      }
    } else if (dt.files.length) {
      addFiles(dt.files);
    }
  }

  function onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) addFiles(input.files);
    input.value = '';
  }

  function removeFile(i: number) {
    files.value.splice(i, 1);
  }

  function clearSelected() {
    files.value = [];
  }

  function fmt(n: number) {
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /** 兼容非安全上下文（http://192.168.x.x 不暴露 crypto.randomUUID） */
  function generateUUID(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
      (+c ^ (crypto?.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16),
    );
  }

  return {
    files,
    dragOver,
    totalSize,
    doneCount,
    allDone,
    addFiles,
    onDrop,
    onPick,
    removeFile,
    clearSelected,
    fmt,
    generateUUID,
  };
}
