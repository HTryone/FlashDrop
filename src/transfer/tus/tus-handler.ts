// tus 服务端最小实现（方案 B）：POST/PATCH/HEAD/DELETE/OPTIONS。
// 文件体落 R2，分片 key 为 {fileId}/part-{offset}；offset 通过 R2 list 汇总。

import { StorageBackend, IndexBackend, TransferError } from './types';
import { MAX_SIZE, corsHeaders, tusHeaders, parseMetadata } from './tus-protocol';

export class TusHandler {
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

    const m = /^\/files(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) {
      return this.error('Not Found', 404, origin);
    }
    const fileId = m[1];

    try {
      switch (request.method) {
        case 'POST':
          return fileId
            ? this.error('POST 必须发到 /files', 400, origin)
            : await this.createUpload(request, origin);
        case 'PATCH':
          return fileId
            ? await this.patchUpload(request, fileId, origin)
            : this.error('PATCH 必须指定 fileId', 400, origin);
        case 'HEAD':
          return fileId
            ? await this.headUpload(fileId, origin)
            : this.error('HEAD 必须指定 fileId', 400, origin);
        case 'DELETE':
          return fileId
            ? await this.deleteUpload(fileId, origin)
            : this.error('DELETE 必须指定 fileId', 400, origin);
        default:
          return this.error('Method Not Allowed', 405, origin);
      }
    } catch (e) {
      return this.errorFrom(e, origin);
    }
  }

  private error(message: string, status: number, origin: string | null): Response {
    return new Response(message, {
      status,
      headers: { ...corsHeaders(origin), ...tusHeaders() },
    });
  }

  private errorFrom(e: unknown, origin: string | null): Response {
    if (e instanceof TransferError) {
      const statusMap: Record<TransferError['code'], number> = {
        NOT_FOUND: 404,
        EXPIRED: 410,
        TERMINATED: 410,
        STORAGE: 500,
        INDEX: 500,
      };
      return new Response(e.message, {
        status: statusMap[e.code] ?? 500,
        headers: { ...corsHeaders(origin), ...tusHeaders() },
      });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(msg, { status: 500, headers: { ...corsHeaders(origin), ...tusHeaders() } });
  }

  private async createUpload(request: Request, origin: string | null): Promise<Response> {
    const uploadLength = request.headers.get('Upload-Length');
    if (uploadLength === null) {
      return this.error('缺少 Upload-Length', 400, origin);
    }
    const size = Number(uploadLength);
    if (!Number.isFinite(size) || size < 0 || size > MAX_SIZE) {
      return this.error('Upload-Length 无效或超过最大限制', 400, origin);
    }

    const meta = parseMetadata(request.headers.get('Upload-Metadata'));
    const transferId = meta.transferId?.trim();
    const filename = meta.filename?.trim() || 'unnamed';
    const relativePath = meta.relativePath?.trim() || filename;
    if (!transferId) {
      return this.error('Upload-Metadata 缺少 transferId', 400, origin);
    }

    const transfer = await this.index.getTransfer(transferId);
    if (!transfer) return this.error('传输不存在', 404, origin);
    if (await this.index.isExpired(transferId)) return this.error('传输已过期', 410, origin);

    const fileId = crypto.randomUUID();
    await this.index.addFile(transferId, {
      id: fileId,
      transferId,
      filename,
      relativePath,
      size,
      storage: this.storage.kind,
    });

    return new Response(null, {
      status: 201,
      headers: {
        ...corsHeaders(origin),
        ...tusHeaders(),
        Location: `/files/${fileId}`,
      },
    });
  }

  private async patchUpload(request: Request, fileId: string, origin: string | null): Promise<Response> {
    const offsetHeader = request.headers.get('Upload-Offset');
    if (offsetHeader === null) return this.error('缺少 Upload-Offset', 400, origin);
    const offset = Number(offsetHeader);
    if (!Number.isFinite(offset) || offset < 0) return this.error('Upload-Offset 无效', 400, origin);

    const contentType = request.headers.get('Content-Type');
    if (contentType !== 'application/offset+octet-stream') {
      return this.error('Content-Type 必须是 application/offset+octet-stream', 415, origin);
    }

    const file = await this.index.getFile(fileId);
    if (!file) return this.error('文件不存在', 404, origin);
    if (!file.transferId) return this.error('文件记录缺少 transferId', 500, origin);
    if (await this.index.isExpired(file.transferId)) return this.error('传输已过期', 410, origin);

    const currentOffset = await this.calcOffset(fileId);
    if (offset !== currentOffset) {
      return this.error(`Offset 不匹配：期望 ${currentOffset}，收到 ${offset}`, 409, origin);
    }

    const body = request.body;
    if (!body) return this.error('请求体为空', 400, origin);

    const contentLength = request.headers.get('Content-Length');
    const expectedLen = contentLength ? Number(contentLength) : undefined;
    if (expectedLen !== undefined && (!Number.isFinite(expectedLen) || expectedLen < 0)) {
      return this.error('Content-Length 无效', 400, origin);
    }

    let received = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const stream = body.pipeThrough(counter);

    const partKey = `${fileId}/part-${offset}`;
    try {
      await this.storage.put(partKey, stream, expectedLen ?? 0);
    } catch (e) {
      await this.storage.delete(partKey).catch(() => {});
      throw e;
    }

    if (expectedLen !== undefined && received !== expectedLen) {
      await this.storage.delete(partKey).catch(() => {});
      return this.error(`接收字节数 ${received} 与 Content-Length ${expectedLen} 不符`, 400, origin);
    }

    const newOffset = currentOffset + received;
    if (newOffset > file.size) {
      await this.storage.delete(partKey).catch(() => {});
      return this.error('上传大小超过声明的 Upload-Length', 400, origin);
    }

    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        ...tusHeaders(),
        'Upload-Offset': String(newOffset),
      },
    });
  }

  private async headUpload(fileId: string, origin: string | null): Promise<Response> {
    const file = await this.index.getFile(fileId);
    if (!file) return this.error('文件不存在', 404, origin);
    if (!file.transferId) return this.error('文件记录缺少 transferId', 500, origin);
    if (await this.index.isExpired(file.transferId)) return this.error('传输已过期', 410, origin);

    const offset = await this.calcOffset(fileId);
    return new Response(null, {
      status: 200,
      headers: {
        ...corsHeaders(origin),
        ...tusHeaders(),
        'Upload-Length': String(file.size),
        'Upload-Offset': String(offset),
      },
    });
  }

  private async deleteUpload(fileId: string, origin: string | null): Promise<Response> {
    const file = await this.index.getFile(fileId);
    if (!file) return this.error('文件不存在', 404, origin);

    const parts = await this.storage.list(`${fileId}/`);
    await Promise.all(parts.map((p) => this.storage.delete(p.key).catch(() => {})));

    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders(origin), ...tusHeaders() },
    });
  }

  private async calcOffset(fileId: string): Promise<number> {
    const parts = await this.storage.list(`${fileId}/`);
    return parts.reduce((sum, p) => sum + p.size, 0);
  }
}
