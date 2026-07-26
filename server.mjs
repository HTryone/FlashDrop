import express from 'express';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const INDEX_FILE = path.join(UPLOAD_DIR, 'index.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- 分享码 <-> 文件清单 索引（单进程，同步读写足够）----
function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeIndex(idx) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}

// ---- tus 可续传上传服务 ----
const tusServer = new Server({
  path: '/files',
  datastore: new FileStore({ directory: UPLOAD_DIR }),
  respectForwardedHeaders: true,
  maxSize: 30 * 1024 * 1024 * 1024, // 允许最大 30GB（覆盖 20G 需求）
  onUploadFinish: async (req, upload) => {
    const meta = upload.metadata || {};
    const code = meta.transferId;
    if (!code) return {}; // 没有分享码则无法登记，按默认 204 返回
    const name = meta.filename || upload.id;
    const rel = meta.relativePath || name;
    const idx = readIndex();
    if (!idx[code]) idx[code] = { createdAt: Date.now(), files: [] };
    if (!idx[code].files.find((f) => f.id === upload.id)) {
      idx[code].files.push({
        id: upload.id,
        filename: name,
        relativePath: rel,
        size: Number(upload.size),
        path: path.join(UPLOAD_DIR, upload.id),
      });
    }
    writeIndex(idx);
    return {};
  },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 把 /files 全部交给 tus 处理（含子路径 /files/<id>）
// 用显式路由，保留原始 req.url 让 tus 正确解析上传 id
app.all('/files', (req, res) => tusServer.handle(req, res));
app.all('/files/:id', (req, res) => tusServer.handle(req, res));

// 列出某分享码下的文件
app.get('/api/transfer/:code', (req, res) => {
  const idx = readIndex();
  const t = idx[req.params.code];
  if (!t) return res.status(404).json({ error: '未找到，可能还在上传或链接有误' });
  res.json({
    files: t.files.map((f) => ({ id: f.id, name: f.relativePath, size: f.size })),
  });
});

// 全部打包为 zip 下载（流式，不占内存）
// 注意：必须放在 /download/:code/:fileId 之前，否则 "zip" 会被当成 fileId
app.get('/download/:code/zip', (req, res) => {
  const idx = readIndex();
  const t = idx[req.params.code];
  if (!t) return res.status(404).end('未找到');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="transfer-${req.params.code}.zip"`);
  const archive = archiver('zip');
  archive.on('warning', (e) => {
    if (e.code !== 'ENOENT') console.error(e);
  });
  archive.on('error', (e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);
  for (const f of t.files) {
    if (fs.existsSync(f.path)) archive.file(f.path, { name: f.relativePath });
  }
  archive.finalize();
});

// 单文件断点下载（支持 Range）
app.get('/download/:code/:fileId', (req, res) => {
  const idx = readIndex();
  const t = idx[req.params.code];
  const f = t && t.files.find((x) => x.id === req.params.fileId);
  if (!f || !fs.existsSync(f.path)) return res.status(404).end('文件不存在');
  const stat = fs.statSync(f.path);
  const size = stat.size;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.relativePath)}`);
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : size - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(f.path, { start, end }).pipe(res);
    }
  }
  res.setHeader('Content-Length', size);
  fs.createReadStream(f.path).pipe(res);
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log('点对点传输服务已启动');
  console.log('  本机:   http://localhost:' + PORT);
  console.log('  局域网: http://' + getLanIp() + ':' + PORT);
});

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return 'localhost';
}
