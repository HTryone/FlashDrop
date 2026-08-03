// tus 可续传上传封装：支持分片、进度、并发、续传、E2EE 加密
import * as tus from 'tus-js-client';
import type { QueuedFile } from '@/types/transfer';
import { encryptFile, deriveKey, E2EE_CHUNK_SIZE } from '@/crypto/tus-crypto';
import { resolveTusBase } from '@/transfer/room';

export interface UploadOptions {
  transferId: string;
  e2ee: { enabled: boolean; passphrase: string };
  _e2eeSalt?: string;
  onProgress: (uploaded: number, size: number) => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

/** 上传单个文件（E2EE 开启时先加密为密文 Blob 再上传） */
export async function uploadOne(qf: QueuedFile, opts: UploadOptions): Promise<void> {
  let payload: Blob | File = qf.file;
  if (opts.e2ee.enabled && opts.e2ee.passphrase) {
    const key = await deriveKey(opts.e2ee.passphrase, opts._e2eeSalt!);
    payload = await encryptFile(qf.file, key, (r) => {
      // 加密阶段进度并入上传进度（按 50% 估算）
      opts.onProgress(Math.floor(qf.file.size * r * 0.5), qf.file.size);
    });
  }

  const metaName = qf.file.name;
  const meta: Record<string, string> = {
    filename: metaName,
    relativePath: qf.relativePath || metaName,
    transferId: opts.transferId,
  };
  if (opts.e2ee.enabled) meta.e2ee = '1';

  const tusBase = resolveTusBase();
  const endpoint = `${tusBase}/files`;

  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(payload, {
      endpoint,
      chunkSize: 8 * 1024 * 1024, // 8MiB 分片（与 E2EE 加密块统一，中转全程 8MiB）
      retryDelays: [0, 1000, 3000, 5000, 10000],
      metadata: meta,
      onError: (err) => reject(err),
      onProgress: (sent, total) => {
        if (opts.e2ee.enabled) {
          // 加密已完成 50%，上传占后 50%
          opts.onProgress(Math.floor(qf.file.size * (0.5 + 0.5 * (sent / total))), qf.file.size);
        } else {
          opts.onProgress(sent, total);
        }
      },
      onSuccess: () => resolve(),
    });
    qf._upload = upload;
    upload.findPreviousUploads().then((prev) => {
      if (prev.length) upload.resumeFromPreviousUpload(prev[0]);
      upload.start();
    });
  });
}

/** 并发控制：一次最多 n 个文件在传 */
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
