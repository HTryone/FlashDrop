// 中转上传：加密后浏览器直传 R2（presigned PUT），Worker 仅做控制面（创建文件 / 索引 / commit）。
// 大体积密文流绕过 Worker 的 request.body pipe，避免 CF 边缘对大请求体流式透传的字节损坏
// （HMAC 校验失败根因：tus PATCH 把 80MiB 流穿过 CF 边缘→Worker→FixedLengthStream→R2，损坏且静默入库）。
// 直传 R2 后数据不经 Worker 字节处理，R2 原生按 content-length 接收，损坏消失；块大小策略：默认 32MB，55s 看门狗触发则降 24MB，再触发降 16MB（兜底）；兜底档(16MB)连续真实失败 3 次则中止上传报错；看门狗不中断当前块，commit 异步流水线。

import { encryptFile, deriveKey } from '@/crypto/tus-crypto';
import { resolveTusBase } from '@/transfer/room';
import { encodeMetadata } from '@/transfer/tus/tus-protocol';
import type { QueuedFile } from '@/types/transfer';

interface Prefetched { off: number; len: number; url: string }

export interface UploadOptions {
  transferId: string;
  e2ee: { enabled: boolean; passphrase: string };
  _e2eeSalt?: string;
  /** 中止信号：取消/故障兜底时统一中断所有 worker */
  signal?: AbortSignal;
  /** 网络兜底失败（达到上限）回调：上层据此进入 failed 态并 abort */
  onFatal?: () => void;
  /** 重传时复用首次的 fileId（跳过 createUpload，从 0 覆盖，避免重复文件） */
  resumeFileId?: string;
  onProgress: (uploaded: number, size: number) => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

/** 默认块大小：快链默认 32MB（用户指定最高档；降档序列 32 → 24 → 16）。 */
const BLOCK = 32 * 1024 * 1024;
/** 看门狗（秒）：单块到时仍未传完 → 触发降档（不中断当前块，让其自然完成或撞 60s 边缘）。 */
const WATCHDOG = 55;
/** 看门狗/失败降档序列（单调不回升）：32 → 24 → 16(兜底)。每次触发升一档，封顶 16MB。 */
const TIERS = [BLOCK, 24 * 1024 * 1024, 16 * 1024 * 1024];
/** 单区间重试次数（每次失败自动降档，不会同尺寸反复重试）。 */
const RETRIES = 5;
/** 兜底档(16MB)连续失败上限：含看门狗超时(慢)与真实连接失败(neterr)，达到后判定网络不可用，直接中止上传并报错。 */
const MAX_BOTTOM_RETRIES = 2;

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

/** 单块 PUT（XHR）：带上传进度；成功返回 'done'，真实网络错误返回 'neterr'，外部 abort 返回 'aborted'。
 * 看门狗（WATCHDOG 秒）到时调用 onWatchdog()：仅作降档信号，【不 abort、不切小】当前块，
 * 让当前 PUT 自然完成（可能略超 55s，只要不撞 R2 边缘 60s 即可；若真超 60s 边缘会失败，上层按失败降档重传）。
 * 只有真正的网络错误（onerror / 非 2xx）才返回 'neterr' 允许上层降档重试；外部 signal abort 返回 'aborted' 直接退出。 */
function uploadSliceXHR(
  url: string,
  blob: Blob,
  onProgress: (sent: number) => void,
  onWatchdog?: () => boolean,
  signal?: AbortSignal,
): Promise<'done' | 'neterr' | 'aborted'> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let sent = 0;
    let settled = false;
    let watchdogCalled = false;
    const finish = (r: 'done' | 'neterr' | 'aborted') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // 看门狗：通知上层降档；若上层返回 true（兜底档失败达上限）则立即中止当前块并判为失败(neterr)
    const timer = setTimeout(() => {
      if (watchdogCalled) return;
      watchdogCalled = true;
      console.warn(`[upload] 单块已超 ${WATCHDOG}s 看门狗，触发降档（后续块用更小尺寸）`);
      const abortNow = onWatchdog?.() === true;
      if (abortNow) {
        try { xhr.abort(); } catch { /* 已结束 */ }
        finish('neterr');
      }
    }, WATCHDOG * 1000);
    // 外部中止：立即中断当前 XHR，返回 'aborted'（区别于真实网络错误）
    if (signal) {
      if (signal.aborted) return finish('aborted');
      signal.addEventListener('abort', () => { try { xhr.abort(); } catch { /* 已结束 */ } }, { once: true });
    }
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
    xhr.onabort = () => finish('aborted');
    xhr.send(blob);
  });
}

