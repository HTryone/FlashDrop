/// <reference types="@cloudflare/workers-types" />
import { createIndex } from './factory';
import type { TusEnv } from './factory';
import { CloudSweeper } from './sweeper';
import { TusHandler } from '../../src/transfer/tus/tus-handler';
import { TransferHandler } from '../../src/transfer/tus/transfer-handler';
import { DownloadHandler } from '../../src/transfer/tus/download-handler';
import { PresignHandler } from './presign-handler';
import { QuotaGuard } from './quota';
import { BucketSelector, createStorageResolver, type StorageResolver } from './storage-router';
import { handleAdmin, type AdminCtx } from './admin/admin-page';
import { corsHeaders, parseMetadata } from '../../src/transfer/tus/tus-protocol';
import type { IndexBackend, StorageBackend } from '../../src/transfer/tus/types';

export interface Env extends TusEnv {
  DEFAULT_TTL_HOURS?: string;
  QUOTA_KV?: KVNamespace;
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
): Promise<StorageBackend> {
  const file = await index.getFile(fileId);
  if (file?.transferId) {
    const acc = await quota.accountOfTransfer(file.transferId);
    if (acc) return await resolver.resolve(acc);
  }
  throw new Error('文件无归属桶');
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
      const index = createIndex(env);
      const kv = env.QUOTA_KV;
      const resolver = createStorageResolver(kv);
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
        // POST /files：创建传输，桶由 selector.select 现场选（无桶会抛错，符合纯 KV 无兜底）
        const meta = parseMetadata(request.headers.get('Upload-Metadata'));
        const tid = meta.transferId?.trim();
        let st: StorageBackend;
        try {
          const acc = tid ? await quota.accountOfTransfer(tid) : null;
          st = acc ? await resolver.resolve(acc) : await resolver.resolve('default');
        } catch {
          st = await resolver.resolve('default');
        }
        return await new TusHandler(st, index).handle(request);
      }

      if (pathname.startsWith('/files/')) {
        const fileId = pathname.slice('/files/'.length);
        const fileStorage = await resolveStorageForFile(index, resolver, quota, fileId);
        return await new TusHandler(fileStorage, index).handle(request);
      }

      if (pathname === '/api/presign' || pathname === '/api/commit') {
        const handler = new PresignHandler(index, quota, resolver);
        return pathname === '/api/presign'
          ? await handler.handlePresign(request, origin)
          : await handler.handleCommit(request, origin);
      }

      const mFiles = /^\/api\/transfers\/([^/]+)\/files$/.exec(pathname);
      if (mFiles && (request.method === 'DELETE' || request.method === 'OPTIONS')) {
        const tid = decodeURIComponent(mFiles[1]);
        if (request.method === 'DELETE') await quota.releaseByTransfer(tid); // 主动清空即释放配额
        // 全 KV 化：按传输归属桶解析出对应后端再删（无归属直接报错）
        const acc = await quota.accountOfTransfer(tid);
        const delStorage = acc ? await resolver.resolve(acc) : await resolver.resolve('default');
        return await new TransferHandler(index, delStorage, ttl).deleteTransferFiles(tid, origin, request.method);
      }

      if (pathname === '/api/transfers' || pathname.startsWith('/api/transfer/')) {
        // 传输元数据操作不落文件体，storage 传 undefined（内部删除路径已按桶解析）
        return await new TransferHandler(index, undefined, ttl).handle(request);
      }

      if (pathname.startsWith('/download/')) {
        const m = /^\/download\/([^/]+)\/([^/]+)$/.exec(pathname);
        if (m) {
          const transferId = await index.resolveCode(decodeURIComponent(m[1]));
          if (transferId) {
            const acc = await quota.accountOfTransfer(transferId);
            const dlStorage = acc ? await resolver.resolve(acc) : await resolver.resolve('default');
            return await new DownloadHandler(dlStorage, index).handle(request);
          }
        }
        return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });
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
          const resolver = createStorageResolver(kv);
          const sweeper = new CloudSweeper(index, undefined, () => Date.now(), quota, resolver);
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
