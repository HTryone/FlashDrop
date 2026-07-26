import express from 'express';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import stream from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const INDEX_FILE = path.join(UPLOAD_DIR, 'index.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const STORAGE_TYPE = (process.env.STORAGE_TYPE || 'local').toLowerCase();
const MAX_SIZE = Number(process.env.MAX_SIZE || 30 * 1024 * 1024 * 1024); // 默认 30GB
const DEFAULT_TTL_MS = Number(process.env.DEFAULT_TTL_HOURS || 24) * 3600 * 1000; // 默认 24 小时

// R2 / S3 兼容配置（仅当 STORAGE_TYPE=r2 时启用）
const R2 = {
  accountId: process.env.R2_ACCOUNT_ID,
  bucket: process.env.R2_BUCKET,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  endpoint: process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID
    ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : undefined),
};

// ---------- 索引：transfers + codes + loginCodes ----------
function readIndex() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object') data = {};
  if (!data.transfers) data.transfers = {};
  if (!data.codes) data.codes = {};
  if (!data.loginCodes) data.loginCodes = {}; // 登录码 → transferId
  return data;
}
function writeIndex(idx) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}

/** 6 位分享码（排除易混淆字符） */
function genCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

/** 16 位发送者登录码（大小写字母+数字，易输入） */
function genLoginCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz'; // 排除 0/O/1/I/l/o
  let s = '';
  for (let i = 0; i < 16; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  // 每 4 位加空格便于阅读：XXXX XXXX XXXX XXXX
  return s.slice(0, 4) + ' ' + s.slice(4, 8) + ' ' + s.slice(8, 12) + ' ' + s.slice(12, 16);
}

/** 检查传输是否已过期 */
function isExpired(t) {
  return t.expiresAt && Date.now() > t.expiresAt;
}

// ---------- 存储抽象：local 磁盘 / r2 对象存储 ----------
async function createStore() {
  if (STORAGE_TYPE === 'r2') {
    if (!R2.accountId || !R2.bucket || !R2.accessKeyId || !R2.secretAccessKey) {
      console.warn('[存储] STORAGE_TYPE=r2 但缺少 R2 凭据，回退到本地磁盘');
      return { type: 'local', store: new FileStore({ directory: UPLOAD_DIR }) };
    }
    const { S3Store } = await import('@tus/s3-store');
    const store = new S3Store({
      partSize: 8 * 1024 * 1024,
      s3ClientConfig: {
        bucket: R2.bucket,
        region: 'auto',
        endpoint: R2.endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey },
      },
    });
    console.log(`[存储] 使用 R2 对象存储：bucket=${R2.bucket}`);
    return { type: 'r2', store };
  }
  console.log('[存储] 使用本地磁盘：', UPLOAD_DIR);
  return { type: 'local', store: new FileStore({ directory: UPLOAD_DIR }) };
}

// ---------- R2 单文件流式下载（支持 Range）----------
async function streamR2File(fileId, rangeHeader, res) {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    endpoint: R2.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey },
  });
  const cmd = new GetObjectCommand({
    Bucket: R2.bucket,
    Key: fileId,
    ...(rangeHeader ? { Range: rangeHeader } : {}),
  });
  const resp = await client.send(cmd);
  const body = resp.Body;
  const nodeStream = stream.Readable.fromWeb(body);
  if (resp.ContentRange) {
    res.status(206);
    res.setHeader('Content-Range', resp.ContentRange);
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', resp.ContentLength || 0);
  res.setHeader('Accept-Ranges', 'bytes');
  nodeStream.pipe(res);
}

