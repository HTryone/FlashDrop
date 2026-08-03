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
      chunkSize: 80 * 1024 * 1024, // 80MiB 分片（用户 2026-08-04 决定：认为大块更快）
      // 注：E2EE 加密帧仍 8MiB（tus-crypto E2EE_CHUNK_SIZE），80MiB 是网络 PATCH 粒度；
      // 80/8=10，每个 part 恰含 10 个完整加密帧，下载端按 8MiB Range 重组不受影响。
      // 风险：China→东京 40.9% 丢包链路上单块变大→整块重传成本升高，需实测对比。
      retryDelays: [0, 1000, 3000, 5000, 10000],
      metadata: meta,
      // 关闭客户端指纹续传：浏览器默认 fingerprint 只含 文件name/type/size/lastModified+endpoint，
      // 不含 transferId；E2EE 时 payload 是普通 Blob（无 name/lastModified）指纹更会退化撞车。
      // findPreviousUploads 会翻出上一个（甚至别的传输的）已完成上传 URL 直接复用，
      // 导致 HEAD 返回 offset==size 后立刻 onSuccess 而不传数据 → “进度条完成但没上传到本传输”。
      // 会话内网络抖动的续传由服务端按上传 URL 的 offset 自动处理，无需客户端缓存。
      storeFingerprintForResuming: false,
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
    upload.start();
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
