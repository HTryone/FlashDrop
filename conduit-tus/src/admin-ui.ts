// 站长后台 UI 层：纯页面生成（HTML + 前端 JS），零业务逻辑。
// 与 admin-page.ts（路由/API 逻辑）分离；样式独立于 admin-styles.ts。
// 编辑弹窗：玻璃拟态（backdrop-filter blur+saturate + 高光边），打开时从 KV 读当前配置预填。
import { PAGE_CSS } from './admin-styles';

export function adminHtml(): string {
  const head = `<!doctype html><html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>中转站配额管理</title><style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>中转站配额管理 · 站长后台</h1>`;

  const body = `
  <div class="card banner"><strong>调试模式：</strong>已关闭密码鉴权。上线前需重新加回。</div>
  <div class="card"><div class="row" style="justify-content:space-between;margin-bottom:14px">
       <strong style="font-size:16px">存储桶看板</strong>
       <span class="muted" id="autocheckTip">打开时自动检查</span>
     </div><p id="msg" class="muted"></p>
     <div id="buckets"></div></div>
  <div class="card"><h2>接入新桶（自服务）</h2>
    <p class="muted">填入另一个 Cloudflare 账户的 R2 桶信息（R2 → 管理 R2 API 令牌 页创建令牌获取密钥）。保存后写入 KV 桶配置，无需 wrangler.toml 绑定。</p>
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

  <!-- 编辑弹窗（玻璃拟态）：打开时从 KV 读当前配置预填 -->
  <div class="modal-mask" id="editMask" onclick="if(event.target===this)closeEdit()">
    <div class="modal" role="dialog" aria-modal="true" aria-label="编辑桶配置">
      <h3 id="editTitle">编辑桶配置</h3>
      <p class="sub" id="editSub"></p>
      <div class="form-grid">
        <div class="field"><label>内部标识</label><input id="e_id" disabled/></div>
        <div class="field"><label for="e_cf">R2 账户 ID</label><input id="e_cf" placeholder="控制台 URL 里的十六进制串"/></div>
        <div class="field"><label for="e_bn">R2 桶名</label><input id="e_bn" placeholder="如 flashdrop-transfers"/></div>
        <div class="field"><label for="e_ak">访问密钥 ID</label><input id="e_ak" placeholder="CF → R2 → 管理 R2 API 令牌页"/></div>
        <div class="field"><label for="e_sk">机密访问密钥</label><input id="e_sk" placeholder="同上令牌页" type="password"/></div>
        <div class="field"><label for="e_lim">配额上限（GB）</label><input id="e_lim" placeholder="默认 10"/></div>
      </div>
      <div class="actions">
        <button onclick="closeEdit()">取消</button>
        <button class="primary" onclick="saveEdit()">确定</button>
      </div>
    </div>
  </div>

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
    var r;
    try { r = await api('status',null); } catch (e) { document.getElementById('msg').textContent='网络错误：'+(e.message||e); return; }
    if(!r.ok){document.getElementById('msg').textContent='加载失败：'+r.status;return;}
    var list;
    try { list = await r.json(); }
    catch (e) { document.getElementById('msg').textContent='解析响应失败：'+(e.message||e); return; }
    if(!Array.isArray(list)||!list.length){document.getElementById('msg').textContent='暂无存储桶数据';return;}
    render(list);
  }
  function render(list){
    var el=document.getElementById('buckets');el.innerHTML='';
    var firstRender=(typeof window.__firstRender==='undefined')||window.__firstRender;
    for(var i=0;i<list.length;i++){
      var b=list[i];
      var pct=Math.min(100,Math.round(b.used_bytes/b.limit_bytes*100));
      var over=b.used_bytes>b.limit_bytes;
      var checked=b.health.last_check_ts>0;
      var healthy=checked && b.health.creds_valid && b.health.lifecycle_ok;
      var dot=!checked?'unknown':(healthy?'ok':'bad');
      var ht=!checked?'尚未检查':(healthy?'健康':'异常');
      var errTxt=(b.health.error||'')?'：'+(b.health.error||''):'';
      var usedGB=(b.used_bytes/1073741824).toFixed(2);
      var limitGB=(b.limit_bytes/1073741824).toFixed(0);
      var remGB=(b.remaining/1073741824).toFixed(2);
      var id=b.account_id;
      var btnToggle=b.enabled?'停用':'启用';
      var pillCls=b.enabled?'on':'off';
      var pillTxt=b.enabled?'已启用':'已停用';
      function limitRgb(p){
        var r,g,b;
        if(p<=50){var t=p/50;r=34+(240-34)*t;g=224+(195-224)*t;b=123+(109-123)*t;}
        else{var t=(p-50)/50;r=240+(255-240)*t;g=195+(139-195)*t;b=109+(126-109)*t;}
        return Math.round(r)+','+Math.round(g)+','+Math.round(b);
      }
      var limC=over?'255,68,56':limitRgb(pct);
      var limStyle='color:rgb('+limC+');border-color:rgba('+limC+',.5);background:rgba('+limC+',.10)';
      var html='<div class="bucket'+(firstRender?' enter':'')+'">'
        +'<div class="bucket-info">'
          +'<div class="bucket-head"><div class="bucket-title"><strong>'+id+'</strong><span class="pill '+pillCls+'">'+pillTxt+'</span></div><span class="bucket-limit" style="'+limStyle+'">上限 '+limitGB+' GB</span></div>'
          +'<div class="bucket-sub">R2 桶名：'+b.bucket_name+'</div>'
          +'<div class="bucket-bar'+(over?' over':'')+'"><span style="width:'+pct+'%"></span></div>'
          +'<div class="bucket-stats"><span class="stats-left">已用 '+usedGB+' GB / 剩余 '+remGB+' GB</span><span class="stats-right">使用率 '+pct+'%</span></div>'
          +'<div class="bucket-health"><span class="dot '+dot+'"></span><span>'+ht+errTxt+'</span>'
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
    // 首次渲染播放入场动画，之后刷新不再播（避免启用/停用/编辑后画面跳动）
    window.__firstRender=false;
  }
  async function toggle(id,en){await api('config',{account_id:id,enabled:en});load();}
  async function setLimit(id,currentGB){
    var g=parseFloat(prompt('新的上限（GB），当前 '+currentGB+' GB：', currentGB));
    if(!g||g<=0) return;
    await api('config',{account_id:id,limit_bytes:Math.round(g*1073741824)});
    load();
  }
  async function check(id){
    var r;
    try{ r=await api('buckets/check',{account_id:id}); }
    catch(e){ alert('检查失败（网络错误）：'+(e.message||e)); load(); return; }
    var j;
    try{ j=await r.json(); }
    catch(e){ alert('检查失败（接口异常，HTTP '+r.status+'）：'+(e.message||e)); load(); return; }
    if(j.creds_valid && j.lifecycle_ok){ alert('✅ 健康'); }
    else{ alert('❌ 不健康'+(j.error?'\\n\\n原因：'+j.error:'')); }
    load();
  }
  // 编辑桶：打开弹窗，从 KV 读当前配置预填
  async function editBucket(id){
    var r;
    try{ r=await api('buckets/get',{account_id:id}); }
    catch(e){ alert('读取配置失败（网络错误）：'+(e.message||e)); return; }
    var j;
    try{ j=await r.json(); } catch(e){ alert('读取配置失败（接口异常）：'+(e.message||e)); return; }
    if(!j.ok){ alert('读取配置失败：'+(j.error||r.status)); return; }
    var cfg=j.config||{};
    document.getElementById('e_id').value=id;
    document.getElementById('e_cf').value=cfg.accountId||'';
    document.getElementById('e_bn').value=cfg.bucketName||'';
    document.getElementById('e_ak').value=cfg.accessKeyId||'';
    document.getElementById('e_sk').value=cfg.secretAccessKey||'';
    document.getElementById('e_lim').value=Math.round((j.limit_bytes||10737418240)/1073741824);
    document.getElementById('editSub').textContent='正在编辑桶「'+id+'」，修改后点确定保存到 KV';
    document.getElementById('editMask').classList.add('show');
  }
  function closeEdit(){ document.getElementById('editMask').classList.remove('show'); }
  async function saveEdit(){
    var body={
      account_id:document.getElementById('e_id').value,
      cf_code:document.getElementById('e_cf').value,
      bucket_name:document.getElementById('e_bn').value,
      r2_access_key_id:document.getElementById('e_ak').value,
      r2_secret_access_key:document.getElementById('e_sk').value
    };
    var gb=parseFloat(document.getElementById('e_lim').value);
    if(gb>0) body.limit_bytes=Math.round(gb*1073741824);
    var r=await api('buckets/update',body);
    var j=await r.json();
    if(j.ok){
      closeEdit();
      load();
      alert('✅ 已保存');
    }else{ alert('保存失败：'+(j.error||r.status)); }
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
    if(r.ok){
      ['a_id','cf_code','b_name','ak','sk','lim'].forEach(function(id){document.getElementById(id).value=''});
      alert('✅ 接入成功！\\n\\n⚠️ 记得去 R2 控制台给桶「'+body.account_id+'」配置生命周期规则（文件过期 1 天自动删除），否则文件体会永久累积、存储费持续增长。');
      load();
    }else{var e=await r.json();alert('接入失败：'+(e.error||r.status));}
  }
  load();
  autoCheckAll();
  </script></body></html>`;
  return head + body;
}
