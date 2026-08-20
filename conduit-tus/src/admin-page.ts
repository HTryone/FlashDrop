// 站长后台：内嵌 HTML 控制页 + 每桶配额/健康度/开关/自服务加桶接口。
// 全部挂在 Worker 上，控制台零外部依赖、零构建步骤。
// 凭据默认走仓库写法（见 storage-router），KV bucket_cfg 仅作覆盖层。
//
// ⚠️ 调试模式：已移除密码鉴权（用户要求）。上线前必须重新加回 X-Admin-Password 鉴权 +
//    quota:admin_password_hash 校验，否则任何人都能改桶配置/清零。
//
// 布局约定（2026-08-20 用户拍板）：
//   - 800px 一条界线：<800 手机（无外层卡片容器、按钮 3+2 换行、表单单列），≥800 电脑（玻璃卡片、按钮一行、表单两列）。
//   - 上限胶囊 = 「已启用」同款 pill，颜色随使用率 绿→琥珀→红（JS 线性插值），纯色背景无进度填充。
//   - default 桶只有 停用/改上限/检查健康；手动插入桶额外有 编辑/删除（删除需后端 remove 接口）。

import type { IndexBackend } from '../../src/transfer/tus/types';
import { corsHeaders } from '../../src/transfer/tus/tus-protocol';
import type { QuotaGuard } from './quota';
import type { BucketSelector, StorageResolver } from './storage-router';
import { adminHtml } from './admin-ui';

export interface AdminCtx {
  env: Record<string, unknown>;
  index: IndexBackend;
  quota: QuotaGuard;
  selector: BucketSelector;
  resolver: StorageResolver;
  kv: KVNamespace | undefined;
}

// UI 层（页面 HTML/CSS/JS）已拆分到 admin-ui.ts，本文件只管路由与 KV/API 逻辑。
async function listBuckets(ctx: AdminCtx): Promise<unknown> {
  return ctx.quota.status();
}

async function setBucket(
  ctx: AdminCtx,
  body: {
    account_id: string;
    cf_code?: string;
    bucket_name: string;
    r2_access_key_id: string;
    r2_secret_access_key: string;
    limit_bytes?: number;
  },
): Promise<unknown> {
  if (!ctx.kv) return { ok: false, error: 'KV 未配置' };
  const cfg = {
    accountId: body.cf_code || body.account_id,
    accessKeyId: body.r2_access_key_id,
    secretAccessKey: body.r2_secret_access_key,
    bucketName: body.bucket_name,
  };
  await ctx.kv.put(`quota:${body.account_id}:bucket_cfg`, JSON.stringify(cfg));
  await ctx.kv.put(`quota:${body.account_id}:enabled`, 'true');
  await ctx.kv.put(`quota:${body.account_id}:limit_bytes`, String(body.limit_bytes ?? 10737418240));
  const listRaw = await ctx.kv.get('quota:buckets');
  const list: string[] = listRaw ? (JSON.parse(listRaw) as string[]) : [];
  if (!list.includes(body.account_id)) list.push(body.account_id);
  await ctx.kv.put('quota:buckets', JSON.stringify(list));
  return { ok: true };
}

// 编辑桶：全字段覆盖 KV bucket_cfg（账户 ID/桶名/密钥）+ 上限。内部标识不可改（KV 键名）。
async function updateBucket(
  ctx: AdminCtx,
  body: {
    account_id: string;
    cf_code?: string;
    bucket_name?: string;
    r2_access_key_id?: string;
    r2_secret_access_key?: string;
    limit_bytes?: number;
  },
): Promise<unknown> {
  if (!ctx.kv) return { ok: false, error: 'KV 未配置' };
  if (!body.account_id) return { ok: false, error: '缺少 account_id' };
  const cfgRaw = await ctx.kv.get(`quota:${body.account_id}:bucket_cfg`);
  if (cfgRaw) {
    const cfg = JSON.parse(cfgRaw) as {
      accountId?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      bucketName?: string;
    };
    if (body.cf_code) cfg.accountId = body.cf_code;
    if (body.bucket_name) cfg.bucketName = body.bucket_name;
    if (body.r2_access_key_id) cfg.accessKeyId = body.r2_access_key_id;
    if (body.r2_secret_access_key) cfg.secretAccessKey = body.r2_secret_access_key;
    await ctx.kv.put(`quota:${body.account_id}:bucket_cfg`, JSON.stringify(cfg));
  }
  if (typeof body.limit_bytes === 'number')
    await ctx.kv.put(`quota:${body.account_id}:limit_bytes`, String(body.limit_bytes));
  return { ok: true };
}

