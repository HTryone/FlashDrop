// 中转业务 API：创建传输 / 按分享码查询。
// 与 server.mjs 的 /api/transfers、/api/transfer/:code 行为对齐。

import { IndexBackend, TransferRecord, TransferError } from './types';
import { corsHeaders } from './tus-protocol';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 排除 0/O/1/I
const LOGIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz'; // 排除 0/O/1/I/l/o

function genCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

function genLoginCodeRaw(): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += LOGIN_ALPHABET[Math.floor(Math.random() * LOGIN_ALPHABET.length)];
  return s;
}

function formatLoginCode(raw: string): string {
  if (!raw || raw.length !== 16) return raw;
  return `${raw.slice(0, 4)} ${raw.slice(4, 8)} ${raw.slice(8, 12)} ${raw.slice(12, 16)}`;
}

function json(body: unknown, status = 200, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

export class TransferHandler {
  constructor(
    private readonly index: IndexBackend,
    private readonly defaultTtlHours = 24,
  ) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === '/api/transfers' && request.method === 'POST') {
        return await this.createTransfer(request, origin);
      }
      if (url.pathname.startsWith('/api/transfer/') && request.method === 'GET') {
        const code = decodeURIComponent(url.pathname.slice('/api/transfer/'.length));
        return await this.getTransferByCode(code, origin);
      }
      return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });
    } catch (e) {
      return this.errorFrom(e, origin);
    }
  }

  private async createTransfer(request: Request, origin: string | null): Promise<Response> {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // 允许空 body
    }

    const transferId =
      typeof body.transferId === 'string' && body.transferId.trim()
        ? body.transferId.trim()
        : `t_${crypto.randomUUID().replace(/-/g, '')}`;
    const message = typeof body.message === 'string' ? body.message : '';
    const ttlHours =
      typeof body.ttlHours === 'number' && body.ttlHours > 0
        ? body.ttlHours
        : this.defaultTtlHours;
    const e2ee =
      body.e2ee && typeof body.e2ee === 'object'
        ? {
            salt: String((body.e2ee as Record<string, unknown>).salt ?? ''),
            chunkSize: Number((body.e2ee as Record<string, unknown>).chunkSize ?? 0),
          }
        : null;

    const now = Date.now();
    const t: TransferRecord = {
      id: transferId,
      message,
      createdAt: now,
      expiresAt: now + ttlHours * 3600 * 1000,
      terminated: false,
      code: '',
      loginCode: '',
      e2ee,
      files: [],
    };

    // 生成唯一分享码
    let code = genCode();
    while (await this.index.resolveCode(code)) {
      code = genCode();
    }

    // 生成唯一登录码
    let loginCodeRaw = genLoginCodeRaw();
    while (await this.index.resolveLogin(loginCodeRaw)) {
      loginCodeRaw = genLoginCodeRaw();
    }

    t.code = code;
    t.loginCode = loginCodeRaw;

    await this.index.createTransfer(t);

    return json(
      {
        transferId,
        code,
        loginCode: formatLoginCode(loginCodeRaw),
        expiresAt: t.expiresAt,
        storage: 'r2',
        e2ee,
      },
      200,
      origin,
    );
  }

  private async getTransferByCode(code: string, origin: string | null): Promise<Response> {
    const transferId = await this.index.resolveCode(code);
    if (!transferId) return json({ error: '未找到，可能还在上传或链接有误' }, 404, origin);

    const t = await this.index.getTransfer(transferId);
    if (!t) return json({ error: '未找到，可能还在上传或链接有误' }, 404, origin);
    if (await this.index.isExpired(transferId)) {
      return json({ error: '传输已过期或已终止' }, 410, origin);
    }

    return json(
      {
        transferId: t.id,
        message: t.message || '',
        storage: 'r2',
        e2ee: t.e2ee,
        expiresAt: t.expiresAt,
        files: t.files.map((f) => ({ id: f.id, name: f.relativePath, size: f.size })),
      },
      200,
      origin,
    );
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
      return json({ error: e.message }, statusMap[e.code] ?? 500, origin);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500, origin);
  }
}