/** 上传单个文件（E2EE 开启时先加密为密文 Blob 再直传 R2）。 */
export async function uploadOne(qf: QueuedFile, opts: UploadOptions): Promise<void> {
  try {
    const checkAbort = () => {
      if (opts.signal?.aborted) {
        const e = new Error('aborted');
        (e as any).name = 'AbortError';
        throw e;
      }
    };
    checkAbort();
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

    // 块大小策略（用户指定，2026-08-12 调整）：
    // 默认 32MB；看门狗 55s 到时未传完 → 后续块降 24MB；再触发看门狗 → 降 16MB（兜底）。
    // 兜底档(16MB)连续失败（看门狗超时<慢> 或 真实连接失败neterr 均计）达 2 次 → 判定网络不可用，直接中止上传并报错。
    // 看门狗/失败降档单调不回升；看门狗不中断当前块（让其自然完成或撞 60s 边缘）；
    // commit 异步 + 下一块预签名流水线，消串行空挡；不靠测速。
    let off = 0;
    let tier = 0;                 // 降档档位：0=32, 1=24, 2=16（兜底），单调不回升
    let committed = 0;            // 已落库字节（commit 成功）
    let inflight = 0;             // 当前块已上行字节（仅 UI 进度反馈）
    const pf: { cur: Prefetched | null } = { cur: null };
    const commitJobs: Promise<void>[] = [];
    const commitRetries: Array<() => Promise<void>> = [];
    let finished = false;           // 仅在所有块 PUT 200 且 commit 全部完成后置位 → 进度才允许到 100%

    const pickSeg = (): number => TIERS[Math.min(tier, TIERS.length - 1)];
    // 触发一次降档（看门狗或失败）：档位升一档（封顶 16MB），作废已预取的 presign（尺寸变了）
    const downgrade = () => { tier = Math.min(tier + 1, TIERS.length - 1); pf.cur = null; };
    const topTierIdx = TIERS.length - 1;        // 兜底档索引（16MB）
    let bottomFails = 0;                        // 兜底档连续失败计数（看门狗超时<慢> 或 neterr 均计）
    let fatalTriggered = false;                // 兜底档失败达上限 → 看门狗回调置位，主循环据此中止
    // 兜底档(16MB)出现一次失败（看门狗超时 或 真实连接失败neterr）即计入；累计达上限则中止任务并报错。
    const registerBottomFail = (curSeg: number) => {
      if (tier >= topTierIdx) {
        bottomFails++;
        if (bottomFails >= MAX_BOTTOM_RETRIES) {
          opts.onFatal?.();   // 通知上层进入 failed 态并全局 abort
          throw new Error(`兜底块(${Math.round(curSeg / 1048576)}MB)连续失败 ${bottomFails} 次，网络不可用，已中止上传`);
        }
      }
    };
    // 任何块成功落库 → 网络已恢复，重置兜底失败计数
    const onBlockSuccess = () => { bottomFails = 0; };

    const report = () => {
      const up = committed + inflight;
      let frac = opts.e2ee.enabled ? 0.5 + 0.5 * (up / size) : up / size;
      // 关键：真正完成（finished）前进度封顶 99%，避免「浏览器发完最后一块」就显示 100%
      // 误导用户提前关页/下载 → 末块未真正落盘 → 下载末尾 HMAC 失配。
      if (!finished) frac = Math.min(frac, 0.99);
      opts.onProgress(Math.floor(qf.file.size * frac), qf.file.size);
    };

    while (off < size) {
      checkAbort();
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
        () => {
          downgrade();
          // 已在兜底档(16MB)还被看门狗掐断(极慢) → 计一次失败；达上限置位 fatalTriggered 让主循环中止
          if (tier >= topTierIdx) {
            bottomFails++;
            if (bottomFails >= MAX_BOTTOM_RETRIES) {
              opts.onFatal?.();
              fatalTriggered = true;
              return true;   // 通知 uploadSliceXHR 立即中止当前块并判为失败
            }
          }
          return false;
        },
        opts.signal,
      );
      if (r === 'aborted') { const e = new Error('aborted'); (e as any).name = 'AbortError'; throw e; }
      if (fatalTriggered) throw new Error(`兜底块(16MB)连续 ${bottomFails} 次看门狗超时(55s)，网络不可用，已中止上传`);
      await prefetchP;

      if (r === 'done') {
        const job = () => commit(tusBase, fileId, off + blob.size, blob.size);
        commitJobs.push(job());
        commitRetries.push(job);
        committed += blob.size;
        inflight = 0;
        off = end;
        report();
        onBlockSuccess();
        // 看门狗已在回调里 downgrade()（当前块用旧档位，下一块起用新档位）；正常完成不回升。
      } else {
        // 主尝试失败(neterr 或 看门狗兜底档中止)：在兜底档计入兜底失败次数
        registerBottomFail(seg);
        // 失败（含撞 60s 边缘）：首次失败升一档，同区间用更小块重传；重试仍失败再升一档（封顶 16MB），不反复同尺寸。
        downgrade();
        let curSeg = pickSeg();
        let ok = false;
        let lastErr = '网络错误，正在降档重试';
        for (let a = 0; a < RETRIES && !ok; a++) {
          const cEnd = Math.min(off + curSeg, size);
          const cb = cipher.slice(off, cEnd);
          const curl = await presign(tusBase, fileId, off, cb.size);
          const cr = await uploadSliceXHR(curl, cb, (s) => { inflight = s; report(); }, undefined, opts.signal);
          if (cr === 'aborted') { const e = new Error('aborted'); (e as any).name = 'AbortError'; throw e; }
          if (cr === 'done') {
            const job = () => commit(tusBase, fileId, off + cb.size, cb.size);
            commitJobs.push(job());
            commitRetries.push(job);
            committed += cb.size;
            inflight = 0;
            off = cEnd;
            report();
            ok = true;
            onBlockSuccess();
          } else {
            registerBottomFail(curSeg);
            downgrade();
            curSeg = pickSeg();
          }
        }
        if (!ok) throw new Error(lastErr);
      }
    }

    // 收尾：确保所有 commit 完成（失败的异步 commit 重试 3 次）
    // 注意：commitJobs 不再 .catch 吞错，故 allSettled 能真实反映拒绝，下面重试才会触发。
    const settled = await Promise.allSettled(commitJobs);
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'rejected') {
        for (let k = 0; k < 3; k++) {
          try { await commitRetries[i](); break; } catch { /* 继续重试 */ }
        }
      }
    }

    // 真正完成：先置位 finished 让进度补到 100%，再通知上层「已完成」。
    // 此刻所有块 PUT 已回 200 且 commit 已确认落盘，关页/下载都安全。
    finished = true;
    report();
    opts.onSuccess();
  } catch (e: any) {
    if ((e as any)?.name === 'AbortError') throw e;  // 取消/故障中止：不报错，交上层处理
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
          signal: opts.signal,
          onFatal: opts.onFatal,
          resumeFileId: qf.fileId,
          onProgress: (u, s) => opts.onItemProgress?.(qf, u, s),
          onSuccess: () => opts.onItemSuccess?.(qf),
          onError: (m) => opts.onItemError?.(qf, m),
        });
        qf.status = 'done';
        opts.onItemSuccess?.(qf);
      } catch (e: any) {
        if ((e as any)?.name === 'AbortError') {
          // 取消/故障中止：回到 pending，允许后续「继续上传/重新传输」
          if (qf.status !== 'done') qf.status = 'pending';
        } else {
          qf.status = 'error';
          qf.error = e?.message || String(e);
          opts.onItemError?.(qf, qf.error || '未知错误');
        }
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);
}
