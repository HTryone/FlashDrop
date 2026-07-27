// HTTP 流式中继 Durable Object + WebSocket 控制通道（标准 API，不 hibernation）。
// 构建触发标记：2026-07-27 确保前端+Worker 同步部署
//
// 数据平面（HTTP 流式，快）：
//   发送端 POST /stream/:room（body = ReadableStream，分片 <100MB）
//   接收端 GET  /stream/:room（返回流式 Response，整条传输期间一直开着）
//   DO 用 TransformStream 把 POST body 直接 pipeTo 到 GET response。
//
// 控制平面（WebSocket，保持 DO 活跃）：
//   /ws/:room?role=sender|receiver
//   接收端连上后发 {type:'ready'}，DO 转发给发送端。
//   用 WebSocket 标准 API (server.accept()) 让 DO 不被 hibernation/eviction，
//   从而 rooms 中的 TransformStream 内存状态得以保留。
//
// 不落盘：文件数据只在两端 HTTP 流间过内存。
//
// Cloudflare 请求体限制：Free/Pro 100MB / Business 200MB / Enterprise 500MB。
// 发送端按 ~80MB 分片，每片一个 POST，pipeTo 用 preventClose:true 不关 writable；
// 全部数据发完后 POST /stream/:room/close 关闭 writable → GET 收到 EOF = done。
//
// 协议（长度前缀分帧，HTTP 字节流）：
//   每条消息：[4B u32 BE 长度][payload]
//   第一条：offer JSON（文件清单 {type:'offer', files:[{name,size}]}）
//   后续：数据帧 [FRAME_HDR 12B: fi u16 + ci u32 + plainLen u32][加密体 IV+ct+HMAC]
//   POST /close 关闭流 → 接收端收到 EOF 即完成。

