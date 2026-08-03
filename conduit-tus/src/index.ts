/// <reference types="@cloudflare/workers-types" />
import { createStorage, createIndex } from './factory';
import { CloudSweeper } from './sweeper';
import { TusHandler } from '../../src/transfer/tus/tus-handler';
import { TransferHandler } from '../../src/transfer/tus/transfer-handler';
import { DownloadHandler } from '../../src/transfer/tus/download-handler';
import { PresignHandler } from './presign-handler';
import { corsHeaders } from '../../src/transfer/tus/tus-protocol';
import type { TusEnv } from '../../src/transfer/tus/types';

export interface Env extends TusEnv {
  DEFAULT_TTL_HOURS?: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');

    try {
      // 启动核心：缺 R2/D1 绑定会直接抛 TransferError，不静默回退本地。
      const storage = createStorage(env);
      const index = createIndex(env);

      const url = new URL(request.url);
      const pathname = url.pathname;

      if (pathname === '/health') {
        return new Response('flashdrop-tus online', {
          status: 200,
          headers: corsHeaders(origin),
        });
      }

      if (pathname === '/files' || pathname.startsWith('/files/')) {
        return await new TusHandler(storage, index).handle(request);
      }

      if (pathname === '/api/presign' || pathname === '/api/commit') {
        const handler = new PresignHandler(storage, index);
        return pathname === '/api/presign'
          ? await handler.handlePresign(request, origin)
          : await handler.handleCommit(request, origin);
      }

      if (pathname === '/api/transfers' || pathname.startsWith('/api/transfer/')) {
        // 有效期由服务端锁定为 DEFAULT_TTL_HOURS（24 小时）；客户端传入的 ttlHours
        // 已被 TransferHandler 忽略，确保"房间 24 小时后自动清除"为硬保证、不可被前端/API 改写。
        const ttl = Number(env.DEFAULT_TTL_HOURS || 24);
        return await new TransferHandler(index, ttl).handle(request);
      }

      if (pathname.startsWith('/download/')) {
        return await new DownloadHandler(storage, index).handle(request);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[flashdrop-tus] uncaught', e);
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
          const storage = createStorage(env);
          const index = createIndex(env);
          const sweeper = new CloudSweeper(index, storage);
          const result = await sweeper.sweep();
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
