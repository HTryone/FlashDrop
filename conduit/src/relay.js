// HTTP 流式中继 Durable Object。
// 发送端 POST /stream/:room（body = ReadableStream），接收端 GET /stream/:room（返回流式 Response）。
// DO 用 TransformStream 把 POST body 直接 pipeTo 到 GET response——无逐帧转发开销，
// 背压由 TransformStream + pipeTo + ByteLengthQueuingStrategy 原生处理，无需手动 PAUSE/RESUME。
// 不落盘：文件数据只在两端 HTTP 流间过内存。
//
// 协议（长度前缀分帧，HTTP 字节流）：
//   每条消息：[4B u32 BE 长度][payload]
//   第一条：offer JSON（文件清单 {type:'offer', files:[{name,size}]}）
//   后续：数据帧 [FRAME_HDR 12B: fi u16 + ci u32 + plainLen u32][加密体 IV+ct+HMAC]
//   流结束（POST body close）= done 信号，接收端收到 EOF 即完成。

export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // room -> { readable, writable, ready }
    // TransformStream 两端：readable 返回给 GET，writable 接收 POST body
    this.rooms = new Map();
  }

  cors(h = {}) {
    return { 'Access-Control-Allow-Origin': '*', ...h };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: this.cors({
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }),
      });
    }

    // 解析 /stream/:room 或 /stream/:room/ready
    const m = path.match(/^\/stream\/([^/]+)(\/ready)?$/);
    if (!m) return new Response('not found', { status: 404 });
    const room = m[1];
    const isReady = m[2] === '/ready';

    // ---- ready 信号（接收端建好 sinks 后通知发送端可以开始发数据）----
    // POST /stream/:room/ready — 接收端标记就绪
    if (request.method === 'POST' && isReady) {
      const entry = this.rooms.get(room);
      if (entry) entry.ready = true;
      return new Response('ok', { headers: this.cors() });
    }
    // GET /stream/:room/ready — 发送端长轮询，等接收端就绪（最多 30 秒）
    if (request.method === 'GET' && isReady) {
      for (let i = 0; i < 600; i++) {
        const e = this.rooms.get(room);
        if (!e) return new Response('gone', { status: 410, headers: this.cors() });
        if (e.ready) return new Response('ready', { headers: this.cors() });
        await new Promise(r => setTimeout(r, 50));
      }
      return new Response('timeout', { status: 504, headers: this.cors() });
    }

    // ---- 数据流 ----
    // GET /stream/:room — 接收端下载流
    if (request.method === 'GET') {
      let entry = this.rooms.get(room);
      if (!entry) {
        entry = this.createRoom(room);
      }
      // readable 已被消费（上一个接收端拿走了）→ 重新创建
      if (entry.consumed) {
        entry = this.createRoom(room);
      }
      entry.consumed = true;
      return new Response(entry.readable, {
        headers: this.cors({
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-cache',
        }),
      });
    }

    // POST /stream/:room — 发送端上传流
    if (request.method === 'POST') {
      let entry = this.rooms.get(room);
      if (!entry) {
        entry = this.createRoom(room);
      }
      // pipeTo 自带背压：writable 队列满时暂停读 POST body，接收端消费后自动恢复
      try {
        await request.body.pipeTo(entry.writable);
      } catch (e) {
        console.error('[stream] pipe error:', e?.message || e);
      }
      // 传输完成或中断，清理房间
      this.rooms.delete(room);
      return new Response('done', { headers: this.cors() });
    }

    return new Response('not found', { status: 404, headers: this.cors() });
  }

  createRoom(room) {
    const { readable, writable } = new TransformStream(
      {},
      new ByteLengthQueuingStrategy({ highWaterMark: 4 * 1024 * 1024 }),
      new ByteLengthQueuingStrategy({ highWaterMark: 4 * 1024 * 1024 }),
    );
    const entry = { readable, writable, ready: false, consumed: false };
    this.rooms.set(room, entry);
    return entry;
  }
}
