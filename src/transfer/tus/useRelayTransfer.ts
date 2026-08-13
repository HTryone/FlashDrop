// 中转（TUS）发送状态机：与 useTusUpload.ts（纯上传引擎，不碰 Vue）分离，
// 本文件只管 Vue 层的状态机 / 分享码 / 登录码 / 口令 / E2EE salt 复用 / 留言同步 / 卸载清理。
// 放 src/transfer/tus/，与 useTusUpload.ts 同域（目录纪律：按传输方式分域，不新建兜底夹）。
import { ref, computed, watch, onUnmounted, type Ref } from 'vue';
import type { QueuedFile, StorageType } from '@/types/transfer';
import {
  createTransfer, refreshCode, setMessage, terminateTransfer, clearTransfer, clearTransferFiles, zipUrl,
} from '@/api/transfer';
import { uploadAll } from '@/transfer/tus/useTusUpload';
import { newSalt, E2EE_CHUNK_SIZE, randomPassphrase } from '@/crypto/tus-crypto';

const TTL_HOURS = 24;

// 兼容非安全上下文（http://192.168.x.x 不暴露 crypto.randomUUID）
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (+c ^ (crypto?.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16),
  );
}

export function useRelayTransfer(
  files: Ref<QueuedFile[]>,
  onLoginCode?: (code: string) => void,
) {
  // E2EE 始终开启，口令系统内置（用户不可改）
  const passphrase = ref(randomPassphrase());
  const transferId = ref('');
  const code = ref('');
  const loginCode = ref('');       // 16 位登录码（带空格展示）
  const storage = ref<StorageType>('local');
  const started = ref(false);
  const error = ref('');
  // 五态机：idle / uploading / cancelled / failed / done（无暂停态）
  const relayPhase = ref<'idle' | 'uploading' | 'cancelled' | 'failed' | 'done'>('idle');
  const uploading = computed(() => relayPhase.value === 'uploading');
  // 传输中锁定文件区：X / 拖入 / 选择 / 清空 全禁用
  const filesLocked = computed(() => relayPhase.value === 'uploading');
  const message = ref('');
  // 取消分享弹窗
  const showTerminateDialog = ref(false);

  let relayAbort: AbortController | null = null;
  let e2eeSaltRef = '';          // 跨重传复用 salt，避免重传后接收端解密失败
  let fatalTriggered = false;    // 网络兜底失败标志（区分 cancelled 与 failed）

  // history 模式下 query 写在 # 之前即为正常 URL，vue-router 直接读到
  const shareLink = computed(() => (code.value ? `${location.origin}/?code=${code.value}` : ''));

  // 选中区状态（发送方总状态三态）：待发送 / 已发送 / 发送完成（外加 取消/故障 分支）
  const selStatus = computed(() => {
    if (!files.value.length) return '';
    if (relayPhase.value === 'uploading') return '已发送';
    if (relayPhase.value === 'cancelled') return '已取消，可继续上传';
    if (relayPhase.value === 'failed') return '网络故障，可重新传输';
    if (relayPhase.value === 'done') return '发送完成';
    if (files.value.every((f) => f.status === 'done')) return '发送完成';
    return '待发送';
  });
  const selStatusClass = computed(() => {
    if (relayPhase.value === 'done') return 'done';
    if (relayPhase.value === 'uploading') return 'busy';
    if (relayPhase.value === 'failed') return 'busy';
    return 'idle';
  });

  /** 刷新加密口令（随机生成新口令） */
  function refreshPassphrase() {
    passphrase.value = randomPassphrase();
  }

  // 创建传输（仅首次）：分配分享码/登录码/E2EE salt，并缓存 salt 供重传复用
  async function ensureTransfer() {
    if (!transferId.value) transferId.value = generateUUID();
    if (!e2eeSaltRef) e2eeSaltRef = newSalt();
    const e2eeMeta = { salt: e2eeSaltRef, chunkSize: E2EE_CHUNK_SIZE };
    const resp = await createTransfer(transferId.value, message.value, e2eeMeta, TTL_HOURS);
    code.value = resp.code;
    loginCode.value = resp.loginCode;   // 16 位登录码
    storage.value = resp.storage;
    started.value = true;
    onLoginCode?.(resp.loginCode.replace(/\s/g, ''));
  }

  // 网络兜底失败回调：标记 failed 并全局中断
  function handleFatal() {
    fatalTriggered = true;
    relayPhase.value = 'failed';
    relayAbort?.abort();
  }

  // 开始 / 继续上传：复用 transferId 与 e2eeSaltRef；未完成文件带 fileId 从 0 覆盖重传
  async function startTransfer() {
    error.value = '';
    if (!files.value.length) { error.value = '请先选择要发送的文件'; return; }
    relayPhase.value = 'uploading';
    fatalTriggered = false;
    relayAbort = new AbortController();
    try {
      if (!transferId.value) await ensureTransfer();
      else {
        // 重传（复用同一 transferId）：先清掉上次（可能已取消/失效）的文件行 + R2 分片，
        // 避免接收端把失效旧文件与新文件一并列出（用户反馈的"取消后还能看到旧文件"根因）。
        try { await clearTransferFiles(transferId.value); } catch { /* 忽略：旧文件清理失败不阻断重传 */ }
      }
      await uploadAll(files.value, {
        transferId: transferId.value,
        e2ee: { enabled: true, passphrase: passphrase.value }, // E2EE 始终开启
        e2eeSalt: e2eeSaltRef,
        concurrency: 3,
        signal: relayAbort.signal,
        onFatal: handleFatal,
        onItemProgress: (qf, u) => { qf.uploaded = u; },
        onItemSuccess: () => {},
        onItemError: (qf, m) => { error.value = `「${qf.relativePath}」失败：${m}`; },
      });
    } finally {
      if (fatalTriggered) relayPhase.value = 'failed';
      else if (files.value.length && files.value.every((f) => f.status === 'done')) relayPhase.value = 'done';
      else relayPhase.value = 'cancelled';
    }
  }

  // 取消（作废本次）：中断所有 worker，文件保留可重选，按钮变「继续上传」
  function cancelUpload() {
    relayAbort?.abort();
    relayPhase.value = 'cancelled';
  }

  // 取消/失败后继续：边界兜底——文件被清空则提示先选文件
  function resumeUpload() {
    if (!files.value.length) { error.value = '请先选择要发送的文件'; return; }
    void startTransfer();
  }

  // 开始新的传输：清服务器旧文件 + 本地全重置回初始态
  async function startNewTransfer() {
    if (transferId.value) {
      try { await clearTransfer(transferId.value); } catch { /* 忽略 */ }
    }
    files.value = [];
    transferId.value = '';
    code.value = '';
    loginCode.value = '';
    storage.value = 'local';
    started.value = false;
    error.value = '';
    relayPhase.value = 'idle';
    e2eeSaltRef = '';
    passphrase.value = randomPassphrase();
  }

  async function onRefresh() {
    if (!transferId.value) return;
    const r = await refreshCode(transferId.value);
    code.value = r.code;
  }

  /** 确认终止传输 */
  async function confirmTerminate() {
    if (!transferId.value) return;
    try {
      await terminateTransfer(transferId.value);
      showTerminateDialog.value = false;
      // 清理本地状态，刷新页面
      alert('传输已终止，分享码和登录码均已失效。页面即将刷新。');
      location.reload();
    } catch (e: any) {
      error.value = e?.message || '终止失败';
    }
  }

  /** 一键复制：分享链接 + 解密口令（类似百度网盘分享格式） */
  function copyShareAll() {
    if (!shareLink.value || !passphrase.value) return;
    const text = `分享链接：${shareLink.value}\n解密口令：${passphrase.value}`;
    navigator.clipboard?.writeText(text);
  }

  function copyLoginCode() {
    if (!loginCode.value) return;
    navigator.clipboard?.writeText(loginCode.value.replace(/\s/g, ''));
  }

  // 留言实时同步到服务端
  watch(message, async (v) => {
    if (!transferId.value) return;
    try {
      await setMessage(transferId.value, v);
    } catch {
      /* 忽略 */
    }
  });

  // 组件卸载时中止进行中的中转上传
  onUnmounted(() => { relayAbort?.abort(); });

  return {
    passphrase, transferId, code, loginCode, storage, started, error,
    relayPhase, uploading, filesLocked, message, showTerminateDialog,
    shareLink, selStatus, selStatusClass, zipUrl,
    refreshPassphrase, ensureTransfer, startTransfer, cancelUpload, resumeUpload,
    startNewTransfer, onRefresh, confirmTerminate, copyShareAll, copyLoginCode,
  };
}
