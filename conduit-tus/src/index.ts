/// <reference types="@cloudflare/workers-types" />
import { createStorage, createIndex } from './factory';
import { TusHandler } from '../../src/transfer/tus/tus-handler';
import { TransferHandler } from '../../src/transfer/tus/transfer-handler';
import { DownloadHandler } from '../../src/transfer/tus/download-handler';
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

      if (pathname === '/api/transfers' || pathname.startsWith('/api/transfer/')) {
        const ttl = Number(env.DEFAULT_TTL_HOURS || 24);
        return await new TransferHandler(index, ttl).handle(request);
      }

      if (pathname.startsWith('/download/')) {
        return await new DownloadHandler(storage, index).handle(request);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(msg, { status: 500, headers: corsHeaders(origin) });
    }
  },
};
