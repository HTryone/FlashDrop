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

export interface AdminCtx {
  env: Record<string, unknown>;
  index: IndexBackend;
  quota: QuotaGuard;
  selector: BucketSelector;
  resolver: StorageResolver;
  kv: KVNamespace | undefined;
}

const PAGE_CSS = `
  :root{
    --bg:#14193b;
    --card:rgba(99,102,241,.08);
    --line:rgba(129,140,248,.18);
    --fg:#e5e9f5;
    --muted:#9ba6c2;
    --red:#ff8b7e;
    --green:#22e07b;
    --blue:#7aa2ff;
    --amber:#f0c36d;
  }
  *{box-sizing:border-box}
  body{margin:0;color:var(--fg);font:14px/1.6 system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
    background:
      radial-gradient(1100px 520px at 12% -8%, rgba(122,140,255,.16), transparent 60%),
      radial-gradient(900px 480px at 108% 18%, rgba(122,140,255,.08), transparent 60%),
      radial-gradient(700px 420px at 50% 110%, rgba(99,102,241,.10), transparent 60%),
      var(--bg);
    background-attachment:fixed}
  .wrap{max-width:1080px;margin:0 auto;padding:28px 24px}
  h1{font-size:24px;margin:0 0 20px;font-weight:600}
  h2{font-weight:500;position:relative;padding-left:12px;display:flex;align-items:center;min-height:22px;font-size:16px}
  h2::before{content:'';position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:18px;border-radius:3px;background:linear-gradient(180deg,#7aa2ff,#5b6cff);box-shadow:0 0 8px rgba(122,162,255,.35)}
  .card{background:rgba(99,102,241,.09);border:1px solid rgba(129,140,248,.18);border-radius:14px;padding:20px 24px;margin-bottom:16px;backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);box-shadow:0 10px 34px rgba(8,10,30,.5)}
  .row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
  .muted{color:var(--muted)}
  .pill{padding:3px 12px;border-radius:999px;font-size:12px;border:1px solid var(--line);font-weight:500}
  .pill.on{color:var(--green);border-color:rgba(61,220,151,.5);background:rgba(61,220,151,.10)}
  .pill.off{color:var(--muted)}
  input,button,select{font-family:inherit;font-size:13px}
  input{background:rgba(13,16,40,.62);color:var(--fg);border:1px solid rgba(129,140,248,.15);border-radius:10px;padding:11px 12px;transition:border-color .2s,box-shadow .2s,background .2s}
  input:hover{border-color:rgba(150,165,255,.28)}
  input:focus{outline:none;border-color:var(--blue);background:rgba(13,16,40,.8);box-shadow:0 0 0 3px rgba(122,162,255,.16)}
  input::placeholder{color:#6d7799}
  button{cursor:pointer;background:rgba(99,102,241,.12);color:var(--fg);border:1px solid rgba(129,140,248,.22);border-radius:10px;padding:11px 14px;transition:background .2s,border-color .2s,transform .1s,box-shadow .2s}
  button:hover{background:rgba(129,140,248,.2);border-color:rgba(150,165,255,.34)}
  button:active{transform:scale(.97)}
  button.primary{background:linear-gradient(135deg,#7c8bff,#5b6cff);border-color:transparent;color:#fff;font-weight:700;box-shadow:0 6px 18px rgba(91,108,255,.4)}
  button.primary:hover{filter:brightness(1.1)}
  .banner{background:rgba(240,195,109,.08);border-color:rgba(240,195,109,.35);border-left:3px solid var(--amber);color:var(--amber);padding:14px 20px}

  .bucket{display:flex;flex-direction:column;align-items:stretch;background:rgba(99,102,241,.10);border:1px solid rgba(129,140,248,.2);border-radius:14px;padding:22px 26px;margin-bottom:12px;backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);box-shadow:0 8px 30px rgba(8,10,30,.5);transition:transform .22s ease,box-shadow .22s ease,border-color .22s ease;animation:cardIn .45s ease both}
  .bucket:hover{transform:translateY(-2px);border-color:rgba(150,165,255,.34);box-shadow:0 14px 40px rgba(8,10,30,.6)}
  @keyframes cardIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  .bucket-info{flex:1;min-width:0}
  .bucket-actions{flex:none;min-width:0;width:100%;display:flex;flex-direction:row;flex-wrap:wrap;gap:8px;margin-top:14px}
  .bucket-actions button{flex:1 0 calc((100% - 16px) / 3);min-width:0;padding:12px 8px;font-size:15px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .2s,transform .1s,border-color .2s,box-shadow .2s}
  .bucket-actions button:hover{background:rgba(255,255,255,.1);border-color:rgba(180,190,255,.3);box-shadow:0 4px 12px rgba(0,0,0,.25)}
  .bucket-actions button:active{transform:scale(.96)}
  .bucket-actions .danger{color:var(--red);border-color:rgba(255,139,126,.4);background:transparent}
  .bucket-actions .danger:hover{background:rgba(255,139,126,.12);border-color:rgba(255,139,126,.55)}
  .bucket-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
  .bucket-title{display:flex;align-items:center;gap:12px}
  .bucket-title strong{font-size:20px;font-weight:700}
  .bucket-sub{color:var(--muted);font-size:13px;margin:4px 0 6px}
  .bucket-limit{padding:3px 12px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap;border:1px solid;transition:color .4s ease,border-color .4s ease,background .4s ease}
  .bucket-bar{height:8px;background:rgba(129,140,248,.16);border-radius:4px;overflow:hidden;margin:10px 0 8px}
  .bucket-bar>span{display:block;height:100%;background:linear-gradient(90deg,#22e07b 0%,#f0c36d 60%,#ff8b7e 100%);border-radius:4px;transition:width .4s ease}
  .bucket-bar.over>span{background:var(--red)}
  .bucket-stats{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:13px}
  .bucket-stats .stats-right{color:var(--fg)}
  .bucket-health{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:var(--fg);flex-wrap:wrap}
  .bucket-health .sep{color:var(--muted);margin:0 4px}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0}
  .dot.ok{background:var(--green);box-shadow:0 0 8px rgba(61,220,151,.7)}
  .dot.bad{background:var(--red);box-shadow:0 0 8px rgba(255,139,126,.7)}
  .dot.unknown{background:var(--muted)}

  .form-grid{display:grid;grid-template-columns:1fr;gap:14px;margin-top:14px}
  .field{display:flex;flex-direction:column;gap:8px}
  .field label{font-size:15px;color:#d6ddf2;font-weight:500;letter-spacing:.3px}
  .field input{width:100%}
  .card p.muted{padding:4px 0 2px;line-height:1.7}

  @media (max-width: 799px){
    .wrap{max-width:100%;padding:24px 14px calc(40px + env(safe-area-inset-bottom))}
    .card{background:transparent;border:0;padding:0;margin-bottom:0;backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:none}
    body{font-size:15px}
  }
  @media (min-width: 800px){
    .form-grid{grid-template-columns:1fr 1fr}
    body{font-size:16px}
    h1{font-size:24px}
    h2{font-size:18px}
    input,button,select{font-size:15px}
    .bucket-actions button{flex:1;font-size:17px;padding:13px 10px}
    .bucket-stats{font-size:15px}
    .bucket-sub,.bucket-health{font-size:14px}
    .pill{font-size:13px}
    .bucket-actions{flex-wrap:nowrap}
  }`;

