/// <reference types="@cloudflare/workers-types" />
import { createStorage, createIndex } from '../../src/transfer/tus/factory';
import type { TusEnv } from '../../src/transfer/tus/types';

export interface Env extends TusEnv {
  DEFAULT_TTL_HOURS?: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // 启动核心：缺 R2/D1 绑定会直接抛 TransferError，不静默回退本地。
    const storage = createStorage(env);
    const index = createIndex(env);
    void storage;
    void index;

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response('flashdrop-tus online', { status: 200 });
    }

    // TODO: 迁入 tus 路由(POST/PATCH/HEAD/DELETE) 与下载路由，复用上方 storage/index。
    // 采用 @tus/server 的 R2 datastore(方案A) 还是自写最小端点(方案B) 待拍板。
    return new Response(
      'flashdrop-tus scaffolded. 绑定就绪: ' +
        `R2=${!!env.R2_TRANSFERS}, D1=${!!env.DB}`,
      { status: 200 },
    );
  },
};
