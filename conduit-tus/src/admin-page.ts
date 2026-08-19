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
  .wrap{max-width:1080px;margin:0 auto;padding:28px 24px}
  @media (max-width: 768px){
    .wrap{max-width:100%;padding:16px}
  }
  h1{font-size:22px;margin:0 0 20px;font-weight:600}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px 24px;margin-bottom:16px}
  @media (max-width: 768px){
    .wrap{max-width:100%;padding:12px}
    .card{background:transparent;border:0;padding:0;margin-bottom:0}
  }
  .row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
  .muted{color:var(--muted)}
  .pill{padding:3px 12px;border-radius:999px;font-size:12px;border:1px solid var(--line);font-weight:500}
  .pill.on{color:var(--green);border-color:var(--green);background:rgba(63,185,80,.10)}
  .pill.off{color:var(--muted)}
  input,button,select{background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:9px 12px;font-size:13px;font-family:inherit}
  button{cursor:pointer;background:#21262d;transition:border-color .15s} button:hover{border-color:var(--blue)}
  button.primary{background:var(--blue);border-color:var(--blue);color:#0d1117;font-weight:600}
  h2{font-size:15px;margin:0 0 14px;font-weight:600}
  .banner{background:#3d2a00;border-color:#9e6a00;color:#f0b400;padding:14px 20px}

  .bucket{display:flex;gap:28px;padding:22px 26px;background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:12px;align-items:center}
  .bucket-info{flex:1;min-width:0}
  .bucket-actions{flex-shrink:0;display:flex;flex-direction:column;gap:8px;min-width:160px}
  @media (max-width: 768px){
    .bucket{flex-direction:column;align-items:stretch}
    .bucket-actions{flex-direction:row;gap:8px;min-width:0;width:100%}
    .bucket-actions button{flex:1;min-width:0}
  }
  .bucket-title{display:flex;align-items:center;gap:12px;margin-bottom:6px}
  .bucket-title strong{font-size:17px;font-weight:600}
  .bucket-sub{color:var(--muted);font-size:13px;margin-bottom:14px}
  .bucket-bar{height:8px;background:#21262d;border-radius:4px;overflow:hidden;margin:10px 0 8px}
  .bucket-bar>span{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--green));border-radius:4px;transition:width .3s}
  .bucket-bar.over>span{background:var(--red)}
  .bucket-stats{font-size:13px;line-height:1.9}
  .bucket-stats .sep{color:var(--muted);margin:0 6px}
  .bucket-health{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:var(--muted)}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0}
  .dot.ok{background:var(--green);box-shadow:0 0 8px rgba(63,185,80,.7)}
  .dot.bad{background:var(--red);box-shadow:0 0 8px rgba(248,81,73,.7)}
  .dot.unknown{background:var(--muted)}

  .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:8px}
  .form-grid input{width:100%}`;

function adminHtml(): string {
  const head = `<!doctype html><html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>中转站配额管理</title><style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>中转站配额管理 · 站长后台</h1>`;

  const body = `
  <div class="card banner"><strong>调试模式：</strong>已关闭密码鉴权。上线前需重新加回。</div>
  <div class="card"><div class="row" style="justify-content:space-between;margin-bottom:14px">
       <strong style="font-size:16px">存储桶看板</strong>
       <span class="muted" id="autocheckTip">自动检查：每小时一次</span>
     </div><p id="msg" class="muted"></p>
     <div id="buckets"></div></div>
  <div class="card"><h2>接入新桶（自服务）</h2>
    <p class="muted">填入另一个 Cloudflare 账户的 R2 桶信息。仓库写法下请同时在该 Worker 的 wrangler.toml 加 <code>R2_TRANSFERS_B</code> 绑定与 <code>*_B</code> 变量。</p>
    <div class="form-grid">
      <input id="a_id" placeholder="账户 ID（如 secondary）"/>
      <input id="cf_code" placeholder="Cloudflare 账户 code"/>
      <input id="b_name" placeholder="R2 桶名"/>
      <input id="ak" placeholder="Access Key ID"/>
      <input id="sk" placeholder="Secret Access Key" type="password"/>
      <input id="lim" placeholder="上限（GB，默认 10）"/>
    </div>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="primary" onclick="addBucket()">接入</button>
    </div></div>
  <script>
  function api(p,b){return fetch('/api/admin/'+p,{method:b?'POST':'GET',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});}
  function fmtTime(ts){
    var d=Date.now()-ts;
    if(d<60000) return '刚刚';
    if(d<3600000) return Math.floor(d/60000)+' 分钟前';
    if(d<86400000) return Math.floor(d/3600000)+' 小时前';
    return Math.floor(d/86400000)+' 天前';
  }
  async function load(){
    var r=await api('status',null);
    if(!r.ok){document.getElementById('msg').textContent='加载失败：'+r.status;return;}
    var list=await r.json();
    if(!Array.isArray(list)||!list.length){document.getElementById('msg').textContent='暂无存储桶数据';return;}
    render(list);
  }
  function render(list){
    var el=document.getElementById('buckets');el.innerHTML='';
    for(var i=0;i<list.length;i++){
      var b=list[i];
      var pct=Math.min(100,Math.round(b.used_bytes/b.limit_bytes*100));
      var over=b.used_bytes>b.limit_bytes;
      var checked=b.health.last_check_ts>0;
      var healthy=checked && b.health.creds_valid && b.health.lifecycle_ok;
      var dot=!checked?'unknown':(healthy?'ok':'bad');
      var ht=!checked?'尚未检查':(healthy?'健康':'异常');
      var usedGB=(b.used_bytes/1073741824).toFixed(2);
      var limitGB=(b.limit_bytes/1073741824).toFixed(0);
      var remGB=(b.remaining/1073741824).toFixed(2);
      var id=b.account_id;
      var btnToggle=b.enabled?'停用':'启用';
      var pillCls=b.enabled?'on':'off';
      var pillTxt=b.enabled?'已启用':'已停用';
      var html='<div class="bucket">'
        +'<div class="bucket-info">'
          +'<div class="bucket-title"><strong>'+id+'</strong><span class="pill '+pillCls+'">'+pillTxt+'</span></div>'
          +'<div class="bucket-sub">R2 桶名：'+b.bucket_name+'</div>'
          +'<div class="bucket-bar'+(over?' over':'')+'"><span style="width:'+pct+'%"></span></div>'
          +'<div class="bucket-stats">已用 <strong>'+usedGB+'</strong> GB<span class="sep">/</span>上限 '+limitGB+' GB<span class="sep">·</span>剩余 '+remGB+' GB<span class="sep">·</span>使用率 '+pct+'%</div>'
          +'<div class="bucket-health"><span class="dot '+dot+'"></span><span>'+ht+'</span>'
            +(checked?'<span class="sep">·</span><span>检查于 '+fmtTime(b.health.last_check_ts)+'</span>':'')
            +'<span class="sep">·</span><span>在用文件 '+b.file_count+' 个</span></div>'
        +'</div>'
        +'<div class="bucket-actions">'
          +'<button onclick="toggle(\\x27'+id+'\\x27,'+!b.enabled+')">'+btnToggle+'</button>'
          +'<button onclick="setLimit(\\x27'+id+'\\x27,'+limitGB+')">改上限（'+limitGB+' GB）</button>'
          +'<button class="primary" onclick="check(\\x27'+id+'\\x27)">检查健康</button>'
        +'</div></div>';
      el.innerHTML+=html;
    }
  }
  async function toggle(id,en){await api('config',{account_id:id,enabled:en});load();}
  async function setLimit(id,currentGB){
    var g=parseFloat(prompt('新的上限（GB），当前 '+currentGB+' GB：', currentGB));
    if(!g||g<=0) return;
    await api('config',{account_id:id,limit_bytes:Math.round(g*1073741824)});
    load();
  }
  async function check(id){
    var r=await api('buckets/check',{account_id:id});
    var j=await r.json();
    if(j.creds_valid && j.lifecycle_ok){ alert('✅ 健康'); }
    else{ alert('❌ 不健康'+(j.error?'\\n\\n原因：'+j.error:'')); }
    load();
  }
  async function autoCheckAll(){
    try{
      var r=await fetch('/api/admin/buckets',{method:'GET'});
      if(!r.ok) return;
      var list=await r.json();
      if(!Array.isArray(list)) return;
      for(var i=0;i<list.length;i++){
        await fetch('/api/admin/buckets/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:list[i].account_id})});
      }
      load();
    }catch(e){}
  }
  async function addBucket(){
    var body={account_id:document.getElementById('a_id').value,cf_code:document.getElementById('cf_code').value,bucket_name:document.getElementById('b_name').value,r2_access_key_id:document.getElementById('ak').value,r2_secret_access_key:document.getElementById('sk').value};
    var lim=document.getElementById('lim').value;var gb=parseFloat(lim);if(gb>0)body.limit_bytes=Math.round(gb*1073741824);
    var r=await api('buckets',body);
    if(r.ok){load();}else{var e=await r.json();alert('接入失败：'+(e.error||r.status));}
  }
  load();
  autoCheckAll();
  setInterval(autoCheckAll, 3600000);
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
