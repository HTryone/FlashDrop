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

/** 上传网络块基准大小：快链上单块自然到 80MiB（保速度）；慢链由"秒"驱动自动切小。 */
const BASE_SEG = 80 * 1024 * 1024;
/** 单条连接时间预算（秒）：到时就切下一块，绝不撞 R2 边缘 60s 硬超时。用户指定"用秒记"。 */
const SLICE_SECONDS = 50;
/** 块缩到的最小尺寸（兜底，避免极端慢链无限切）。 */
const MIN_SEG = 4 * 1024 * 1024;
/** 单块失败重试次数（网络抖动 / 单路掉线 / 超时切小后重传）。 */
const RETRIES = 8;

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

/** 单块 PUT（XHR）：带 SLICE_SECONDS 超时与上传进度；超时/失败返回 'timeout'，成功返回 'done'。
 * 关键：50s 到时只在"数据还在传"才 abort 切小；块已传完但 R2 响应晚到（竞态窗口）则等响应，
 * 不重传——否则会把已落盘的块误判失败、从同 offset 重传，造成"完成了还重传"。 */
function uploadSliceXHR(
  url: string,
  blob: Blob,
  onProgress: (sent: number) => void,
): Promise<'done' | 'timeout'> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let sent = 0; // 已上传字节（由 progress 事件累计，非 abort 后回退）
    let settled = false;
    const finish = (r: 'done' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // 用秒记：到时若数据尚未传完 → 超时切小；已传完 → 等服务器响应（200 即完成，不重传）
    const timer = setTimeout(() => {
      if (sent < blob.size) finish('timeout');
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
    xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? 'done' : 'timeout');
    xhr.onerror = () => finish('timeout');
    xhr.onabort = () => finish('timeout');
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

    // 单发 + 用秒记切片：顺序传，每条约 SLICE_SECONDS 秒；超时就把这块切小重传（不测速度、不算块）。
    let off = 0;
    let seg = BASE_SEG; // 快链上自然 80MiB；慢链由超时驱动减半
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
        const r = await uploadSliceXHR(url, blob, (sent) => {
          inflight = sent;
          report();
        });
        if (r === 'done') {
          await commit(tusBase, fileId, off + blob.size, blob.size);
          committed += blob.size;
          inflight = 0;
          off += blob.size;
          report();
          done = true;
        } else {
          if (seg <= MIN_SEG) {
            // 已到最小块仍超时：极端慢链，放弃空转（避免 8×50s 浪费），直接失败
            throw new Error('单块传输超时（已达最小块 4MiB），链路过慢');
          }
          // 用秒记：到时切小块，下回从同一 offset 重传（R2 未提交中断的 PUT）
          seg = Math.floor(seg / 2);
          inflight = 0;
          lastErr = '单块传输超时，已切小重传';
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
