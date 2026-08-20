// 预签名直传控制面：浏览器绕过 Worker 的 request.body 大流 pipe，直接 PUT 密文到 R2。
// Worker 只做：校验文件归属 / 过期、签发 R2 presigned URL、commit 时二次确认 part 落盘。
// 根因：tus PATCH 把 80MiB 流穿过 CF 边缘 → Worker → FixedLengthStream → R2，大流在边缘流式透传
// 字节损坏（长度对、内容错），且错误被 .catch 吞掉 → 坏块静默入库 → 下载时 HMAC 才暴露。
// 直传 R2 后，数据不经 Worker 字节处理，R2 原生按 content-length 接收，损坏消失。

import { IndexBackend } from '../../src/transfer/tus/types';
import { QuotaGuard, QuotaUnavailableError } from './quota';
import { StorageResolver } from './storage-router';

interface PresignBody {
  fileId: string;
  offset: number;
  length: number;
}

export class PresignHandler {
  constructor(
    private readonly index: IndexBackend,
    private readonly quota: QuotaGuard,
    private readonly resolver: StorageResolver,
  ) {}

  private cors(origin: string | null): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Tus-Resumable, Upload-Metadata',
      'Access-Control-Max-Age': '86400',
    };
  }

  private json(data: unknown, status = 200, origin: string | null): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...this.cors(origin), 'Content-Type': 'application/json' },
    });
  }

  private async readBody<T>(request: Request): Promise<T | null> {
    try {
      return (await request.json()) as T;
    } catch {
      return null;
    }
  }

  private async options(origin: string | null): Promise<Response> {
    return new Response(null, { status: 204, headers: this.cors(origin) });
  }

  async handlePresign(request: Request, origin: string | null): Promise<Response> {
    if (request.method === 'OPTIONS') return this.options(origin);

    const body = await this.readBody<PresignBody>(request);
    if (
      !body ||
      typeof body.fileId !== 'string' ||
      typeof body.offset !== 'number' ||
      typeof body.length !== 'number'
    ) {
      return this.json({ error: '参数缺失' }, 400, origin);
    }

    const file = await this.index.getFile(body.fileId);
    if (!file) return this.json({ error: '文件不存在' }, 404, origin);
    if (!file.transferId) return this.json({ error: '文件记录缺少 transferId' }, 500, origin);
    if (await this.index.isExpired(file.transferId)) {
      return this.json({ error: '传输已过期' }, 410, origin);
    }
    if (body.offset < 0 || body.length <= 0 || body.offset + body.length > file.size) {
      return this.json({ error: 'offset/length 越界' }, 400, origin);
    }

    let accountId: string;
    try {
      accountId = await this.quota.accountOfTransfer(file.transferId);
    } catch (err) {
      if (err instanceof QuotaUnavailableError) {
        return this.json({ error: '系统初始化中，暂时无法上传，请稍后重试或联系站长' }, 503, origin);
      }
      throw err;
    }
    if (!(await this.quota.isEnabled(accountId))) {
      return this.json({ error: '存储桶已停用，上传已停止' }, 429, origin);
    }
    if (!(await this.quota.checkAllowed(accountId))) {
      return this.json({ error: '当前存储桶上传额度已用完（含未过期文件占用），请等待文件过期释放或联系站长' }, 429, origin);
    }
    const transfer = await this.index.getTransfer(file.transferId);
    let reserved: boolean;
    try {
      reserved = await this.quota.reserve({
        fileId: body.fileId,
        transferId: file.transferId,
        size: file.size,
        expiresAt: transfer?.expiresAt ?? 0,
      });
    } catch (err) {
      if (err instanceof QuotaUnavailableError) {
        return this.json({ error: '系统初始化中，暂时无法上传，请稍后重试或联系站长' }, 503, origin);
      }
      throw err;
    }
    if (!reserved) {
      return this.json({ error: '当前存储桶上传额度已用完（含未过期文件占用），请等待文件过期释放或联系站长' }, 429, origin);
    }

    const storage = await this.resolver.resolve(accountId);
    const key = `${body.fileId}/part-${body.offset}`;
    const url = await storage.createPresignedUrl(key, { method: 'PUT', expiresIn: 1200 });
    return this.json({ url, key }, 200, origin);
  }

  async handleCommit(request: Request, origin: string | null): Promise<Response> {
    if (request.method === 'OPTIONS') return this.options(origin);

    const body = await this.readBody<PresignBody>(request);
    if (
      !body ||
      typeof body.fileId !== 'string' ||
      typeof body.offset !== 'number' ||
      typeof body.length !== 'number'
    ) {
      return this.json({ error: '参数缺失' }, 400, origin);
    }

    const file = await this.index.getFile(body.fileId);
    if (!file) return this.json({ error: '文件不存在' }, 404, origin);
    if (!file.transferId) return this.json({ error: '文件记录缺少 transferId' }, 500, origin);
    if (await this.index.isExpired(file.transferId)) {
      return this.json({ error: '传输已过期' }, 410, origin);
    }
    const startOffset = body.offset - body.length;
    if (startOffset < 0) return this.json({ error: 'offset 非法' }, 400, origin);

    let accountId: string;
    try {
      accountId = await this.quota.accountOfTransfer(file.transferId);
    } catch (err) {
      if (err instanceof QuotaUnavailableError) {
        return this.json({ error: '系统初始化中，服务暂不可用，请稍后重试或联系站长' }, 503, origin);
      }
      throw err;
    }
    const storage = await this.resolver.resolve(accountId);
    const partKey = `${body.fileId}/part-${startOffset}`;
    // 二次保险：确认该 part 已落入 R2（presigned PUT 已校验 content-length，这里再确认存在）。
    if (!(await storage.exists(partKey))) {
      return this.json({ error: 'part 未确认落盘' }, 409, origin);
    }

    // 允许乱序并发：取 max，不回退。
    const current = file.offset ?? 0;
    const next = Math.max(current, body.offset);
    if (next > current) {
      await this.index.updateOffset(body.fileId, next);
    }
    return this.json({ offset: next }, 200, origin);
  }
}
