// 本地磁盘模式 —— HTTP 流式中继（不落盘）
//
// 协议（长度前缀分帧，HTTP 字节流）：
//   GET  /stream/:room        — 接收端下载流（流式 Response）
//   POST /stream/:room        — 发送端上传流（ReadableStream body）
//   POST /stream/:room/ready  — 接收端标记就绪
//   GET  /stream/:room/ready  — 发送端长轮询等就绪
//
// DO 用 PassThrough 把 POST body 流式转发给 GET response——无逐帧转发开销，
// 背压由 Node Stream pipe 原生处理。不落盘：文件数据只在两端 HTTP 流间过内存。

import { PassThrough } from 'node:stream';

export function attachRelay(app) {
  // room -> { pass: PassThrough, ready: boolean }
  const rooms = new Map();

  function getRoom(room) {
    let entry = rooms.get(room);
    if (!entry) {
      entry = { pass: new PassThrough(), ready: false };
      rooms.set(room, entry);
    }
    return entry;
  }

  function cleanupRoom(room) {
    const e = rooms.get(room);
    if (e) { e.pass.destroy(); rooms.delete(room); }
  }

  // GET /stream/:room — 接收端下载流
  app.get('/stream/:room', (req, res) => {
    const entry = getRoom(req.params.room);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    entry.pass.pipe(res);
    req.on('close', () => {
      // 接收端断开，清理
      cleanupRoom(req.params.room);
    });
  });

  // POST /stream/:room — 发送端上传流
  app.post('/stream/:room', (req, res) => {
    const entry = getRoom(req.params.room);
    // Node Stream pipe 自带背压：pass 队列满时暂停读 req
    req.pipe(entry.pass);
    req.on('end', () => {
      entry.pass.end();
      res.status(200).send('done');
      // 延迟清理，让 GET 端读完残余数据
      setTimeout(() => cleanupRoom(req.params.room), 5000);
    });
    req.on('error', () => {
      entry.pass.destroy();
      res.status(500).send('error');
      cleanupRoom(req.params.room);
    });
  });

  // POST /stream/:room/ready — 接收端标记就绪
  app.post('/stream/:room/ready', (req, res) => {
    const entry = rooms.get(req.params.room);
    if (entry) entry.ready = true;
    res.status(200).send('ok');
  });

  // GET /stream/:room/ready — 发送端长轮询等就绪
  app.get('/stream/:room/ready', (req, res) => {
    const check = () => {
      const entry = rooms.get(req.params.room);
      if (!entry) { res.status(410).send('gone'); return; }
      if (entry.ready) { res.status(200).send('ready'); return; }
      setTimeout(check, 100);
    };
    check();
  });

  return rooms;
}
