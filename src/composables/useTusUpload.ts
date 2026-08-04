// 中转上传：加密后浏览器直传 R2（presigned PUT），Worker 仅做控制面（创建文件 / 索引 / commit）。
// 大体积密文流绕过 Worker 的 request.body pipe，避免 CF 边缘对大请求体流式透传的字节损坏
// （HMAC 校验失败根因：tus PATCH 把 80MiB 流穿过 CF 边缘→Worker→FixedLengthStream→R2，损坏且静默入库）。
// 直传 R2 后数据不经 Worker 字节处理，R2 原生按 content-length 接收，损坏消失；块大小策略：默认 80MB，55s 看门狗触发则后续降 40MB，失败/连续看门狗锁定最小成功块；看门狗不中断当前块，commit 异步流水线。

import { encryptFile, deriveKey } from '@/crypto/tus-crypto';
import { resolveTusBase } from '@/transfer/room';
import { encodeMetadata } from '@/transfer/tus/tus-protocol';
import type { QueuedFile } from '@/types/transfer';

interface Prefetched { off: number; len: number; url: string }

export interface UploadOptions {
  transferId: string;
  e2ee: { enabled: boolean; passphrase: string };
  _e2eeSalt?: string;
  onProgress: (uploaded: number, size: number) => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

/** 默认块大小：快链直接用 80MB（用户指定不再更大）。 */
const BLOCK = 80 * 1024 * 1024;
/** 看门狗（秒）：单块到时仍未传完 → 后续块降为 FALLBACK；不中断当前块（让其自然完成或撞 60s 边缘）。 */
const WATCHDOG = 55;
/** 降档块大小：触发看门狗或失败时，后续块用 40MB。 */
const FALLBACK = 40 * 1024 * 1024;
/** 极端弱网兜底块大小：连续失败后锁定的最小块。 */
const MIN_SEG = 4 * 1024 * 1024;
/** 单区间重试次数（每次失败自动降档，不会同尺寸反复重试）。 */
const RETRIES = 5;

/** 步骤1：POST /files 创建文件记录，返回 fileId。 */
async function createUpload(tusBase: string, meta: Record<string, string>): Promise<string> {
  const res = await fetch(`${tusBase}/files`, {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': meta.size,
      'Upload-Metadata': encodeMetadata(meta),
    },
  });
  if (!res.ok) throw new Error(`创建上传失败 ${res.status}`);
  const loc = res.headers.get('Location') || '';
  const m = /\/files\/([^/]+)$/.exec(loc);
  if (!m) throw new Error('创建上传响应缺少 Location');
  return m[1];
}

/** 步骤2：向 Worker 申请该块的 R2 presigned PUT URL。 */
async function presign(
  tusBase: string,
  fileId: string,
  offset: number,
  length: number,
): Promise<string> {
  const res = await fetch(`${tusBase}/api/presign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, offset, length }),
  });
  if (!res.ok) throw new Error(`presign 失败 ${res.status}`);
  const j = (await res.json()) as { url: string };
  return j.url;
}

/** 步骤3：块 PUT 成功后通知 Worker 提交 offset（二次保险：Worker 会 head 确认 part 已落盘）。 */
async function commit(
  tusBase: string,
  fileId: string,
  offset: number,
  length: number,
): Promise<void> {
  const res = await fetch(`${tusBase}/api/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, offset, length }),
  });
  if (!res.ok) throw new Error(`commit 失败 ${res.status}`);
}

/** 单块 PUT（XHR）：带上传进度；成功返回 'done'，真实网络错误返回 'neterr'。
 * 看门狗（WATCHDOG 秒）到时调用 onWatchdog()：仅作降档信号，【不 abort、不切小】当前块，
 * 让当前 PUT 自然完成（可能略超 55s，只要不撞 R2 边缘 60s 即可；若真超 60s 边缘会失败，上层按失败降档重传）。
 * 只有真正的网络错误（onerror / 非 2xx）才返回 'neterr' 允许上层降档重试。 */
