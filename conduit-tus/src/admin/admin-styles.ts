// 站长后台样式表：独立文件，admin-ui.ts 引用。
// 深靛蓝紫玻璃拟态主题；编辑弹窗含水滴折射光斑效果。
export const PAGE_CSS = `
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
  input[disabled]{opacity:.5}
  button{cursor:pointer;background:rgba(99,102,241,.12);color:var(--fg);border:1px solid rgba(129,140,248,.22);border-radius:10px;padding:11px 14px;transition:background .2s,border-color .2s,transform .1s,box-shadow .2s}
  button:hover{background:rgba(129,140,248,.2);border-color:rgba(150,165,255,.34)}
  button:active{transform:scale(.97)}
  button.primary{background:linear-gradient(135deg,#7c8bff,#5b6cff);border-color:transparent;color:#fff;font-weight:700;box-shadow:0 6px 18px rgba(91,108,255,.4)}
  button.primary:hover{filter:brightness(1.1)}
  .banner{background:rgba(240,195,109,.08);border-color:rgba(240,195,109,.35);border-left:3px solid var(--amber);color:var(--amber);padding:14px 20px}

  .bucket{display:flex;flex-direction:column;align-items:stretch;background:rgba(99,102,241,.10);border:1px solid rgba(129,140,248,.2);border-radius:14px;padding:22px 26px;margin-bottom:12px;backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);box-shadow:0 8px 30px rgba(8,10,30,.5);transition:transform .22s ease,box-shadow .22s ease,border-color .22s ease}
  .bucket.enter{animation:cardIn .45s ease both}
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

  .modal-mask{position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;
    background:rgba(10,14,32,.55);backdrop-filter:blur(8px) saturate(1.2);-webkit-backdrop-filter:blur(8px) saturate(1.2)}
  .modal-mask.show{display:flex;animation:fadeIn .2s ease}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  .modal{position:relative;width:min(560px,calc(100vw - 40px));max-height:calc(100vh - 60px);overflow:auto;
    background:linear-gradient(160deg,rgba(58,70,140,.55),rgba(20,26,64,.65));
    border:1px solid rgba(160,170,255,.3);border-radius:20px;padding:24px;
    backdrop-filter:blur(28px) saturate(1.8);-webkit-backdrop-filter:blur(28px) saturate(1.8);
    box-shadow:0 24px 80px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.18);animation:modalIn .25s ease}
  .modal::before{content:'';position:absolute;inset:0;border-radius:20px;pointer-events:none;
    background:radial-gradient(120% 60% at 15% 0%,rgba(160,180,255,.22),transparent 55%),
    radial-gradient(80% 50% at 90% 110%,rgba(122,162,255,.16),transparent 60%)}
  @keyframes modalIn{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
  .modal h3{margin:0 0 4px;font-size:16px;font-weight:500;position:relative}
  .modal .sub{font-size:12px;color:var(--muted);margin:0 0 16px;position:relative}
  .modal .form-grid{margin-top:0}
  .modal .actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px;position:relative}
  .modal .actions button{min-width:88px}

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
