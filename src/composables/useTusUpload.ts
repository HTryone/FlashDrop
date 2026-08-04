// 中转上传：加密后浏览器直传 R2（presigned PUT），Worker 仅做控制面（创建文件 / 索引 / commit）。
// 大体积密文流绕过 Worker 的 request.body pipe，避免 CF 边缘对大请求体流式透传的字节损坏
// （HMAC 校验失败根因：tus PATCH 把 80MiB 流穿过 CF 边缘→Worker→FixedLengthStream→R2，损坏且静默入库）。
// 直传 R2 后数据不经 Worker 字节处理，R2 原生按 content-length 接收，损坏消失；网络块大小按"50s 时间预算"动态决定，绝不因超时重传。

import { encryptFile, deriveKey } from '@/crypto/tus-crypto';
import { resolveTusBase } from '@/transfer/room';
import { encodeMetadata } from '@/transfer/tus/tus-protocol';
import type { QueuedFile } from '@/types/transfer';

export interface UploadOptions {
  transferId: string;
  e2ee: { enabled: boolean; passphrase: string };
  _e2eeSalt?: string;
  onProgress: (uploaded: number, size: number) => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

/** 单块大小初始值（快链起点）。实际每块大小由"时间预算"动态决定（见上传循环）。 */
const BASE_SEG = 80 * 1024 * 1024;
/** 单条连接时间预算（秒）：到时若当前块仍在传，不中断、不重传，让其自然完成（远在 R2 60s 墙内）。用户指定"用秒记"。 */
const SLICE_SECONDS = 50;
/** 块大小上下限：上限锁 80MiB（用户指定不能再大），下限 8MiB 防极端慢链请求数爆炸。 */
const MIN_SEG = 8 * 1024 * 1024;
const MAX_SEG = 80 * 1024 * 1024;
/** 网络错误（断线 / 5xx）重试次数。注意：超时≠错误，超时只软监控、绝不重传。 */
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
 * 关键（用户要求"不重传、只看时间"）：SLICE_SECONDS 预算到时【不 abort、不切小】，仅打日志，
 * 让当前 PUT 自然完成（块可能略超 50s，但远在 R2 边缘 60s 硬超时内）。绝不因超时重传。
 * 只有真正的网络错误（onerror / 非 2xx）才允许上层重试。 */
function uploadSliceXHR(
  url: string,
  blob: Blob,
  onProgress: (sent: number) => void,
): Promise<'done' | 'neterr'> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let sent = 0;
    let settled = false;
    const finish = (r: 'done' | 'neterr') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // 软预算：仅监控，不中断、不重传
    const timer = setTimeout(() => {
      console.warn(`[upload] 单块已超 ${SLICE_SECONDS}s 预算，继续等待自然完成（不重传）`);
    }, SLICE_SECONDS * 1000);
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

    // 单发 + 用秒记（时间驱动动态块，不重传）：
    // 顺序传；每块按 SLICE_SECONDS 预算自然完成，绝不因超时 abort 重传；
    // 块大小随"本块实际耗时"动态调节（趋近 50s 预算），不看瞬时速度、不预测网络。
    // 只有真实网络错误才重试（RETRIES）。
    let off = 0;
    let seg = BASE_SEG;
    let committed = 0; // 已落库字节（commit 成功）
    let inflight = 0; // 当前块已上行字节（仅 UI 进度反馈）

    const report = () => {
      const up = committed + inflight;
      const frac = opts.e2ee.enabled ? 0.5 + 0.5 * (up / size) : up / size;
      opts.onProgress(Math.floor(qf.file.size * frac), qf.file.size);
    };

    while (off < size) {
      const end = Math.min(off + seg, size);
      const blob = cipher.slice(off, end);
      let done = false;
      let lastErr: string | undefined;
      for (let attempt = 0; attempt < RETRIES && !done; attempt++) {
        const url = await presign(tusBase, fileId, off, blob.size);
        inflight = 0;
        const t0 = Date.now();
        const r = await uploadSliceXHR(url, blob, (sent) => {
          inflight = sent;
          report();
        });
        if (r === 'done') {
          await commit(tusBase, fileId, off + blob.size, blob.size);
          const dt = (Date.now() - t0) / 1000;
          committed += blob.size;
          inflight = 0;
          off = end;
          report();
          done = true;
          // 时间驱动动态块：用本块实际耗时反推下一块大小，使下一块趋近 SLICE_SECONDS 预算
          if (dt > 0.5) {
            const est = Math.floor(blob.size * (SLICE_SECONDS / dt));
            seg = Math.min(MAX_SEG, Math.max(MIN_SEG, est));
          }
        } else {
          lastErr = '网络错误，正在重试';
          // 仅网络错误重试；超时不会走到这里（超时只软监控，块自然完成）
        }
      }
      if (!done) throw new Error(lastErr || '上传块失败');
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