function uploadSliceXHR(
  url: string,
  blob: Blob,
  onProgress: (sent: number) => void,
  onWatchdog?: () => void,
): Promise<'done' | 'neterr'> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let sent = 0;
    let settled = false;
    let watchdogCalled = false;
    const finish = (r: 'done' | 'neterr') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // 看门狗：仅通知上层降档，不中断当前传输
    const timer = setTimeout(() => {
      if (watchdogCalled) return;
      watchdogCalled = true;
      console.warn(`[upload] 单块已超 ${WATCHDOG}s 看门狗，后续块降为 ${FALLBACK / 1048576}MB`);
      onWatchdog?.();
    }, WATCHDOG * 1000);
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Content-Length', String(blob.size));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        sent = e.loaded;
        onProgress(sent);
      }
    };
    xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? 'done' : 'neterr');
    xhr.onerror = () => finish('neterr');
    xhr.onabort = () => finish('neterr');
    xhr.send(blob);
  });
}

/** 上传单个文件（E2EE 开启时先加密为密文 Blob 再直传 R2）。 */
export async function uploadOne(qf: QueuedFile, opts: UploadOptions): Promise<void> {
  try {
    const tusBase = resolveTusBase();
    const key = await deriveKey(opts.e2ee.passphrase, opts._e2eeSalt!);
    const cipher = await encryptFile(qf.file, key, (r) => {
      // 加密阶段进度并入上传进度（E2EE 时估前半 50%）
      if (opts.e2ee.enabled) {
        opts.onProgress(Math.floor(qf.file.size * r * 0.5), qf.file.size);
      }
    });
    const size = cipher.size;

    const meta: Record<string, string> = {
      filename: qf.file.name,
      relativePath: qf.relativePath || qf.file.name,
      transferId: opts.transferId,
      size: String(size),
    };
    if (opts.e2ee.enabled) meta.e2ee = '1';

    const fileId = await createUpload(tusBase, meta);

    // 块大小策略（用户指定，2026-08-04）：
    // 默认 80MB；看门狗 55s 到时未传完 → 后续块降 40MB；失败或连续 2 次看门狗 → 锁定最小成功块。
    // 看门狗不中断当前块（让其自然完成或撞 60s 边缘）；commit 异步 + 下一块预签名流水线，消串行空挡；不靠测速。
    let off = 0;
    let downshift = false;        // 是否启用降档块（40MB）
    let locked = 0;               // >0 表示已锁定稳态块大小
    let consecutiveBad = 0;       // 连续看门狗/失败计数
    let minSuccessSeg = BLOCK;    // 历史最小成功块（锁定依据）
    let committed = 0;            // 已落库字节（commit 成功）
    let inflight = 0;             // 当前块已上行字节（仅 UI 进度反馈）
    const pf: { cur: Prefetched | null } = { cur: null };
    const commitJobs: Promise<void>[] = [];
    const commitRetries: Array<() => Promise<void>> = [];

    const pickSeg = (): number => (locked > 0 ? locked : downshift ? FALLBACK : BLOCK);

    const report = () => {
      const up = committed + inflight;
      const frac = opts.e2ee.enabled ? 0.5 + 0.5 * (up / size) : up / size;
      opts.onProgress(Math.floor(qf.file.size * frac), qf.file.size);
    };

    while (off < size) {
      const seg = pickSeg();
      const end = Math.min(off + seg, size);
      const blobLen = end - off;

      // 流水线：优先用预取的 presign（尺寸/偏移匹配），否则现签
      let url: string;
      if (pf.cur && pf.cur.off === off && pf.cur.len === blobLen) {
        url = pf.cur.url;
        pf.cur = null;
      } else {
        url = await presign(tusBase, fileId, off, blobLen);
      }

      const blob = cipher.slice(off, end);
      inflight = 0;
      let watchdogFired = false;

      // 流水线：当前块上传同时，预取下一块 presign（按当前假设尺寸，降档时作废）
      let prefetchP: Promise<void> = Promise.resolve();
      if (end < size) {
        const nSeg = pickSeg();
        const nEnd = Math.min(end + nSeg, size);
        prefetchP = presign(tusBase, fileId, end, nEnd - end)
          .then((u) => { pf.cur = { off: end, len: nEnd - end, url: u }; })
          .catch(() => { pf.cur = null; });
      }

      const r = await uploadSliceXHR(
        url, blob,
        (sent) => { inflight = sent; report(); },
        () => { watchdogFired = true; },
      );
      await prefetchP;

      if (r === 'done') {
        const job = () => commit(tusBase, fileId, off + blob.size, blob.size);
        commitJobs.push(job().catch(() => {}));
        commitRetries.push(job);
        committed += blob.size;
        inflight = 0;
        off = end;
        report();
        minSuccessSeg = Math.min(minSuccessSeg, blob.size);
        if (watchdogFired) {
          consecutiveBad++;
          downshift = true;
          // 连续 2 次看门狗 → 锁定最小成功块（仅 80MB 成功则锁 40MB 兜底，避免贴 60s 悬崖）
          if (consecutiveBad >= 2) { locked = minSuccessSeg === BLOCK ? FALLBACK : Math.max(minSuccessSeg, MIN_SEG); downshift = false; }
          pf.cur = null; // 降档，预取尺寸作废
        } else {
          consecutiveBad = 0;
        }
      } else {
        // 失败（含撞 60s 边缘）：降档，作废预取，同区间用更小块重传（不反复同尺寸）
        pf.cur = null;
        consecutiveBad++;
        downshift = true;
        if (consecutiveBad >= 2) { locked = Math.max(minSuccessSeg === BLOCK ? MIN_SEG : minSuccessSeg, MIN_SEG); downshift = false; }
        let curSeg = pickSeg();
        let ok = false;
        let lastErr = '网络错误，正在降档重试';
        for (let a = 0; a < RETRIES && !ok; a++) {
          const cEnd = Math.min(off + curSeg, size);
          const cb = cipher.slice(off, cEnd);
          const curl = await presign(tusBase, fileId, off, cb.size);
          const cr = await uploadSliceXHR(curl, cb, (s) => { inflight = s; report(); });
          if (cr === 'done') {
            const job = () => commit(tusBase, fileId, off + cb.size, cb.size);
            commitJobs.push(job().catch(() => {}));
            commitRetries.push(job);
            committed += cb.size;
            inflight = 0;
            off = cEnd;
            report();
            minSuccessSeg = Math.min(minSuccessSeg, cb.size);
            consecutiveBad = 0;
            ok = true;
          } else {
            curSeg = pickSeg();
          }
        }
        if (!ok) throw new Error(lastErr);
      }
    }

    // 收尾：确保所有 commit 完成（失败的异步 commit 重试 3 次）
    const settled = await Promise.allSettled(commitJobs);
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'rejected') {
        for (let k = 0; k < 3; k++) {
          try { await commitRetries[i](); break; } catch { /* 继续重试 */ }
        }
      }
    }

    opts.onSuccess();
  } catch (e: any) {
    opts.onError(e?.message || String(e));
    throw e;
  }
}

