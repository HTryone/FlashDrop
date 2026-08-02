// 单文件下载：按分享码 + fileId 流式拼接 R2 上的所有 tus 分片。
// URL 与 server.mjs 对齐：/download/:code/:fileId

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
      if (parts.length === 0) {
        return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });
      }

      const total = parts.reduce((sum, p) => sum + p.size, 0);
      if (total !== file.size) {
        // 上传未完成：返回 423 Locked，与 tus 语义一致
        return new Response('文件尚未上传完成', { status: 423, headers: corsHeaders(origin) });
      }

      // 按 part-{offset} 中的 offset 排序，确保顺序正确
      parts.sort((a, b) => {
        const ao = Number(a.key.split('/part-')[1] ?? 0);
        const bo = Number(b.key.split('/part-')[1] ?? 0);
        return ao - bo;
      });

      const filename = encodeURIComponent(file.relativePath).replace(/%20/g, '+');
      return new Response(this.buildStream(parts), {
        status: 200,
        headers: {
          ...corsHeaders(origin),
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(msg, { status: 500, headers: corsHeaders(origin) });
    }
  }

  private buildStream(parts: { key: string }[]): ReadableStream<Uint8Array> {
    let idx = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (idx < parts.length) {
          if (!reader) {
            const { body } = await this.storage.get(parts[idx].key);
            reader = body.getReader();
          }
          const { done, value } = await reader.read();
          if (done) {
            reader.releaseLock();
            reader = undefined;
            idx++;
            continue;
          }
          controller.enqueue(value);
          return;
        }
        controller.close();
      },
      cancel: () => {
        reader?.cancel().catch(() => {});
      },
    });
  }
}