export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // room -> { readable, writable, ready, consumed, wsSender, wsReceiver }
    this.rooms = new Map();
  }

  cors(h = {}) {
    return { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, no-store', ...h };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检：显式回显 Origin 与请求头（不要用 '*'，部分浏览器拒 '*'），并缓存 1 天
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin') || '*';
      const reqHeaders = request.headers.get('Access-Control-Request-Headers') || 'Content-Type';
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': reqHeaders,
          'Access-Control-Max-Age': '86400',
          'Cache-Control': 'no-cache, no-store',
        },
      });
    }

    // ---- WebSocket 控制通道 ----
    const wsMatch = path.match(/^\/ws\/([^/]+)$/);
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request, wsMatch[1]);
    }

    // ---- HTTP 数据流 ----
    const m = path.match(/^\/stream\/([^/]+)(\/(ready|close))?$/);
    if (!m) return new Response('not found', { status: 404, headers: this.cors() });
    const room = m[1];
    const sub = m[3]; // 'ready' | 'close' | undefined

    // POST /stream/:room/ready — 兼容旧长轮询（保留，但新前端改用 ws）
    if (request.method === 'POST' && sub === 'ready') {
      const entry = this.rooms.get(room);
      if (entry) {
        entry.ready = true;
        this.notifyReady(entry);
      }
      return new Response('ok', { headers: this.cors() });
    }

    // GET /stream/:room/ready — 兼容旧长轮询
    if (request.method === 'GET' && sub === 'ready') {
      for (let i = 0; i < 600; i++) {
        const e = this.rooms.get(room);
        if (!e) return new Response('gone', { status: 410, headers: this.cors() });
        if (e.ready) return new Response('ready', { headers: this.cors() });
        await new Promise(r => setTimeout(r, 50));
      }
      return new Response('timeout', { status: 504, headers: this.cors() });
    }

    // POST /stream/:room/close — 发送端通知传输结束
    if (request.method === 'POST' && sub === 'close') {
      const entry = this.rooms.get(room);
      if (entry) {
        try {
          const writer = entry.writable.getWriter();
          await writer.close();
          writer.releaseLock();
        } catch (e) {
          // writable 可能已关闭（接收端断开等），忽略
        }
        this.rooms.delete(room);
      }
      return new Response('closed', { headers: this.cors() });
    }

    // GET /stream/:room — 接收端下载流
    if (request.method === 'GET') {
      let entry = this.rooms.get(room);
      console.log(`[stream] GET ${room}, entry exists=${!!entry}, locked=${entry?.readable.locked}`);
      if (!entry || entry.readable.locked) {
        // 如果已有房间但 readable 被占用（接收端重连/重复 GET），
        // 必须重建房间，否则 new Response(entry.readable) 会抛
        // "ReadableStream is disturbed (has already been read from)"
        if (entry && entry.readable.locked) this.rooms.delete(room);
        entry = this.createRoom(room);
        console.log(`[stream] GET ${room}, created new room`);
      }
      // 关键修复：立即往流里写 1 字节「开场帧」，防止 Cloudflare 缓冲空响应体。
      // 现象：接收端先连 GET 时 DO 的 TransformStream 还是空的，Cloudflare 边缘会
      // 一直等、把响应缓存到发送端 /close（上传完成）才整体下发，表现为
      // 「下载在上传完成后才开始、且只有 ~200KB/s」。写开场帧后响应立即开始流式下发。
      // 接收端会跳过这个非 offer 帧（见 LocalTransfer.vue）。
      try {
        const ow = entry.writable.getWriter();
        await ow.write(new Uint8Array([0, 0, 0, 1, 0x00])); // [4B 长度前缀=1][1字节 0x00]
        ow.releaseLock();
      } catch (e) {
        // writable 可能已被关闭，忽略
      }
      return new Response(entry.readable, {
        headers: this.cors({
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-cache',
        }),
      });
    }

    // POST /stream/:room — 发送端分片上传（复用 GET 创建的同一个 room）
    if (request.method === 'POST') {
      let entry = this.rooms.get(room);
      console.log(`[stream] POST ${room}, entry exists=${!!entry}`);
      if (!entry) entry = this.createRoom(room);
      try {
        console.log(`[stream] POST ${room}, starting pipeTo`);
        await request.body.pipeTo(entry.writable, { preventClose: true });
        console.log(`[stream] POST ${room}, pipeTo completed`);
      } catch (e) {
        console.error('[stream] pipe error:', e?.message || e);
        return new Response('error', { status: 500, headers: this.cors() });
      }
      return new Response('ok', { headers: this.cors() });
    }

    return new Response('not found', { status: 404, headers: this.cors() });
  }

  handleWebSocket(request, room) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // 标准 API：保持 DO 活跃，rooms 内存状态不丢
    server.accept();

    let entry = this.rooms.get(room);
    if (!entry) entry = this.createRoom(room);
    console.log(`[ws] ${room} role=${new URL(request.url).searchParams.get('role') || 'sender'}, room exists=${!!entry}`);

    const url = new URL(request.url);
    const role = url.searchParams.get('role') || 'sender';

    if (role === 'sender') {
      entry.wsSender = server;
      // 若接收端已就绪，立即通知
      if (entry.ready) this.sendJSON(server, { type: 'ready' });
    } else {
      entry.wsReceiver = server;
    }

    server.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'ready' && role === 'receiver') {
          entry.ready = true;
          this.notifyReady(entry);
        } else if (role === 'receiver' && (data.type === 'progress' || data.type === 'recv-done')) {
          // 接收端进度/完成回传 → 转发给发送端，由其驱动进度条与完成态
          if (entry.wsSender) this.sendJSON(entry.wsSender, data);
        }
      } catch (e) {
        console.error('[ws] parse error:', e?.message || e);
      }
    });

    server.addEventListener('close', () => {
      if (role === 'sender' && entry.wsSender === server) entry.wsSender = null;
      if (role === 'receiver' && entry.wsReceiver === server) entry.wsReceiver = null;
    });

    server.addEventListener('error', (e) => {
      console.error('[ws] error:', e?.message || e);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  notifyReady(entry) {
    if (entry.wsSender && entry.wsSender.readyState === 1) {
      this.sendJSON(entry.wsSender, { type: 'ready' });
    }
  }

  sendJSON(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      console.error('[ws] send error:', e?.message || e);
    }
  }

  createRoom(room) {
    const { readable, writable } = new TransformStream(
      {},
      new ByteLengthQueuingStrategy({ highWaterMark: 4 * 1024 * 1024 }),
      new ByteLengthQueuingStrategy({ highWaterMark: 4 * 1024 * 1024 }),
    );
    const entry = {
      readable, writable, ready: false,
      wsSender: null, wsReceiver: null,
    };
    this.rooms.set(room, entry);
    console.log(`[room] created ${room}, total rooms=${this.rooms.size}`);
    return entry;
  }
}
