
// ===== 数据模型 =====
let modules = [
  { id:'posts', title:'项目动态', icon:'📰', desc:'后端发布，前端只读展示', docs:[
    { id:'2026-0813-v2', title:'闪传 V2 来了', date:'2026-08-13', md:'# 新特性\n- 中转 / 本地直传 / P2P 三链路\n- 端到端加密\n\n# 已知问题\n- 暂无' },
  ]},
  { id:'usage', title:'使用说明', icon:'📘', desc:'完整使用教程', docs:[
    { id:'guide', title:'快速上手', date:'2026-08-01', md:'# 发送\n1. 选文件\n2. 复制链接\n\n# 接收\n输入分享码即可' },
  ]},
];
let curMod = null, curDoc = null;
let openedDirHandle = null; // 「导入模块」获得的目录句柄，用于直接保存

const $ = (id) => document.getElementById(id);
function save() {} // 全部状态在内存，工程才落盘
function uid() { return 'doc-' + Math.random().toString(36).slice(2,8); }
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function orderOf(m){ return modules.indexOf(m)*10 + 10; }

// ===== 渲染：模块列表 =====
function renderMods(){
  const box = $('modList'); box.innerHTML='';
  modules.forEach(m=>{
    const el = document.createElement('div');
    el.className = 'mod' + (m===curMod?' on':'');
    el.innerHTML = `<span class="ic">${esc(m.icon||'📦')}</span>
      <span class="nm"><b>${esc(m.title||'(未命名)')}</b><small>${esc(m.id||'(无标识)')} · ${m.docs.length}篇</small></span>
      <button class="del" title="删除模块">✕</button>`;
    el.onclick = (e)=>{ if(e.target.classList.contains('del')){ if(confirm('删除模块「'+m.title+'」？')){ modules=modules.filter(x=>x!==m); if(curMod===m) curMod=null; renderAll(); } } else { curMod=m; curDoc=null; renderAll(); } };
    box.appendChild(el);
  });
}

// ===== 渲染：文档列表（当前模块的文档，左栏下方） =====
function renderDocs(){
  const box = $('docList'); box.innerHTML='';
  $('docModName').textContent = curMod ? (curMod.title||'(未命名)') : '—';
  if(!curMod) return;
  const list = curMod.docs.slice().sort((a,b)=> (b.date||'').localeCompare(a.date||''));
  list.forEach((d)=>{
    const el = document.createElement('div');
    el.className = 'doc-item' + (d===curDoc?' on':'');
    el.innerHTML = `<span class="t">${esc(d.title||'(无标题)')}</span><button class="del" title="删除">✕</button>`;
    el.onclick = (e)=>{
      if(e.target.classList.contains('del')){
        if(confirm('删除「'+(d.title||'(无标题)')+'」？')){ curMod.docs=curMod.docs.filter(x=>x!==d); if(curDoc===d) curDoc=curMod.docs[0]||null; renderAll(); }
      } else { curDoc=d; renderAll(); }
    };
    box.appendChild(el);
  });
}

// ===== 渲染：编辑器 =====
function renderEditor(){
  $('topId').textContent = curMod ? (curMod.id||'(无标识)') : '未选择模块';
  if(!curMod){ $('editor').style.display='none'; $('emptyTip').style.display='block'; return; }
  $('emptyTip').style.display='none'; $('editor').style.display='block';
  $('mId').value=curMod.id; $('mTitle').value=curMod.title; $('mIcon').value=curMod.icon||''; $('mDesc').value=curMod.desc||'';
  if(!curDoc){ $('docEdit').style.display='none'; return; }
  $('docEdit').style.display='block';
  $('dTitle').value=curDoc.title; $('dDate').value=curDoc.date||''; $('dMd').value=curDoc.md||'';
  renderPreview();
}
function renderPreview(){
  const box=$('prevBox');
  box.innerHTML = renderMd(curDoc ? curDoc.md : '');
  box.onclick=(e)=>{ const t=e.target; const btn=t.closest?t.closest('.code-copy'):null; if(!btn)return; const pre=btn.closest('.code-block')&&btn.closest('.code-block').querySelector('pre'); if(!pre)return; navigator.clipboard&&navigator.clipboard.writeText(pre.textContent||'').then(()=>{const o=btn.textContent;btn.textContent='已复制 ✓';setTimeout(()=>btn.textContent=o,1200);}); };
}
function renderAll(){ renderMods(); renderDocs(); renderEditor(); }