function adminHtml(): string {
  const head = `<!doctype html><html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
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
      <div class="field"><label for="a_id">内部标识</label><input id="a_id" placeholder="自命名，如 secondary / client-acme"/></div>
      <div class="field"><label for="cf_code">R2 账户 ID</label><input id="cf_code" placeholder="控制台 URL 里的十六进制串"/></div>
      <div class="field"><label for="b_name">R2 桶名</label><input id="b_name" placeholder="如 flashdrop-transfers"/></div>
      <div class="field"><label for="ak">访问密钥 ID</label><input id="ak" placeholder="CF → R2 → 管理 R2 API 令牌页"/></div>
      <div class="field"><label for="sk">机密访问密钥</label><input id="sk" placeholder="同上令牌页" type="password"/></div>
      <div class="field"><label for="lim">配额上限（GB）</label><input id="lim" placeholder="默认 10"/></div>
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
      // 上限胶囊：整体颜色随使用率 绿→琥珀→红（线性插值），纯色背景
      function limitRgb(p){
        var r,g,b;
        if(p<=50){var t=p/50;r=34+(240-34)*t;g=224+(195-224)*t;b=123+(109-123)*t;}
        else{var t=(p-50)/50;r=240+(255-240)*t;g=195+(139-195)*t;b=109+(126-109)*t;}
        return Math.round(r)+','+Math.round(g)+','+Math.round(b);
      }
      var limC=over?'255,68,56':limitRgb(pct);
      var limStyle='color:rgb('+limC+');border-color:rgba('+limC+',.5);background:rgba('+limC+',.10)';
      var html='<div class="bucket">'
        +'<div class="bucket-info">'
          +'<div class="bucket-head"><div class="bucket-title"><strong>'+id+'</strong><span class="pill '+pillCls+'">'+pillTxt+'</span></div><span class="bucket-limit" style="'+limStyle+'">上限 '+limitGB+' GB</span></div>'
          +'<div class="bucket-sub">R2 桶名：'+b.bucket_name+'</div>'
          +'<div class="bucket-bar'+(over?' over':'')+'"><span style="width:'+pct+'%"></span></div>'
          +'<div class="bucket-stats"><span class="stats-left">已用 '+usedGB+' GB / 剩余 '+remGB+' GB</span><span class="stats-right">使用率 '+pct+'%</span></div>'
          +'<div class="bucket-health"><span class="dot '+dot+'"></span><span>'+ht+'</span>'
            +(checked?'<span class="sep">·</span><span>检查于 '+fmtTime(b.health.last_check_ts)+'</span>':'')
            +'<span class="sep">·</span><span>在用文件 '+b.file_count+' 个</span></div>'
        +'</div>'
        +'<div class="bucket-actions">'
          +'<button onclick="toggle(\\x27'+id+'\\x27,'+!b.enabled+')">'+btnToggle+'</button>'
          +'<button onclick="setLimit(\\x27'+id+'\\x27,'+limitGB+')">改上限</button>'
          +'<button onclick="check(\\x27'+id+'\\x27)">检查健康</button>'
          +'<button onclick="editBucket(\\x27'+id+'\\x27)">编辑</button>'
          +'<button class="danger" onclick="deleteBucket(\\x27'+id+'\\x27)">删除</button>'
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
  async function editBucket(id){
    var name=prompt('新的 R2 桶名（当前配置将覆盖）：');
    if(name===null||!name.trim()) return;
    await api('buckets/update',{account_id:id,bucket_name:name.trim()});
    var g=parseFloat(prompt('新的上限（GB）：'));
    if(g&&g>0) await api('buckets/update',{account_id:id,limit_bytes:Math.round(g*1073741824)});
    load();
  }
  async function deleteBucket(id){
    if(!confirm('确定删除桶「'+id+'」？将移除其 KV 配置。')) return;
    var r=await api('buckets/remove',{account_id:id});
    var j=await r.json();
    if(!j.ok) alert('删除失败：'+(j.error||r.status));
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
  const list: string[] = listRaw ? (JSON.parse(listRaw) as string[]) : [];
  if (!list.includes(body.account_id)) list.push(body.account_id);
  await ctx.kv.put('quota:buckets', JSON.stringify(list));
  return { ok: true };
}

// 编辑桶：改 R2 桶名 / 上限（KV bucket_cfg + limit_bytes），不动密钥。
async function updateBucket(
  ctx: AdminCtx,
  body: { account_id: string; bucket_name?: string; limit_bytes?: number },
): Promise<unknown> {
  if (!ctx.kv) return { ok: false, error: 'KV 未配置' };
  if (!body.account_id) return { ok: false, error: '缺少 account_id' };
  if (body.bucket_name) {
    const cfgRaw = await ctx.kv.get(`quota:${body.account_id}:bucket_cfg`);
    if (cfgRaw) {
      const cfg = JSON.parse(cfgRaw) as { bucketName?: string };
      cfg.bucketName = body.bucket_name;
      await ctx.kv.put(`quota:${body.account_id}:bucket_cfg`, JSON.stringify(cfg));
    }
  }
  if (typeof body.limit_bytes === 'number')
    await ctx.kv.put(`quota:${body.account_id}:limit_bytes`, String(body.limit_bytes));
  return { ok: true };
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

    if (api === 'buckets/update' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        account_id: string;
        bucket_name?: string;
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