/** 并发控制：一次最多 n 个文件在传。 */
export async function uploadAll(
  files: QueuedFile[],
  opts: Omit<UploadOptions, 'onProgress' | 'onSuccess' | 'onError'> & {
    e2eeSalt?: string;
    concurrency?: number;
    onItemProgress?: (qf: QueuedFile, uploaded: number, size: number) => void;
    onItemSuccess?: (qf: QueuedFile) => void;
    onItemError?: (qf: QueuedFile, msg: string) => void;
  },
): Promise<void> {
  const concurrency = opts.concurrency || 3;
  let idx = 0;
  async function worker() {
    while (idx < files.length) {
      const i = idx++;
      const qf = files[i];
      if (qf.status === 'done') continue;
      qf.status = 'uploading';
      try {
        await uploadOne(qf, {
          transferId: opts.transferId,
          e2ee: opts.e2ee,
          _e2eeSalt: opts.e2eeSalt,
          onProgress: (u, s) => opts.onItemProgress?.(qf, u, s),
          onSuccess: () => opts.onItemSuccess?.(qf),
          onError: (m) => opts.onItemError?.(qf, m),
        });
        qf.status = 'done';
        opts.onItemSuccess?.(qf);
      } catch (e: any) {
        qf.status = 'error';
        qf.error = e?.message || String(e);
        opts.onItemError?.(qf, qf.error || '未知错误');
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);
}