// ---------- 主程序 ----------
async function main() {
  const { type: storageType, store } = await createStore();

  const tusServer = new Server({
    path: '/files',
    datastore: store,
    respectForwardedHeaders: true,
    relativeLocation: true, // 返回相对路径 Location，由前端基于 https endpoint 拼接，避免协议/主机错配
    maxSize: MAX_SIZE,
    onUploadFinish: async (req, upload) => {
      const meta = upload.metadata || {};
      const transferId = meta.transferId;
      if (!transferId) return {};
      const name = meta.filename || upload.id;
      const rel = meta.relativePath || name;
      const idx = readIndex();
      if (!idx.transfers[transferId]) {
        idx.transfers[transferId] = { id: transferId, message: '', createdAt: Date.now(), code: '', files: [], e2ee: null, expiresAt: 0, terminated: false };
      }
      const t = idx.transfers[transferId];
      if (!t.files.find((f) => f.id === upload.id)) {
        t.files.push({
          id: upload.id,
          filename: name,
          relativePath: rel,
          size: Number(upload.size),
          storage: storageType,
        });
      }
      writeIndex(idx);
      return {};
    },
  });

  const app = express();
  app.use(express.json());

  // tus 端点（保留原始 req.url）
  app.all('/files', (req, res) => tusServer.handle(req, res));
  app.all('/files/:id', (req, res) => tusServer.handle(req, res));

  // 创建传输并分配分享码 + 登录码（可带初始留言 / E2EE 元数据）
  app.post('/api/transfers', (req, res) => {
    const idx = readIndex();
    const transferId = (req.body && req.body.transferId) || cryptoRandom();
    const message = (req.body && req.body.message) || '';
    const ttlMs = Number(req.body?.ttlHours || 0) * 3600 * 1000 || DEFAULT_TTL_MS;
    if (!idx.transfers[transferId]) {
      idx.transfers[transferId] = {
        id: transferId, message: '', createdAt: Date.now(),
        code: '', files: [], e2ee: null,
        expiresAt: Date.now() + ttlMs, terminated: false,
      };
    }
    const t = idx.transfers[transferId];
    if (message) t.message = message;
    if (req.body && req.body.e2ee) {
      t.e2ee = {
        salt: String(req.body.e2ee.salt || ''),
        chunkSize: Number(req.body.e2ee.chunkSize) || 0,
      };
    }

    // 分享码
    let code = genCode();
    while (idx.codes[code]) code = genCode();
    t.code = code;
    idx.codes[code] = transferId;

    // 登录码（16 位，换电脑回看用）
    let loginCode = genLoginCode();
    const loginRaw = loginCode.replace(/\s/g, ''); // 去空格存索引
    while (idx.loginCodes[loginRaw]) { loginCode = genLoginCode(); loginRaw = loginCode.replace(/\s/g, ''); }
    t.loginCode = loginRaw;
    idx.loginCodes[loginRaw] = transferId;

    writeIndex(idx);
    res.json({
      transferId,
      code,
      loginCode,       // 带空格的展示版：XXXX XXXX XXXX XXXX
      expiresAt: t.expiresAt,
      storage: storageType,
      e2ee: t.e2ee,
    });
  });

  // 刷新分享码（旧码作废，发新码）
  app.post('/api/transfers/:id/refresh', (req, res) => {
    const idx = readIndex();
    const t = idx.transfers[req.params.id];
    if (!t) return res.status(404).json({ error: '传输不存在' });
    if (isExpired(t) || t.terminated) return res.status(410).json({ error: '传输已过期或已终止' });
    if (t.code) delete idx.codes[t.code];
    let code = genCode();
    while (idx.codes[code]) code = genCode();
    t.code = code;
    idx.codes[code] = t.id;
    writeIndex(idx);
    res.json({ code });
  });

  // 设置/更新留言
  app.patch('/api/transfers/:id', (req, res) => {
    const idx = readIndex();
    const t = idx.transfers[req.params.id];
    if (!t) return res.status(404).json({ error: '传输不存在' });
    if (isExpired(t) || t.terminated) return res.status(410).json({ error: '传输已过期或已终止' });
    if (req.body && typeof req.body.message === 'string') t.message = req.body.message;
    writeIndex(idx);
    res.json({ message: t.message });
  });

  // 按分享码列出文件 + 留言
  app.get('/api/transfer/:code', (req, res) => {
    const idx = readIndex();
    const tid = idx.codes[req.params.code];
    const t = tid && idx.transfers[tid];
    if (!t) return res.status(404).json({ error: '未找到，可能还在上传或链接有误' });
    if (isExpired(t) || t.terminated) return res.status(410).json({ error: '传输已过期或已终止' });
    res.json({
      transferId: t.id,
      message: t.message || '',
      storage: t.files[0]?.storage || storageType,
      e2ee: t.e2ee || null,
      expiresAt: t.expiresAt || 0,
      files: t.files.map((f) => ({ id: f.id, name: f.relativePath, size: f.size })),
    });
  });

  // ---------- 发送者登录码相关 ----------

  /** 用登录码查看自己的传输详情（含管理权限） */
  app.get('/api/login/:code', (req, res) => {
    const idx = readIndex();
    const raw = req.params.code.replace(/\s/g, '');
    const tid = idx.loginCodes[raw];
    const t = tid && idx.transfers[tid];
    if (!t) return res.status(404).json({ error: '登录码无效或已失效' });
    const expired = isExpired(t) || t.terminated;
    res.json({
      transferId: t.id,
      message: t.message || '',
      code: t.code || '',
      loginCode: t.loginCode ? formatLoginCode(t.loginCode) : '',
      expired: !!expired,
      terminated: !!t.terminated,
      expiresAt: t.expiresAt || 0,
      createdAt: t.createdAt || 0,
      storage: t.files[0]?.storage || storageType,
      e2ee: t.e2ee || null,
      files: t.files.map((f) => ({ id: f.id, name: f.relativePath, size: f.size })),
      totalSize: t.files.reduce((s, f) => s + (f.size || 0), 0),
    });
  });

  /** 提前终止传输（作废分享码 + 登录码，保留文件可选删除） */
  app.post('/api/transfers/:id/terminate', (req, res) => {
    const idx = readIndex();
    const t = idx.transfers[req.params.id];
    if (!t) return res.status(404).json({ error: '传输不存在' });
    t.terminated = true;
    // 作废分享码
    if (t.code) { delete idx.codes[t.code]; t.code = ''; }
    // 作废登录码
    if (t.loginCode) { delete idx.loginCodes[t.loginCode]; t.loginCode = ''; }
    writeIndex(idx);
    res.json({ ok: true, message: '传输已终止，分享码和登录码均已失效' });
  });

  // 清空缓存：删除某传输（文件 + 索引 + 分享码 + 登录码）
  app.delete('/api/transfers/:id', (req, res) => {
    const idx = readIndex();
    const t = idx.transfers[req.params.id];
    if (!t) return res.status(404).json({ error: '传输不存在' });
    if (t.code) delete idx.codes[t.code];
    if (t.loginCode) delete idx.loginCodes[t.loginCode];
    for (const f of t.files) {
      if (f.storage === 'local') {
        const p = path.join(UPLOAD_DIR, f.id);
        fs.rm(p, { force: true }, () => {});
        fs.rm(p + '.info', { force: true }, () => {});
      }
    }
    delete idx.transfers[req.params.id];
    writeIndex(idx);
    res.json({ ok: true });
  });

  // 全部打包为 zip 下载（仅本地存储支持；R2 不支持服务端打包）
  app.get('/download/:code/zip', async (req, res) => {
    const idx = readIndex();
    const tid = idx.codes[req.params.code];
    const t = tid && idx.transfers[tid];
    if (!t) return res.status(404).end('未找到');
    if (isExpired(t) || t.terminated) return res.status(410).end('传输已过期或已终止');
    if (t.files[0]?.storage === 'r2') {
      return res.status(501).end('R2 存储不支持服务端打包，请逐文件下载');
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="flashdrop-${req.params.code}.zip"`);
    const archive = archiver('zip');
    archive.on('warning', (e) => { if (e.code !== 'ENOENT') console.error(e); });
    archive.on('error', (e) => { console.error(e); if (!res.headersSent) res.status(500).end(); });
    archive.pipe(res);
    for (const f of t.files) {
      const p = path.join(UPLOAD_DIR, f.id);
      if (fs.existsSync(p)) archive.file(p, { name: f.relativePath });
    }
    archive.finalize();
  });

  // 单文件断点下载（支持 Range）；本地读盘，R2 走 S3 流式
  app.get('/download/:code/:fileId', async (req, res) => {
    const idx = readIndex();
    const tid = idx.codes[req.params.code];
    const t = tid && idx.transfers[tid];
    const f = t && t.files.find((x) => x.id === req.params.fileId);
    if (!f) return res.status(404).end('文件不存在');
    if (isExpired(t) || t.terminated) return res.status(410).end('传输已过期或已终止');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.relativePath)}`);
    res.setHeader('Accept-Ranges', 'bytes');
    if (f.storage === 'r2') {
      try {
        await streamR2File(f.id, req.headers.range, res);
      } catch (e) {
        console.error(e);
        if (!res.headersSent) res.status(500).end('R2 下载失败');
      }
      return;
    }
    const p = path.join(UPLOAD_DIR, f.id);
    if (!fs.existsSync(p)) return res.status(404).end('文件不存在');
    const stat = fs.statSync(p);
    const size = stat.size;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : size - 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        return fs.createReadStream(p, { start, end }).pipe(res);
      }
    }
    res.setHeader('Content-Length', size);
    fs.createReadStream(p).pipe(res);
  });

  // 生产：托管 Vite 构建产物 dist；开发：托管 public（兜底）
  const distDir = path.join(__dirname, 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
  } else {
    app.use(express.static(path.join(__dirname, 'public')));
  }
  // SPA 兜底（非 API 请求回 index.html，支持深链）
  app.get(/^(?!\/(api|files|download)).*/, (req, res) => {
    const file = fs.existsSync(distDir)
      ? path.join(distDir, 'index.html')
      : path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(file)) res.sendFile(file);
    else res.status(404).end('未构建前端');
  });

  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '0.0.0.0';

  app.listen(PORT, HOST, () => {
    console.log('闪传 FlashDrop 服务已启动');
    console.log(`  本机:   http://localhost:${PORT}`);
    console.log(`  局域网: http://${getLanIp()}:${PORT}`);
    console.log(`  传输默认有效期: ${DEFAULT_TTL_MS / 3600000} 小时`);
    console.log('  E2EE 使用 crypto-js 纯 JS 实现，HTTP/HTTPS 均可用');
  });
}

function cryptoRandom() {
  return 't_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** 将无空格登录码转为带空格的展示格式 */
function formatLoginCode(raw) {
  if (!raw || raw.length !== 16) return raw;
  return raw.slice(0, 4) + ' ' + raw.slice(4, 8) + ' ' + raw.slice(8, 12) + ' ' + raw.slice(12, 16);
}

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return 'localhost';
}

main().catch((e) => {
  console.error('启动失败', e);
  process.exit(1);
});
