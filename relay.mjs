// 本地磁盘模式 —— HTTP 流式中继 + WebSocket 控制通道（不落盘）
//
// 数据平面（HTTP 流式，快）：
//   GET  /stream/:room         — 接收端下载流（流式 Response）
//   POST /stream/:room         — 发送端分片上传（ReadableStream body，每片 <100MB）
//   POST /stream/:room/close   — 发送端通知传输结束（关闭 pass → GET 收到 EOF）
//
// 控制平面（WebSocket，保持 DO 活跃）：
//   /ws/:room?role=sender|receiver
//   接收端连上后发 {type:'ready'}，服务器转发给发送端。
//
// 多片 POST：req.pipe(pass, {end:false}) 不关 pass，等 /close 来关。
// 背压由 Node Stream pipe 原生处理。不落盘：文件数据只在两端 HTTP 流间过内存。

import { PassThrough } from 'node:stream';
import { WebSocketServer } from 'ws';

export function attachRelay(server, app) {
  // room -> { pass: PassThrough, ready: boolean, wsSender: WebSocket|null, wsReceiver: WebSocket|null }
  const rooms = new Map();

  function getRoom(room, allowReplace = false) {
    let entry = rooms.get(room);
    if (!entry || (allowReplace && entry.res)) {
      if (entry && entry.res) {
        // 接收端重连：断开旧响应，新 GET 接管 PassThrough
        try { entry.pass.unpipe(entry.res); entry.res.end(); } catch {}
      }
      entry = { pass: new PassThrough(), ready: false, wsSender: null, wsReceiver: null, res: null };
      rooms.set(room, entry);
    }
    return entry;
  }

  function cleanupRoom(room) {
    const e = rooms.get(room);
    if (e) {
      e.pass.destroy();
      if (e.wsSender) { try { e.wsSender.close(); } catch {} e.wsSender = null; }
      if (e.wsReceiver) { try { e.wsReceiver.close(); } catch {} e.wsReceiver = null; }
      rooms.delete(room);
    }
  }

  function notifyReady(entry) {
    if (entry.wsSender && entry.wsSender.readyState === 1) {
      try { entry.wsSender.send(JSON.stringify({ type: 'ready' })); } catch {}
    }
  }

  // WebSocket 控制通道
  // 注意：ws 库的 path 参数是精确匹配，不能写 '/ws/' 来匹配 '/ws/ROOM'，所以不传 path，手动校验
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const match = (req.url || '').match(/^\/ws\/([^/?]+)/);
    if (!match) { ws.close(); return; }
    const room = match[1];
    const params = new URLSearchParams((req.url || '').split('?')[1] || '');
    const role = params.get('role') || 'sender';
    const entry = getRoom(room);

    if (role === 'sender') {
      entry.wsSender = ws;
      if (entry.ready) notifyReady(entry);
    } else {
      entry.wsReceiver = ws;
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ready' && role === 'receiver') {
          entry.ready = true;
          notifyReady(entry);
        }
      } catch {}
    });

    ws.on('close', () => {
      if (role === 'sender' && entry.wsSender === ws) entry.wsSender = null;
      if (role === 'receiver' && entry.wsReceiver === ws) entry.wsReceiver = null;
    });
  });

  // GET /stream/:room — 接收端下载流
  app.get('/stream/:room', (req, res) => {
    const entry = getRoom(req.params.room, true);
    entry.res = res;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    entry.pass.pipe(res);
    req.on('close', () => {
      if (entry.res === res) entry.res = null;
      cleanupRoom(req.params.room);
    });
  });

  // POST /stream/:room — 发送端分片上传（多片，不关 pass）
  app.post('/stream/:room', (req, res) => {
    const entry = getRoom(req.params.room);
    req.pipe(entry.pass, { end: false });
    req.on('end', () => {
      res.status(200).send('ok');
    });
    req.on('error', () => {
      entry.pass.destroy();
      res.status(500).send('error');
      cleanupRoom(req.params.room);
    });
  });

  // POST /stream/:room/close — 发送端通知传输结束
  app.post('/stream/:room/close', (req, res) => {
    const entry = rooms.get(req.params.room);
    if (entry) {
      entry.pass.end();
      setTimeout(() => cleanupRoom(req.params.room), 5000);
    }
    res.status(200).send('closed');
  });

  // POST /stream/:room/ready — 兼容旧长轮询
  app.post('/stream/:room/ready', (req, res) => {
    const entry = rooms.get(req.params.room);
    if (entry) {
      entry.ready = true;
      notifyReady(entry);
    }
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, no-store' });
    res.status(200).send('ok');
  });

  // GET /stream/:room/ready — 兼容旧长轮询
  app.get('/stream/:room/ready', (req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, no-store' });
    const start = Date.now();
    const check = () => {
      const entry = rooms.get(req.params.room);
      if (!entry) { res.status(410).send('gone'); return; }
      if (entry.ready) { res.status(200).send('ready'); return; }
      if (Date.now() - start > 30000) { res.status(504).send('timeout'); return; }
      setTimeout(check, 100);
    };
    check();
  });

  return rooms;
}