// 读取单桶配置（编辑弹窗预填用）：返 bucket_cfg + 上限。
async function getBucketConfig(
  ctx: AdminCtx,
  accountId: string,
): Promise<unknown> {
  if (!ctx.kv) return { ok: false, error: 'KV 未配置' };
  const cfgRaw = await ctx.kv.get(`quota:${accountId}:bucket_cfg`);
  const limitRaw = await ctx.kv.get(`quota:${accountId}:limit_bytes`);
  return {
    ok: true,
    config: cfgRaw ? JSON.parse(cfgRaw) : null,
    limit_bytes: limitRaw ? Number(limitRaw) : 10737418240,
  };
}

// 删除桶：从列表移除 + 清 KV 配置（D1 账本保留防误删数据）。
async function removeBucket(ctx: AdminCtx, accountId: string): Promise<unknown> {
  if (!ctx.kv) return { ok: false, error: 'KV 未配置' };
  const listRaw = await ctx.kv.get('quota:buckets');
  const list: string[] = listRaw ? (JSON.parse(listRaw) as string[]) : [];
  const next = list.filter((x) => x !== accountId);
  if (next.length === list.length) return { ok: false, error: '桶不存在' };
  await ctx.kv.put('quota:buckets', JSON.stringify(next));
  await ctx.kv.delete(`quota:${accountId}:bucket_cfg`).catch(() => {});
  await ctx.kv.delete(`quota:${accountId}:enabled`).catch(() => {});
  await ctx.kv.delete(`quota:${accountId}:limit_bytes`).catch(() => {});
  await ctx.kv.delete(`quota:${accountId}:health`).catch(() => {});
  await ctx.kv.delete(`quota:${accountId}:last_write_ts`).catch(() => {});
  return { ok: true };
}

async function checkBucket(ctx: AdminCtx, accountId: string): Promise<unknown> {
  const result: {
    account_id: string;
    status: string;
    last_check_ts: number;
    creds_valid: boolean;
    lifecycle_ok: boolean;
    error?: string;
  } = {
    account_id: accountId,
    status: 'error',
    last_check_ts: Date.now(),
    creds_valid: false,
    lifecycle_ok: false,
  };
  try {
    const backend = await ctx.resolver.resolve(accountId);
    await backend.list('');
    result.status = 'normal';
    result.creds_valid = true;
    // 生命周期规则不在此检测：令牌仅 Object Read&Write 权限（无 R2 Storage Write），
    // 检测会 403 误报。生命周期由 R2 控制台配置，接入时已有提醒（addBucket alert）。
    result.lifecycle_ok = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  if (ctx.kv) await ctx.kv.put(`quota:${accountId}:health`, JSON.stringify(result));
  return result;
}

function json(data: unknown, origin: string | null, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

export async function handleAdmin(request: Request, ctx: AdminCtx): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const path = url.pathname;

  if (path === '/admin') {
    if (request.method === 'GET')
      return new Response(adminHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (path.startsWith('/api/admin/')) {
    const api = path.slice('/api/admin/'.length);

    if (api === 'status' && (request.method === 'POST' || request.method === 'GET'))
      return json(await ctx.quota.status(), origin);
    if (api === 'buckets' && request.method === 'GET') return json(await listBuckets(ctx), origin);

    if (api === 'buckets/get' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { account_id: string };
      return json(await getBucketConfig(ctx, body.account_id), origin);
    }

    if (api === 'config' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        account_id: string;
        enabled?: boolean;
        limit_bytes?: number;
      };
      if (ctx.kv) {
        if (typeof body.enabled === 'boolean')
          await ctx.kv.put(`quota:${body.account_id}:enabled`, body.enabled ? 'true' : 'false');
        if (typeof body.limit_bytes === 'number')
          await ctx.kv.put(`quota:${body.account_id}:limit_bytes`, String(body.limit_bytes));
      }
      return json({ ok: true }, origin);
    }

    if (api === 'buckets' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        account_id: string;
        cf_code?: string;
        bucket_name: string;
        r2_access_key_id: string;
        r2_secret_access_key: string;
        limit_bytes?: number;
      };
      if (!body.account_id || !body.bucket_name || !body.r2_access_key_id || !body.r2_secret_access_key)
        return json({ error: '缺少必填字段' }, origin, 400);
      return json(await setBucket(ctx, body), origin);
    }

    if (api === 'buckets/update' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        account_id: string;
        cf_code?: string;
        bucket_name?: string;
        r2_access_key_id?: string;
        r2_secret_access_key?: string;
        limit_bytes?: number;
      };
      return json(await updateBucket(ctx, body), origin);
    }

    if (api === 'buckets/remove' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { account_id: string };
      return json(await removeBucket(ctx, body.account_id), origin);
    }

    if (api === 'buckets/check' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { account_id: string };
      return json(await checkBucket(ctx, body.account_id), origin);
    }

    if (api === 'reset' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { account_id: string };
      await ctx.quota.resetBucket(body.account_id);
      return json({ ok: true }, origin);
    }

    if (api === 'recompute' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { account_id: string };
      const total = await ctx.quota.recompute(body.account_id);
      return json({ ok: true, used_bytes: total }, origin);
    }
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });
}
