// 站长后台：内嵌 HTML 控制页 + 每桶配额/健康度/开关/自服务加桶接口。
// 全部挂在 Worker 上，控制台零外部依赖、零构建步骤。
// 凭据默认走仓库写法（见 storage-router），KV bucket_cfg 仅作覆盖层。
//
// ⚠️ 调试模式：已移除密码鉴权（用户要求）。上线前必须重新加回 X-Admin-Password 鉴权 +
//    quota:admin_password_hash 校验，否则任何人都能改桶配置/清零。

import type { IndexBackend } from '../../src/transfer/tus/types';
import { corsHeaders } from '../../src/transfer/tus/tus-protocol';
import type { QuotaGuard } from './quota';
import type { BucketSelector, StorageResolver } from './storage-router';

export interface AdminCtx {
  env: Record<string, unknown>;
  index: IndexBackend;
  quota: QuotaGuard;
  selector: BucketSelector;
  resolver: StorageResolver;
  kv: KVNamespace | undefined;
}

const PAGE_CSS = `
  :root{--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--muted:#8b949e;--red:#f85149;--green:#3fb950;--blue:#58a6ff;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,'Microsoft YaHei',sans-serif}
  .wrap{max-width:960px;margin:0 auto;padding:24px}
  h1{font-size:20px;margin:0 0 16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
  .row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
  .bar{height:10px;background:#21262d;border-radius:6px;overflow:hidden;margin:6px 0}
  .bar>span{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--green))}
  .bar.over>span{background:var(--red)}
  .muted{color:var(--muted)} .pill{padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
  .on{color:var(--green);border-color:var(--green)} .off{color:var(--muted)}
  input,button,select{background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:7px 10px;font-size:13px}
  button{cursor:pointer;background:#21262d} button:hover{border-color:var(--blue)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
  h2{font-size:15px;margin:0 0 10px}
  .banner{background:#3d2a00;border-color:#9e6a00;color:#f0b400}`;

function adminHtml(): string {
  const head = `<!doctype html><html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>中转站配额管理</title><style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>中转站配额管理 · 站长后台</h1>`;

  const body = `
  <div class="card banner"><strong>调试模式：</strong>已关闭密码鉴权。上线前需重新加回。</div>
  <div class="card"><div class="row" style="justify-content:space-between">
       <strong>存储桶看板</strong>
       <button onclick="load()">刷新</button>
     </div><p id="msg" class="muted"></p>
     <div id="buckets" class="grid"></div></div>
  <div class="card"><h2>新增 / 接入后端存储桶（自服务）</h2>
    <p class="muted">填入另一个 Cloudflare 账户(code)的 R2 桶信息。仓库写法下请同时在该 Worker 的 wrangler.toml 加 <code>R2_TRANSFERS_B</code> 绑定与 <code>*_B</code> 变量。</p>
    <div class="row">
      <input id="a_id" placeholder="account_id (如 secondary)"/>
      <input id="cf_code" placeholder="Cloudflare 账户 code"/>
      <input id="b_name" placeholder="R2 桶名"/>
      <input id="ak" placeholder="access_key_id"/>
      <input id="sk" placeholder="secret_access_key" type="password"/>
      <input id="lim" placeholder="上限字节(默认10737418240)" style="width:230px"/>
      <button onclick="addBucket()">接入</button>
    </div></div>
  <script>
  function api(p,b){return fetch('/api/admin/'+p,{method:b?'POST':'GET',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});}
  async function load(){
    var r=await api('status',null);
    if(!r.ok){document.getElementById('msg').textContent='加载失败: '+r.status;return;}
    var list=await r.json();
    if(!Array.isArray(list)||!list.length){document.getElementById('msg').textContent='无存储桶数据';return;}
    render(list);
  }
  function render(list){var el=document.getElementById('buckets');el.innerHTML='';
    for(var i=0;i<list.length;i++){var b=list[i];
      var pct=Math.min(100,Math.round(b.used_bytes/b.limit_bytes*100));var over=b.used_bytes>b.limit_bytes;
      var html='<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><strong>'+b.account_id+'</strong>'
        +'<span class="pill '+(b.enabled?'on':'off')+'">'+(b.enabled?'启用':'停用')+'</span></div>'
        +'<div class="muted">'+b.bucket_name+'</div>'
        +'<div class="bar '+(over?'over':'')+'"><span style="width:'+pct+'%"></span></div>'
        +'<div>已用 '+(b.used_bytes/1073741824).toFixed(2)+' GB / 上限 '+(b.limit_bytes/1073741824).toFixed(0)+' GB · 剩余 '+(b.remaining/1073741824).toFixed(2)+' GB</div>'
        +'<div class="muted">文件数 '+b.file_count+' · 健康 '+b.health.status+' · 凭证 '+(b.health.creds_valid?'有效':'无效')+'</div>'
        +'<div class="row" style="margin-top:8px">'
        +'<button onclick="toggle(\\x27'+b.account_id+'\\x27,'+!b.enabled+')">'+(b.enabled?'停用':'启用')+'</button>'
        +'<button onclick="recompute(\\x27'+b.account_id+'\\x27)">重算</button>'
        +'<button onclick="reset(\\x27'+b.account_id+'\\x27)">清零</button>'
        +'<button onclick="setLimit(\\x27'+b.account_id+'\\x27)">改上限</button>'
        +'<button onclick="check(\\x27'+b.account_id+'\\x27)">检查健康</button>'
        +'</div></div>';
      el.innerHTML+=html;}}
  async function toggle(id,en){await api('config',{account_id:id,enabled:en});load();}
  async function recompute(id){await api('recompute',{account_id:id});load();}
  async function reset(id){await api('reset',{account_id:id});load();}
  async function setLimit(id){var g=parseFloat(prompt('输入新的上限(GB)：'));if(!g>0)return;await api('config',{account_id:id,limit_bytes:Math.round(g*1073741824)});load();}
  async function check(id){var r=await api('buckets/check',{account_id:id});var j=await r.json();alert(JSON.stringify(j));load();}
  async function addBucket(){var body={account_id:document.getElementById('a_id').value,cf_code:document.getElementById('cf_code').value,bucket_name:document.getElementById('b_name').value,r2_access_key_id:document.getElementById('ak').value,r2_secret_access_key:document.getElementById('sk').value};
    var lim=document.getElementById('lim').value;if(lim)body.limit_bytes=Number(lim);
    var r=await api('buckets',body);if(r.ok){load();}else{var e=await r.json();alert('接入失败: '+(e.error||r.status));}}
  load();
  </script></body></html>`;
  return head + body;
}

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
  const list: string[] = listRaw ? (JSON.parse(listRaw) as string[]) : ['default'];
  if (!list.includes(body.account_id)) list.push(body.account_id);
  await ctx.kv.put('quota:buckets', JSON.stringify(list));
  return { ok: true };
}

async function checkBucket(ctx: AdminCtx, accountId: string): Promise<unknown> {
  try {
    const backend = await ctx.resolver.resolve(accountId);
    // 主动探测：list 一次（需 R2Bucket 绑定；纯跨账户无绑定时会抛错，属预期，见 storage-router TODO）
    await backend.list('');
    return { account_id: accountId, status: 'normal', last_check_ts: Date.now(), creds_valid: true, lifecycle_ok: true };
  } catch (e) {
    return {
      account_id: accountId,
      status: 'error',
      last_check_ts: Date.now(),
      creds_valid: false,
      lifecycle_ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
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
