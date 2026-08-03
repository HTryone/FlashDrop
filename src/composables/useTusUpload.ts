// 中转上传：加密后浏览器直传 R2（presigned PUT），Worker 仅做控制面（创建文件 / 索引 / commit）。
// 大体积密文流绕过 Worker 的 request.body pipe，避免 CF 边缘对大请求体流式透传的字节损坏
// （HMAC 校验失败根因：tus PATCH 把 80MiB 流穿过 CF 边缘→Worker→FixedLengthStream→R2，损坏且静默入库）。
// 直传 R2 后数据不经 Worker 字节处理，R2 原生按 content-length 接收，损坏消失；80MiB 网络块保留（保速度）。

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

/** 上传网络块：80MiB（用户实测保速度；E2EE 帧仍 8MiB，80/8=10 每块恰含 10 帧，下载 8MiB Range 重组不受影响）。 */
const BLOCK = 80 * 1024 * 1024;
/** 并发直传路数：抗掉线、铺满带宽（上传是写、比下载 12 路保守）。 */
const CONCURRENCY = 3;
/** 单块失败重试次数（网络抖动 / 单路掉线）。 */
const RETRIES = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

    // 切 80MiB 网络块（纯字节切，与 E2EE 8MiB 帧对齐无关）
    const blocks: { start: number; blob: Blob }[] = [];
    for (let off = 0; off < size; off += BLOCK) {
      const end = Math.min(off + BLOCK, size);
      blocks.push({ start: off, blob: cipher.slice(off, end) });
    }

    let idx = 0;
    let uploaded = 0;
    let failed = false;

    const runLane = async () => {
      while (!failed && idx < blocks.length) {
        const i = idx++;
        const b = blocks[i];
        const len = b.blob.size;
        let ok = false;
        let lastErr: unknown;
        for (let attempt = 0; attempt < RETRIES && !ok; attempt++) {
          try {
            const url = await presign(tusBase, fileId, b.start, len);
            const res = await fetch(url, {
              method: 'PUT',
              body: b.blob,
              headers: { 'Content-Type': 'application/octet-stream' },
            });
            if (!res.ok) throw new Error(`PUT 失败 ${res.status}`);
            await commit(tusBase, fileId, b.start + len, len);
            ok = true;
          } catch (e) {
            lastErr = e;
            await sleep(1000 * attempt);
          }
        }
        if (!ok) {
          failed = true;
          throw lastErr instanceof Error ? lastErr : new Error('上传块失败');
        }
        uploaded += len;
        const frac = opts.e2ee.enabled ? 0.5 + 0.5 * (uploaded / size) : uploaded / size;
        opts.onProgress(Math.floor(qf.file.size * frac), qf.file.size);
      }
    };

    const lanes = Math.min(CONCURRENCY, blocks.length);
    await Promise.all(Array.from({ length: lanes }, () => runLane()));

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
