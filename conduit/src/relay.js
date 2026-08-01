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
    const m = path.match(/^\/stream\/([^/]+)(\/(ready|close|stat))?$/);
    if (!m) return new Response('not found', { status: 404, headers: this.cors() });
    const room = m[1];
    const sub = m[3]; // 'ready' | 'close' | 'stat' | undefined

    // GET /stream/:room/stat — 诊断端点：暴露房间实时内部状态，用于线上定位卡死
    if (request.method === 'GET' && sub === 'stat') {
      const e = this.rooms.get(room);
      const body = e ? {
        exists: true,
        locked: e.readable.locked,
        desiredSize: e.controller ? e.controller.desiredSize : null,
        pullWaiters: e.pullWaiters.length,
        getConnected: e.getConnected,
        wsSender: !!(e.wsSender && e.wsSender.readyState === 1),
        wsReceiver: !!(e.wsReceiver && e.wsReceiver.readyState === 1),
        ready: e.ready,
        posts: e.posts || 0,
        enqueued: e.enqueued || 0,
        msSinceLastPull: e.lastPullAt ? Date.now() - e.lastPullAt : null,
        msSinceLastEnqueue: e.lastEnqueueAt ? Date.now() - e.lastEnqueueAt : null,
        closed: !!e.closed,
      } : { exists: false };
      body.rooms = Array.from(this.rooms.keys());
      return new Response(JSON.stringify(body), {
        headers: this.cors({ 'Content-Type': 'application/json' }),
      });
    }

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
      if (entry && entry.controller) {
        entry.closed = true;
        try {
          // 关闭可读流 → 接收端 GET 收到 EOF = 传输完成
          entry.controller.close();
        } catch (e) {
          // 流可能已关闭（接收端断开等），忽略
        }
        // 唤醒所有因背压挂起的写入者，避免它们悬在已关闭的房间上拖住 writeChain
        const ws = entry.pullWaiters;
        entry.pullWaiters = [];
        for (const w of ws) { try { w(); } catch (e) { /* ignore */ } }
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
        if (entry && entry.readable.locked) {
          // 旧房间即将被丢弃：先唤醒挂在它上面的背压等待者，让它们感知
          // 「room replaced」而快速失败重试，避免永久挂起堵死 writeChain
          entry.closed = true;
          const ws = entry.pullWaiters;
          entry.pullWaiters = [];
          for (const w of ws) { try { w(); } catch (e) { /* ignore */ } }
          this.rooms.delete(room);
        }
        const oldWsSender = entry && entry.wsSender;
        const oldWsReceiver = entry && entry.wsReceiver;
        entry = this.createRoom(room);
        // 房间重建必须继承 WS 绑定：否则发送端的 WS 还挂在旧 entry 上，
        // 新 entry 的 wsSender=null → pull / recv-ready / progress 全部丢失 → 发送端永久等待
        if (oldWsSender) entry.wsSender = oldWsSender;
        if (oldWsReceiver) entry.wsReceiver = oldWsReceiver;
        console.log(`[stream] GET ${room}, created new room`);
      }
      // 关键修复：立即往流里写 1 字节「开场帧」，防止 Cloudflare 缓冲空响应体。
      // 现象：接收端先连 GET 时 DO 的流还是空的，Cloudflare 边缘会
      // 一直等、把响应缓存到发送端 /close（上传完成）才整体下发，表现为
      // 「下载在上传完成后才开始、且只有 ~200KB/s」。写开场帧后响应立即开始流式下发。
      // 接收端会跳过这个非 offer 帧（见 LocalTransfer.vue）。
      // 必须等 controller 就绪（ReadableStream.start 回调异步设置），否则 enqueue 会抛错 500。
      try {
        await entry.controllerReady;
        entry.controller.enqueue(new Uint8Array([0, 0, 0, 1, 0x00])); // [4B 长度前缀=1][1字节 0x00]
      } catch (e) {
        // 流可能已被关闭，忽略
      }
      // 权威「拉取」信号：接收端 GET 已连上、可读流已建立 → 立即通知发送端可以推数据。
      // 取代依赖应用层 recv-ready WS 消息的脆弱握手：pull 由 relay 自身在 GET 连上时发出，
      // 保证发送端推数据前接收端 GET 一定已就绪 → 消灭「死锁(GET 连了没人推)」「孤儿(推了没人拉)」。
      entry.getConnected = true;
      // onopen 回调内同步 send 在 CF DO 上偶发静默丢失；改用微任务异步发送，确保 pull 必达
      if (entry.wsSender && entry.wsSender.readyState === 1) {
        Promise.resolve().then(() => { if (entry.wsSender && entry.wsSender.readyState === 1) this.sendJSON(entry.wsSender, { type: 'pull' }); });
      }
      return new Response(entry.readable, {
        headers: this.cors({
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-cache',
        }),
      });
    }

    // POST /stream/:room — 发送端分片上传（并发多 POST 合并进同一条可读流）
    // 旧逻辑用 entry.writable 单写者 pipeTo：并发 POST 会抢锁失败、只能串行。
    // 新逻辑：每个 POST 把自己的请求体逐块 enqueue 进 room 的 ReadableStream controller，
    // 多个 POST 并发写入同一 controller（JS 单线程，enqueue 原子），由接收端 GET 顺序读出。
    // 背压：controller.desiredSize<=0（接收端读不动）时暂停读 request.body → 反向传导到发送端。
    if (request.method === 'POST') {
      let entry = this.rooms.get(room);
      console.log(`[stream] POST ${room}, entry exists=${!!entry}`);
      if (!entry) entry = this.createRoom(room);
      entry.posts = (entry.posts || 0) + 1;
      try {
        // 等 controller 就绪（GET 的 ReadableStream.start 设置），否则 enqueue 会抛 500
        await entry.controllerReady;

        // ---- 阶段 1：把整个请求体读进内存（原子单元，发送端按 ~4MB 分片）----
        // 关键修复（原子性）：旧实现边读边 enqueue，POST 中途失败会在房间流里留下「半截字节」，
        // 破坏长度前缀分帧 → 接收端永久错位；且发送端无法安全重发。
        // 改为「整体读完才入队」：读失败则一个字节都不入队 → 房间不受污染 → 发送端重发同一份字节完全安全。
        const parts = [];
        let totalLen = 0;
        const reader = request.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            totalLen += value.byteLength;
          }
        } finally {
          try { reader.releaseLock(); } catch (e) { /* 已释放 */ }
        }
        const body = new Uint8Array(totalLen);
        {
          let off = 0;
          for (const p of parts) { body.set(p, off); off += p.byteLength; }
        }

        // ---- 阶段 2：串行入队 ----
        // writeChain 串行化各 POST 的 enqueue，保证帧字节连续不交叉（并发上传前提）。
        // 致命 bug 修复（链毒化）：旧写法 `writeChain.then(pump).catch(e=>{throw e})` 会让 writeChain
        // 永久变成 rejected —— 之后每个 POST 的 .then(pump) 都被跳过、直接透传 rejection 秒回 500，
        // 房间永久报废、传输速度归零。现用 then(task, task)：无论前序成败都执行本任务，
        // 且 task 内部自行 try/catch 绝不 reject → writeChain 永远保持 fulfilled，单个 POST 失败互不牵连。
        let settleOk, settleErr;
        const mine = new Promise((res, rej) => { settleOk = res; settleErr = rej; });
        const task = async () => {
          try {
            // 背压：可读流缓冲满则等接收端拉取（pull 回调唤醒所有等待者）。
            // 关键修复（活性）：旧写法无限等 pullWaiters —— 接收端一旦消失（GET 被中断、
            // 房间被重建、页面关闭），pull 永不触发 → 本 task 永久挂起 → writeChain 被堵死
            // → 该房间之后每个 POST 都无限 pending → 表现为「速度归零、双方 UI 仍显示传输中」。
            // 现改为带超时的等待：单轮最多 20s，累计无 pull 超过 STALL_MS 则判定接收端已死，
            // 快速失败返回 503 让发送端重试（帧带 (fi,ci)，重发幂等），绝不拖垮整条链。
            const STALL_MS = 70000; // < Cloudflare ~100s 请求上限，抢在被掐断前主动失败
            const t0 = Date.now();
            while (entry.controller && entry.controller.desiredSize !== null && entry.controller.desiredSize <= 0) {
              if (this.rooms.get(room) !== entry) throw new Error('room replaced');
              if (Date.now() - t0 > STALL_MS) throw new Error('backpressure stall: no pull for ' + ((Date.now() - t0) / 1000 | 0) + 's');
              await new Promise((res) => {
                let done = false;
                const w = () => { if (!done) { done = true; res(); } };
                entry.pullWaiters.push(w);
                setTimeout(w, 20000);
              });
            }
            // 关键修复（陈旧房间）：等待期间房间可能已被 /close 或 GET 重建替换。
            // 若仍向旧 entry.controller 入队，字节会流进一条没人读的孤儿流并永久丢失
            // （接收端已收到 EOF），发送端却拿到 200 以为成功 → 静默丢数据。
            if (this.rooms.get(room) !== entry) throw new Error('room replaced');
            if (entry.closed) throw new Error('room closed');
            entry.controller.enqueue(body);
            entry.enqueued = (entry.enqueued || 0) + body.byteLength;
            entry.lastEnqueueAt = Date.now();
            settleOk();
          } catch (e) {
            console.error('[stream] POST enqueue error:', e?.message || e);
            settleErr(e);
          }
        };
        entry.writeChain = entry.writeChain.then(task, task);
        await mine;
        console.log(`[stream] POST ${room}, enqueued ${totalLen}B`);
      } catch (e) {
        console.error('[stream] POST error:', e?.message || e);
        return new Response('error: ' + (e?.message || e), { status: 500, headers: this.cors() });
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
      // 接收端 GET 已连上则立即驱动发送端推数据（即使 pull 在 GET 时因 WS 未连而没发出）。
      // onopen 回调内同步 send 在 CF DO 上偶发静默丢失，改用微任务异步发送，确保 pull/ready 必达。
      if (entry.getConnected) Promise.resolve().then(() => { if (server.readyState === 1) this.sendJSON(server, { type: 'pull' }); });
      if (entry.ready) Promise.resolve().then(() => { if (server.readyState === 1) this.sendJSON(server, { type: 'ready' }); });
    } else {
      entry.wsReceiver = server;
    }

    server.addEventListener('message', (event) => {
      try {
        // 房间可能在 GET 重连时被重建，必须实时取当前 entry，不能用闭包里的旧引用
        const cur = this.rooms.get(room) || entry;
        const data = JSON.parse(event.data);
        if (data.type === 'ready' && role === 'receiver') {
          cur.ready = true;
          this.notifyReady(cur);
        } else if (role === 'receiver' && (data.type === 'progress' || data.type === 'recv-done' || data.type === 'recv-ready')) {
          // 接收端进度/完成回传 → 转发给发送端，由其驱动进度条与完成态
          if (cur.wsSender) this.sendJSON(cur.wsSender, data);
        } else if (data.type === 'rtc-signal') {
          // P2P WebRTC 信令透传：把 SDP/ICE 转发给房间内对端（sender↔receiver）。
          // 信令房间用 `${room}::p2p` 命名空间，与 HTTP 控制通道互不干扰；
          // 此分支只处理 P2P 信令，绝不动 HTTP 的 ready/progress 等控制消息。
          const target = role === 'sender' ? cur.wsReceiver : cur.wsSender;
          if (target) this.sendJSON(target, data);
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
    // 用 ReadableStream + controller 取代 TransformStream：支持多个 POST 并发写入同一流。
    // controller.desiredSize 驱动背压（接收端读不动时暂停读 POST body）。
    // 关键：controller 由 start() 设置；用闭包局部变量捕获 resolver，避免「构造后才赋值」导致的竞态。
    const entry = {};
    let ctrl = null;
    let ctrlResolve = null;
    entry.controllerReady = new Promise((res) => { ctrlResolve = res; });
    entry.readable = new ReadableStream(
      {
        start(c) {
          ctrl = c;
          entry.controller = c;
          if (ctrlResolve) ctrlResolve();
        },
        pull() {
          // 消费方拉取 → 唤醒因背压暂停的所有 POST 写入（并发下不能用单一 waiter）
          entry.lastPullAt = Date.now();
          const ws = entry.pullWaiters;
          if (ws && ws.length) {
            entry.pullWaiters = [];
            for (const w of ws) w();
          }
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 8 * 1024 * 1024 }),
    );
    entry.pullWaiters = [];        // 背压等待者数组（pull 时全部唤醒）
    entry.writeChain = Promise.resolve();  // 串行化各 POST 的 enqueue，保证帧连续不交叉
    entry.ready = false;
    entry.getConnected = false;
    entry.closed = false;
    entry.posts = 0;
    entry.enqueued = 0;
    entry.lastPullAt = 0;
    entry.lastEnqueueAt = 0;
    entry.wsSender = null;
    entry.wsReceiver = null;
    this.rooms.set(room, entry);
    console.log(`[room] created ${room}, total rooms=${this.rooms.size}`);
    return entry;
  }
}
