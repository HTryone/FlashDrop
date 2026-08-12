// 单文件下载：列出所有 tus 分片并附 presigned GET URL，前端直连 R2 分多次小块取回（与上传一致），绕过 CF 单响应截断。
// URL：/download/:code/:fileId -> JSON 清单（含每个 part 的 presigned GET URL，浏览器直连 R2 取数）

import { StorageBackend, IndexBackend } from './types';
import { corsHeaders } from './tus-protocol';

export class DownloadHandler {
  constructor(
    private readonly storage: StorageBackend,
    private readonly index: IndexBackend,
  ) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(origin) });
    }

    const m = /^\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!m) {
      return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });
    }
    const [, code, fileId] = m;

    try {
      const transferId = await this.index.resolveCode(code);
      if (!transferId) {
        return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });
      }
      if (await this.index.isExpired(transferId)) {
        return new Response('Gone', { status: 410, headers: corsHeaders(origin) });
      }

      const t = await this.index.getTransfer(transferId);
      if (!t) return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });

      const file = t.files.find((f) => f.id === fileId);
      if (!file) return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });

      const parts = await this.storage.list(`${fileId}/`);
      const total = parts.reduce((sum, p) => sum + p.size, 0);
      if (total !== file.size) {
        return new Response('文件尚未上传完成', { status: 423, headers: corsHeaders(origin) });
      }

      // 列出分片清单，前端分多次小块取回（与上传一致）
      // 每个 part 附 presigned GET URL：浏览器直连 R2 取数据，绕过 Worker 中转（下载加速，方案 A）
      const manifestParts = await Promise.all(
        parts
          .map((p) => {
            const mo = /part-(\d+)$/.exec(p.key);
            return { key: p.key, offset: mo ? Number(mo[1]) : 0, size: p.size };
          })
          .sort((a, b) => a.offset - b.offset)
          .map(async (part) => ({
            ...part,
            url: await this.storage.createPresignedUrl(part.key, { method: 'GET', expiresIn: 1200 }),
          })),
      );

      return new Response(
        JSON.stringify({ parts: manifestParts, total, filename: file.relativePath }),
        {
          status: 200,
          headers: {
            ...corsHeaders(origin),
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(msg, { status: 500, headers: corsHeaders(origin) });
    }
  }

}