// ===== Markdown 渲染（与前端 doc.ts 逻辑一致）=====
function renderMd(src){
  if(!src) return '<p style="color:var(--faint)">（空）</p>';
  const lines = src.replace(/\r\n/g,'\n').split('\n');
  const out=[]; let i=0; const usedIds=new Set();
  const safeU=(u)=>/^(https?:\/\/|\/|#|\.\/|\.\.\/|data:image\/)/i.test(u)?u:'#';
  const filterAttrs=(tag,attrs)=>{
    const ok={img:['src','alt','width','height','title','style'],a:['href','title','target','rel'],br:[],center:[],div:['style'],span:['style'],mark:[],kbd:[]}[tag.toLowerCase()]||[];
    const out=[]; const re=/([a-zA-Z-]+)\s*=\s*"([^"]*)"|([a-zA-Z-]+)\s*=\s*'([^']*)'|([a-zA-Z-]+)\s*=\s*([^\s>]+)/g; let m;
    while((m=re.exec(attrs))){
      const name=(m[1]||m[3]||m[5]||'').toLowerCase();
      const val=m[2]!==undefined?m[2]:m[4]!==undefined?m[4]:m[6];
      if(!ok.includes(name)||name.startsWith('on')) continue;
      let v=val;
      if(name==='src'||name==='href') v=safeU(v);
      if(name==='style') v=v.replace(/javascript:/gi,'').replace(/expression\s*\(/gi,'');
      out.push(name+'="'+v.replace(/"/g,'&quot;')+'"');
    }
    return out.length?' '+out.join(' '):'';
  };
  const markdownInline=(s)=>s
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,(_m,a,u)=>`<img src="${safeU(u)}" alt="${a.replace(/"/g,'&quot;')}" />`)
    .replace(/\*\*\*([^*]+)\*\*\*/g,'<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g,'<em>$1</em>')
    .replace(/~~([^~]+)~~/g,'<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(_m,t,u)=>{const url=safeU(u);return u.startsWith('http')?`<a href="${url}" target="_blank" rel="noopener">${t}</a>`:`<a href="${url}">${t}</a>`;})
    .replace(/(?<!["(/])(https?:\/\/[^\s<]+)/g,(full)=>{const m=full.match(/^(https?:\/\/[^\s<]+?)([.,;:!?)\]]*)$/);const url=m?m[1]:full;const tail=m?m[2]:'';return `<a href="${safeU(url)}" target="_blank" rel="noopener">${url}</a>${tail}`;})
    .replace(/(?<!["(/])(www\.[^\s<]+)/g,(full)=>{const m=full.match(/^(www\.[^\s<]+?)([.,;:!?)\]]*)$/);const host=m?m[1]:full;const tail=m?m[2]:'';return `<a href="${safeU('https://'+host)}" target="_blank" rel="noopener">${host}</a>${tail}`;});
  const inline=(s)=>{
    const store=[];
    const stash=(html)=>{store.push(html);return '\uE000'+(store.length-1)+'\uE001';};
    // 先保护行内代码，避免 HTML 解析器把 `<img>` 等也当标签解析
    let s2=s.replace(/`([^`]+)`/g,(_m,code)=>stash('<code>'+esc(code)+'</code>'));
    // 再保护白名单裸 HTML
    s2=s2.replace(/<\s*(img|br)\b([^>]*?)\/?>/gi,(_m,tag,attrs)=>stash('<'+tag+filterAttrs(tag,attrs)+' />'));
    s2=s2.replace(/<\s*(a|center|div|span|mark|kbd)\b([^>]*)>([\s\S]*?)<\/\s*\1\s*>/gi,(_m,tag,attrs,inner)=>stash('<'+tag+filterAttrs(tag,attrs)+'>'+inner.replace(/\uE000(\d+)\uE001/g,(_x,k)=>store[+k]||'')+'</'+tag+'>'));
    const parts=s2.split(/(\uE000\d+\uE001)/);
    let out='';
    for(const p of parts){ const m=p.match(/^\uE000(\d+)\uE001$/); out+=m?store[+m[1]]:markdownInline(esc(p)); }
    return out;
  };
  const splitRow=(l)=>l.replace(/^\s*\|/,'').replace(/\|\s*$/,'').split('|').map(c=>c.trim());
  const isRow=(l)=>/^\s*\|.*\|\s*$/.test(l);
  const isSep=(l)=>/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l)&&l.includes('-');
  const alignOf=(c)=>{const t=c.trim();const L=t.startsWith(':'),R=t.endsWith(':');if(L&&R)return 'center';if(R)return 'right';if(L)return 'left';return '';};
  const isHr=(l)=>/^(\s*[-*_]){3,}\s*$/.test(l);
  const isItem=(l)=>/^(\s*)([-*+]|\d+\.)\s+/.test(l);
  function parseItem(raw){
    const m=raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/); if(!m) return null;
    const indent=m[1].replace(/\t/g,'  ').length; const ordered=/\d+\./.test(m[2]);
    let text=m[3]; const tm=text.match(/^\[([ xX])\]\s+(.*)$/); let task=false,checked=false;
    if(tm){task=true;checked=tm[1].toLowerCase()==='x';text=tm[2];}
    return {indent,ordered,task,checked,text,children:[]};
  }
  function renderNodes(nodes){
    if(!nodes.length) return '';
    let html='',i=0;
    while(i<nodes.length){
      const type=nodes[i].ordered?'ol':'ul'; let j=i;
      while(j<nodes.length&&(nodes[j].ordered?'ol':'ul')===type)j++;
      const group=nodes.slice(i,j);
      html+=`<${type}>`;
      for(const n of group){
        const content=n.task?`<input type="checkbox" disabled${n.checked?' checked':''} /> ${inline(n.text)}`:inline(n.text);
        html+=`<li>${content}${n.children.length?renderNodes(n.children):''}</li>`;
      }
      html+=`</${type}>`;
      i=j;
    }
    return html;
  }
  function renderList(buf){
    const items=buf.map(parseItem).filter(Boolean);
    if(!items.length) return '';
    const root={indent:-1,ordered:false,task:false,checked:false,text:'',children:[]};
    const stack=[{indent:-1,node:root}];
    for(const it of items){
      while(stack.length&&stack[stack.length-1].indent>=it.indent) stack.pop();
      stack[stack.length-1].node.children.push(it);
      stack.push({indent:it.indent,node:it});
    }
    return renderNodes(root.children);
  }
  while(i<lines.length){
    const line=lines[i];
    if(/^```/.test(line.trim())){
      const lang=(line.trim().match(/^```(\w*)/)||[])[1]||'';
      const buf=[]; i++;
      while(i<lines.length&&!/^```/.test(lines[i].trim())){buf.push(lines[i]);i++;}
      i++;
      const badge=lang?`<span class="code-lang">${esc(lang)}</span>`:'';
      out.push(`<div class="code-block"><div class="code-head">${badge}<button class="code-copy" type="button">复制</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`); continue;
    }
    if(isRow(line)&&i+1<lines.length&&isSep(lines[i+1])){
      const aligns=splitRow(lines[i+1]).map(alignOf);
      const head=splitRow(line).map((c,idx)=>`<th${aligns[idx]?` style="text-align:${aligns[idx]}"`:''}>${inline(c)}</th>`).join('');
      let j=i+2; const body=[];
      while(j<lines.length&&isRow(lines[j])&&lines[j].trim()!==''){ body.push('<tr>'+splitRow(lines[j]).map((c,idx)=>`<td${aligns[idx]?` style="text-align:${aligns[idx]}"`:''}>${inline(c)}</td>`).join('')+'</tr>'); j++; }
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`);
      i=j; continue;
    }
    const h=line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/); if(h){ const n=h[1].length; let id=h[2].replace(/[*`_~\[\]()!#]/g,'').trim().toLowerCase().replace(/\s+/g,'-').replace(/[^\w一-龥-]/g,''); if(!id)id='section'; let u=id,c=1; while(usedIds.has(u))u=`${id}-${c++}`; usedIds.add(u); out.push(`<h${n} id="${u}">${inline(h[2])}</h${n}>`); i++; continue; }
    if(isHr(line)&&!isItem(line)){ out.push('<hr />'); i++; continue; }
    if(/^>\s?/.test(line)){
      const buf=[]; while(i<lines.length&&/^>\s?/.test(lines[i])){buf.push(lines[i]);i++;}
      const inner=buf.map(l=>l.replace(/^>\s?/,'')).join('\n');
      out.push(`<blockquote>${renderMd(inner)}</blockquote>`); continue;
    }
    if(isItem(line)){
      const buf=[];
      while(i<lines.length){
        if(isItem(lines[i])){buf.push(lines[i]);i++;}
        else if(lines[i].trim()===''&&i+1<lines.length&&isItem(lines[i+1])){i++;}
        else break;
      }
      out.push(renderList(buf)); continue;
    }
    if(line.trim()!==''){
      const buf=[line]; i++;
      while(i<lines.length&&lines[i].trim()!==''&&!/^```/.test(lines[i].trim())&&!/^\s{0,3}#{1,6}\s+/.test(lines[i])&&!/^>\s?/.test(lines[i])&&!isItem(lines[i])&&!isHr(lines[i])){buf.push(lines[i]);i++;}
      out.push(`<p>${buf.map(l=>inline(l)).join('<br/>')}</p>`); continue;
    }
    i++;
  }
  return out.join('\n');
}

// ===== 生成文件文本 =====
function genMeta(m){
  const mid = m.moduleId || m.id;
  return `import type { Extension } from '../types';

const meta: Extension = {
  id: '${m.id}',
  title: '${m.title.replace(/'/g,"\\'")}',
  desc: '${m.desc||''}',
  icon: '${m.icon||'📦'}',
  kind: 'doc',
  order: ${orderOf(m)},
  moduleId: '${mid}',
};

export default meta;
`;
}
function genData(m){
  const mid = m.moduleId || m.id;
  const rows = m.docs.map(d=>{
    const t = (d.title||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return `  {\n    id: '${d.id}',\n    title: '${t}',\n    module: '${mid}',\n    updatedAt: '${d.date||''}',\n    markdown: loadMarkdown('${d.id}'),\n  },`;
  }).join('\n');
  return `import type { DocItem } from '../types';

// 每篇正文存于 ./posts/<id>.md（Vite \`?raw\` 引入），避免 data.ts 体积膨胀。
const mdFiles = import.meta.glob('./posts/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
function loadMarkdown(id: string): string {
  const key = Object.keys(mdFiles).find((k) => k.includes(\`\${id}.md\`)) ?? '';
  return mdFiles[key] ?? '';
}

export const moduleId = '${mid}';

export const docs: DocItem[] = [
${rows}
];
`;
}

// ===== 保存到已打开的模块文件夹（导入模块时获得的句柄）=====
async function saveOpenedDir(){
  if(!curMod){ alert('请先选/建一个模块。'); return; }
  if(!curMod.id){ alert('请先在顶部填写模块标识。'); return; }
  if(!openedDirHandle){ alert('请先点「📂 导入模块」选择要保存的模块文件夹。'); return; }
  try{
    const wf = async (name, text)=>{ const f=await openedDirHandle.getFileHandle(name,{create:true}); const w=await f.createWritable(); await w.write(text); await w.close(); };
    const writePosts = async ()=>{ const pd=await openedDirHandle.getDirectoryHandle('posts',{create:true}); for(const d of curMod.docs){ if(!d.id) continue; const f=await pd.getFileHandle(d.id+'.md',{create:true}); const w=await f.createWritable(); await w.write(d.md||''); await w.close(); } };
    await wf('meta.ts', genMeta(curMod));
    await wf('data.ts', genData(curMod));
    await writePosts();
    alert('已保存到当前打开的文件夹');
  }catch(e){ if(e.name!=='AbortError') alert('保存失败：'+e.message); }
}

// ===== 导出到扩展目录（选 src/extensions，自动建模块子文件夹）=====
async function exportToExtensionsDir(){
  if(!curMod){ alert('请先选/建一个模块。'); return; }
  if(!curMod.id){ alert('请先在顶部填写模块标识。'); return; }
  if(!window.showDirectoryPicker){ alert('当前环境不支持文件夹选择（需通过 http(s) 打开本工具）。'); return; }
  try{
    const dir = await window.showDirectoryPicker();
    const sub = await dir.getDirectoryHandle(curMod.id, { create:true });
    const wf = async (name, text)=>{ const f=await sub.getFileHandle(name,{create:true}); const w=await f.createWritable(); await w.write(text); await w.close(); };
    const writePosts = async ()=>{ const pd=await sub.getDirectoryHandle('posts',{create:true}); for(const d of curMod.docs){ if(!d.id) continue; const f=await pd.getFileHandle(d.id+'.md',{create:true}); const w=await f.createWritable(); await w.write(d.md||''); await w.close(); } };
    await wf('meta.ts', genMeta(curMod));
    await wf('data.ts', genData(curMod));
    await writePosts();
    alert('已导出模块「'+curMod.title+'」到 '+curMod.id+'/ 文件夹');
  }catch(e){ if(e.name!=='AbortError') alert('导出失败：'+e.message); }
}

// ===== 新建模块（空模块，四字段在右栏顶部填写）=====
function newModule(){
  const m = { id:'', title:'', icon:'📦', desc:'', moduleId:'', docs:[] };
  modules.push(m); curMod=m; curDoc=null; renderAll();
  $('mId').focus();
}

// ===== 导入模块（打开已有文件夹，读 meta.ts + data.ts 进工具编辑）=====
async function openFolder(){
  if(!window.showDirectoryPicker){ alert('当前浏览器不支持文件夹访问（需通过 http(s) 打开本工具）。'); return; }
  try{
    const dir = await window.showDirectoryPicker();
    let metaText='', dataText='';
    try{ const f=await dir.getFileHandle('meta.ts'); metaText=await (await f.getFile()).text(); }catch(_){}
    try{ const f=await dir.getFileHandle('data.ts'); dataText=await (await f.getFile()).text(); }catch(_){}
    if(!metaText && !dataText){ alert('该文件夹没有 meta.ts / data.ts，无法识别为扩展模块。'); return; }
    const g=(re)=>{ const m=metaText.match(re); return m?(m[1]||''):''; };
    const kind = g(/\bkind:\s*'([^']*)'/);
    if(kind && kind!=='doc'){ alert('该模块是「'+kind+'」类型（自定义 UI 面板），本工具只管理文档(doc)模块，无法编辑。'); return; }
    const id = g(/\bid:\s*'([^']*)'/) || g(/\bid:\s*"([^"]*)"/);
    const moduleId = g(/\bmoduleId:\s*'([^']*)'/) || g(/\bmoduleId:\s*"([^"]*)"/) || id || '';
    const title = g(/\btitle:\s*'([^']*)'/) || g(/\btitle:\s*"([^"]*)"/) || id || '未命名';
    const icon = g(/\bicon:\s*'([^']*)'/) || '📦';
    const desc = g(/\bdesc:\s*'([^']*)'/) || g(/\bdesc:\s*"([^"]*)"/) || '';
    let docs=[];
    if(dataText){
      if(dataText.includes("import.meta.glob('./posts/*.md'")){
        // 新格式：正文在 posts/<id>.md，data.ts 只含元数据
        const blockRe = /\{\s*id:\s*'([^']+)'[\s\S]*?\}/g; let bm; const tmp=[];
        while((bm=blockRe.exec(dataText))){ const b=bm[0];
          const id=(b.match(/id:\s*'([^']+)'/)||[])[1]||'';
          const title=((b.match(/title:\s*'((?:\\.|[^'])*)'/)||[])[1]||'').replace(/\\'/g,"'");
          const updatedAt=(b.match(/updatedAt:\s*'([^']*)'/)||[])[1]||'';
          if(id) tmp.push({ id, title:title||'未命名', date:updatedAt, md:'' });
        }
        docs=tmp;
      } else {
        alert('该模块 data.ts 为旧格式（markdown 内联在 data.ts），本工具已不再支持。\n请改用新格式：data.ts 只含元数据 + posts/<id>.md。\n可删除旧 data.ts 后重新生成，或手动迁移正文到 posts/ 文件夹。');
        return;
      }
    }
    if(!docs.length && moduleId){
      try{ if(location.protocol.startsWith('http')){ const res=await fetch('/api/'+moduleId+'/docs.json',{cache:'no-store'}); if(res.ok){ const data=await res.json(); const list=Array.isArray(data)?data:(data.docs||[]); docs=list.map(d=>({ id:d.id||uid(), title:d.title||'未命名', date:d.updatedAt||'', md:d.markdown||'' })); } } }catch(_){}
    }
    // 从 posts/ 读正文（新格式 data.ts 的正文在 posts/<id>.md）
    let postsDir=null;
    try{ postsDir = await dir.getDirectoryHandle('posts'); }catch(_){}
    if(postsDir){ for(const d of docs){ try{ const f=await postsDir.getFileHandle(d.id+'.md'); d.md=await (await f.getFile()).text(); }catch(_){} } }
    const mod={ id, title, icon, desc, moduleId, docs };
    const idx=modules.findIndex(x=>x.id===id);
    if(idx>=0) modules[idx]=mod; else modules.push(mod);
    curMod=mod; curDoc=null; openedDirHandle=dir;
    renderAll();
    alert('已导入模块「'+title+'」（'+docs.length+' 篇文档）\n编辑后点「💾 保存」直接写回此位置。');
  }catch(e){ if(e.name!=='AbortError') alert('打开失败：'+e.message); }
}

// ===== 跳转链接插入 =====
function insLink(){
  const links = modules.map(m=>`${m.title}  →  /ext/${m.id}`).join('\n');
  const pick = prompt('插入跳转链接：\n输入模块名(下方已有)或完整 http(s) 链接。\n\n可选模块：\n'+links, curMod?curMod.title:'');
  if(!pick) return;
  const m = modules.find(x=>x.title===pick);
  const snippet = m ? `[${pick}](/ext/${m.id})` : (pick.startsWith('http')? `[链接](${pick})` : null);
  if(!snippet){ alert('未匹配到模块，也未识别为 http 链接。'); return; }
  const ta=$('dMd'); ta.value += (ta.value && !ta.value.endsWith('\n')?'\n':'') + snippet; curDoc.md=ta.value;
}

// ===== 事件绑定 =====
$('addMod').onclick = newModule;
$('addDoc').onclick = ()=>{ if(!curMod){alert('先选/建一个模块');return;} const d={id:uid(),title:'新文档',date:new Date().toISOString().slice(0,10),md:''}; curMod.docs.push(d); curDoc=d; renderAll(); };
$('tabEdit').onclick=()=>{ $('dMd').style.display='block'; $('prevBox').style.display='none'; $('tabEdit').classList.add('on'); $('tabPrev').classList.remove('on'); };
$('tabPrev').onclick=()=>{ $('dMd').style.display='none'; $('prevBox').style.display='block'; $('tabPrev').classList.add('on'); $('tabEdit').classList.remove('on'); renderPreview(); };
$('insLink').onclick=insLink;
$('expOne').onclick=exportToExtensionsDir;
$('saveBtn').onclick=saveOpenedDir;
$('openDir').onclick=openFolder;

// 字段实时写回
['mId','mTitle','mIcon','mDesc'].forEach(id=>{ $(id).oninput=()=>{ if(!curMod)return; const k={mId:'id',mTitle:'title',mIcon:'icon',mDesc:'desc'}[id]; curMod[k]=$(id).value; if(id==='mId'){$('topId').textContent=curMod.id||'未选择模块';} renderMods(); }; });
$('dTitle').oninput=()=>{ if(curDoc){ curDoc.title=$('dTitle').value; renderDocs(); } };
$('dDate').oninput=()=>{ if(curDoc) curDoc.date=$('dDate').value; };
$('dMd').oninput=()=>{ if(curDoc) curDoc.md=$('dMd').value; };

// ===== 拖入 .md/.txt 文件：直接灌进编辑框 =====
const docEditBox = $('docEdit');
const mdType = (f)=> /\.(md|markdown|txt|text)$/i.test(f.name) || /text\//.test(f.type);
function readDroppedFile(file){
  if(!mdType(file)){ alert('只支持 .md / .txt 文本文件'); return; }
  const reader = new FileReader();
  reader.onload = ()=>{
    const text = String(reader.result||'');
    if(curDoc){ $('dMd').value = text; curDoc.md = text; }
    else if(curMod){
      const name = file.name.replace(/\.(md|markdown|txt|text)$/i,'') || '导入文档';
      const d = { id:uid(), title:name, date:new Date().toISOString().slice(0,10), md:text };
      curMod.docs.push(d); curDoc = d;
    } else { alert('请先选 / 建一个模块，再拖入文件。'); return; }
    renderAll();
  };
  reader.readAsText(file);
}
docEditBox.addEventListener('dragover', (e)=>{ e.preventDefault(); $('dMd').classList.add('drag'); });
docEditBox.addEventListener('dragleave', ()=> $('dMd').classList.remove('drag'));
docEditBox.addEventListener('drop', (e)=>{
  e.preventDefault(); $('dMd').classList.remove('drag');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if(file) readDroppedFile(file);
});
// 阻止把文件拖到页面其它位置时浏览器直接打开文件（导航走掉）
window.addEventListener('dragover', (e)=> e.preventDefault());
window.addEventListener('drop', (e)=>{ if(e.target!==$('dMd') && !docEditBox.contains(e.target)) e.preventDefault(); });

renderAll();
