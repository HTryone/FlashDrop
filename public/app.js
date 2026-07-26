(function () {
  // ---------- 工具 ----------
  function genCode() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
  function fmt(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  // ---------- Tab 切换 ----------
  const sendView = document.getElementById('sendView');
  const recvView = document.getElementById('recvView');
  const tabSend = document.getElementById('tabSend');
  const tabRecv = document.getElementById('tabRecv');
  function showTab(which) {
    const isSend = which === 'send';
    sendView.style.display = isSend ? '' : 'none';
    recvView.style.display = isSend ? 'none' : '';
    tabSend.classList.toggle('active', isSend);
    tabRecv.classList.toggle('active', !isSend);
  }
  tabSend.onclick = () => showTab('send');
  tabRecv.onclick = () => showTab('recv');

  // ---------- 发送逻辑 ----------
  const code = genCode();
  const codeEl = document.getElementById('code');
  codeEl.textContent = code;
  document.getElementById('copyBtn').onclick = () => {
    const link = location.origin + '/?code=' + code;
    navigator.clipboard.writeText(link).then(() => {
      const b = document.getElementById('copyBtn');
      b.textContent = '已复制';
      setTimeout(() => (b.textContent = '复制链接'), 1500);
    });
  };

  const fileInput = document.getElementById('fileInput');
  const dirInput = document.getElementById('dirInput');
  document.getElementById('pickFiles').onclick = () => fileInput.click();
  document.getElementById('pickDir').onclick = () => dirInput.click();

  const fileListEl = document.getElementById('fileList');
  const totalBar = document.getElementById('totalBar');
  const totalText = document.getElementById('totalText');

  const all = [];
  const queue = [];
  const MAX_PARALLEL = 4;
  let running = 0;

  fileInput.onchange = (e) => addFiles(e.target.files);
  dirInput.onchange = (e) => addFiles(e.target.files);

  function addFiles(list) {
    for (const file of Array.from(list)) {
      const rel = file.webkitRelativePath || file.name;
      const item = { file, rel, sent: 0, pct: 0, status: '等待' };
      item.el = makeRow(item);
      fileListEl.appendChild(item.el);
      all.push(item);
      queue.push(item);
    }
    fileInput.value = '';
    dirInput.value = '';
    updateTotal();
    pump();
  }

  function makeRow(item) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.innerHTML =
      `<div class="fi-name" title="${esc(item.rel)}">${esc(item.rel)}</div>` +
      `<div class="fi-meta"><span class="fi-bar"><span class="fi-fill"></span></span>` +
      `<span class="fi-pct">0%</span><span class="fi-status">等待</span></div>`;
    item.fillEl = li.querySelector('.fi-fill');
    item.pctEl = li.querySelector('.fi-pct');
    item.statusEl = li.querySelector('.fi-status');
    return li;
  }

  function setRow(item, pct, status) {
    item.pct = pct;
    item.status = status;
    if (item.fillEl) item.fillEl.style.width = pct + '%';
    if (item.pctEl) item.pctEl.textContent = Math.round(pct) + '%';
    if (item.statusEl) {
      item.statusEl.textContent = status;
      item.statusEl.className = 'fi-status ' + status;
    }
  }

  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      startUpload(queue.shift());
    }
  }

  function startUpload(item) {
    running++;
    setRow(item, 0, '上传中');
    const upload = new tus.Upload(item.file, {
      endpoint: '/files',
      chunkSize: 50 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      metadata: {
        filename: item.file.name,
        relativePath: item.rel,
        transferId: code,
        filetype: item.file.type || 'application/octet-stream',
      },
      onError(err) {
        setRow(item, item.pct, '错误');
        console.error(err);
        running--;
        pump();
      },
      onProgress(sent, total) {
        item.sent = sent;
        const pct = total ? (sent / total) * 100 : 0;
        setRow(item, pct, '上传中');
        updateTotal();
      },
      onSuccess() {
        item.sent = item.file.size;
        setRow(item, 100, '完成');
        updateTotal();
        running--;
        pump();
      },
    });
    item.upload = upload;
    upload.start();
  }

  function updateTotal() {
    let totalBytes = 0;
    let doneBytes = 0;
    for (const it of all) {
      totalBytes += it.file.size;
      doneBytes += it.sent || 0;
    }
    const pct = totalBytes ? (doneBytes / totalBytes) * 100 : 0;
    totalBar.style.width = pct + '%';
    totalText.textContent = `总计 ${fmt(doneBytes)} / ${fmt(totalBytes)} · 进行中 ${running}`;
  }

  // ---------- 接收逻辑 ----------
  const codeInput = document.getElementById('codeInput');
  const msg = document.getElementById('msg');
  const recvListEl = document.getElementById('recvList');
  const toolbar = document.getElementById('toolbar');
  const zipBtn = document.getElementById('zipBtn');

  document.getElementById('loadBtn').onclick = load;
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') load();
  });

  function load() {
    const c = codeInput.value.trim().toUpperCase();
    if (!c) {
      msg.textContent = '请输入分享码';
      return;
    }
    msg.textContent = '加载中…';
    recvListEl.innerHTML = '';
    toolbar.style.display = 'none';

    fetch('/api/transfer/' + encodeURIComponent(c))
      .then((r) =>
        r.ok
          ? r.json()
          : Promise.reject(new Error(r.status === 404 ? '未找到（可能还在上传或链接有误）' : '加载失败'))
      )
      .then((data) => {
        if (!data.files.length) {
          msg.textContent = '还没有文件上传完成，稍后再试';
          return;
        }
        msg.textContent = `共 ${data.files.length} 个文件`;
        toolbar.style.display = 'block';
        zipBtn.onclick = () => (location.href = `/download/${c}/zip`);
        for (const f of data.files) {
          const li = document.createElement('li');
          li.className = 'file-item';
          li.innerHTML =
            `<div class="fi-name" title="${esc(f.name)}">${esc(f.name)}</div>` +
            `<div class="fi-meta"><span class="fi-size">${fmt(f.size)}</span>` +
            `<a class="btn small" href="/download/${c}/${f.id}" target="_blank" rel="noopener">下载</a></div>`;
          recvListEl.appendChild(li);
        }
      })
      .catch((err) => {
        msg.textContent = err.message;
      });
  }

  // ---------- 自动进入接收模式（URL 带 ?code=xxx） ----------
  const params = new URLSearchParams(location.search);
  if (params.get('code')) {
    codeInput.value = params.get('code');
    showTab('recv');
    load();
  }
})();
