// 单文件下载：列出所有 tus 分片，前端分多次小块取回（与上传一致），绕过 CF 单响应截断。
// URL：/download/:code/:fileId -> JSON 清单；/download/:code/:fileId/part/:key -> 单分片(支持 Range 子范围)

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

    // 单分片下载（支持 Range 子范围，兼容旧上传的大分片）
    const partMatch = /^\/download\/([^/]+)\/([^/]+)\/part\/(.+)$/.exec(url.pathname);
    if (partMatch) {
      return this.handlePart(partMatch[1], partMatch[2], decodeURIComponent(partMatch[3]), request, origin);
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
      const manifestParts = parts
        .map((p) => {
          const mo = /part-(\d+)$/.exec(p.key);
          return { key: p.key, offset: mo ? Number(mo[1]) : 0, size: p.size };
        })
        .sort((a, b) => a.offset - b.offset);

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

  private async handlePart(
    _code: string,
    _fileId: string,
    partKey: string,
    request: Request,
    origin: string | null,
  ): Promise<Response> {
    try {
      // 解析 Range: bytes=start-end（子范围，兼容 >30MB 的旧分片）
      const rangeHdr = request.headers.get('Range');
      let range: { start: number; end?: number } | undefined;
      if (rangeHdr) {
        const rm = /bytes=(\d+)-(\d*)/.exec(rangeHdr);
        if (rm) {
          const start = Number(rm[1]);
          const end = rm[2] ? Number(rm[2]) : undefined;
          range = end !== undefined ? { start, end } : { start };
        }
      }

      const { body, size, contentRange } = await this.storage.get(partKey, range);
      const headers: Record<string, string> = {
        ...corsHeaders(origin),
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
      };

      if (range) {
        const end = range.end ?? size - 1;
        const len = end - range.start + 1;
        headers['Content-Range'] = contentRange || `bytes ${range.start}-${end}/${size}`;
        headers['Content-Length'] = String(len);
        return new Response(body, { status: 206, headers });
      }

      headers['Content-Length'] = String(size);
      headers['Accept-Ranges'] = 'bytes';
      return new Response(body, { status: 200, headers });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(msg, { status: 500, headers: corsHeaders(origin) });
    }
  }
}
