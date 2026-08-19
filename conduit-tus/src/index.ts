/// <reference types="@cloudflare/workers-types" />
import { createStorage, createIndex } from './factory';
import type { TusEnv } from './factory';
import { CloudSweeper } from './sweeper';
import { TusHandler } from '../../src/transfer/tus/tus-handler';
import { TransferHandler } from '../../src/transfer/tus/transfer-handler';
import { DownloadHandler } from '../../src/transfer/tus/download-handler';
import { PresignHandler } from './presign-handler';
import { QuotaGuard } from './quota';
import { BucketSelector, createStorageResolver, type StorageResolver } from './storage-router';
import { handleAdmin, type AdminCtx } from './admin-page';
import { corsHeaders, parseMetadata } from '../../src/transfer/tus/tus-protocol';
import type { IndexBackend, StorageBackend } from '../../src/transfer/tus/types';

export interface Env extends TusEnv {
  DEFAULT_TTL_HOURS?: string;
  QUOTA_KV?: KVNamespace;
  // 第二个 Cloudflare 账户 / R2 桶（仓库写法，接第二桶时取消 wrangler.toml 注释并填值）
  R2_TRANSFERS_B?: R2Bucket;
  R2_ACCOUNT_ID_B?: string;
  R2_ACCESS_KEY_ID_B?: string;
  R2_SECRET_ACCESS_KEY_B?: string;
}

/** 门卫①预检：POST /files 时即时判断（此时尚无 fileId，只比较，不扣账）。 */
async function gatePrecheck(request: Request, index: IndexBackend, quota: QuotaGuard): Promise<boolean> {
  const uploadLength = request.headers.get('Upload-Length');
  if (uploadLength === null) return true; // 缺头交给 tus-handler 报错，不抢职责
  const size = Number(uploadLength);
  if (!Number.isFinite(size) || size < 0) return true;
  const meta = parseMetadata(request.headers.get('Upload-Metadata'));
  const transferId = meta.transferId?.trim();
  if (!transferId) return true;
  const transfer = await index.getTransfer(transferId);
  if (!transfer) return true;
  return quota.precheck(transferId, size);
}

/** 按 fileId → 传输 → 归属桶 解析出正确的 R2StorageBackend（多桶路由，不改共享代码）。 */
async function resolveStorageForFile(
  index: IndexBackend,
  resolver: StorageResolver,
  quota: QuotaGuard,
  fileId: string,
  fallback: StorageBackend,
): Promise<StorageBackend> {
  try {
    const file = await index.getFile(fileId);
    if (file?.transferId) {
      const acc = await quota.accountOfTransfer(file.transferId);
      return await resolver.resolve(acc);
    }
  } catch {
    /* 解析失败回退默认桶 */
  }
  return fallback;
}

function quotaRejected(origin: string | null): Response {
  return new Response(
    JSON.stringify({ error: '当前存储桶上传额度已用完（含未过期文件占用），请等待文件过期释放或联系站长' }),
    { status: 429, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } },
  );
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');

    try {
      const storage = createStorage(env);
      const index = createIndex(env);
      const kv = env.QUOTA_KV;
      const resolver = createStorageResolver(env, kv);
      const selector = new BucketSelector(env.DB!, kv);
      const quota = new QuotaGuard(kv, env.DB!, selector);

      const url = new URL(request.url);
      const pathname = url.pathname;
      const ttl = Number(env.DEFAULT_TTL_HOURS || 24);

      if (pathname === '/health') {
        return new Response('arkpulse-tus online', {
          status: 200,
          headers: corsHeaders(origin),
        });
      }

      // 站长后台
      if (pathname === '/admin' || pathname.startsWith('/api/admin/')) {
        const ctx: AdminCtx = {
          env: env as unknown as Record<string, unknown>,
          index,
          quota,
          selector,
          resolver,
          kv,
        };
        return await handleAdmin(request, ctx);
      }

      if (pathname === '/files') {
        // 门卫①预检（即时 429）
        if (request.method === 'POST') {
          const ok = await gatePrecheck(request, index, quota);
          if (!ok) return quotaRejected(origin);
        }
        return await new TusHandler(storage, index).handle(request);
      }

      if (pathname.startsWith('/files/')) {
        const fileId = pathname.slice('/files/'.length);
        const fileStorage = await resolveStorageForFile(index, resolver, quota, fileId, storage);
        return await new TusHandler(fileStorage, index).handle(request);
      }

      if (pathname === '/api/presign' || pathname === '/api/commit') {
        const handler = new PresignHandler(storage, index, quota, resolver);
        return pathname === '/api/presign'
          ? await handler.handlePresign(request, origin)
          : await handler.handleCommit(request, origin);
      }

      const mFiles = /^\/api\/transfers\/([^/]+)\/files$/.exec(pathname);
      if (mFiles && (request.method === 'DELETE' || request.method === 'OPTIONS')) {
        const tid = decodeURIComponent(mFiles[1]);
        if (request.method === 'DELETE') await quota.releaseByTransfer(tid); // 主动清空即释放配额
        return await new TransferHandler(index, storage, ttl).deleteTransferFiles(tid, origin, request.method);
      }

      if (pathname === '/api/transfers' || pathname.startsWith('/api/transfer/')) {
        return await new TransferHandler(index, storage, ttl).handle(request);
      }

      if (pathname.startsWith('/download/')) {
        const m = /^\/download\/([^/]+)\/([^/]+)$/.exec(pathname);
        let dlStorage = storage;
        if (m) {
          const transferId = await index.resolveCode(decodeURIComponent(m[1]));
          if (transferId) {
            const acc = await quota.accountOfTransfer(transferId);
            dlStorage = await resolver.resolve(acc);
          }
        }
        return await new DownloadHandler(dlStorage, index).handle(request);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[arkpulse-tus] uncaught', e);
    return new Response(msg, { status: 500, headers: corsHeaders(origin) });
  }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const index = createIndex(env);
          const kv = env.QUOTA_KV;
          const selector = new BucketSelector(env.DB!, kv);
          const quota = new QuotaGuard(kv, env.DB!, selector);
          const sweeper = new CloudSweeper(index, createStorage(env), () => Date.now(), quota);
          const result = await sweeper.sweep();
          // sweeper 已回收 terminated/过期传输的额度；再补一次过期回收（覆盖边界）
          await quota.releaseExpired(Date.now());
          console.log(
            `Sweep: removed ${result.removedFiles} files, ${result.removedTransfers} transfers`,
          );
        } catch (e) {
          console.error('Sweep failed:', e instanceof Error ? e.message : String(e));
        }
      })(),
    );
  },
};
