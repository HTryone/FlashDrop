var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/relay.js
var Relay = class {
  static {
    __name(this, "Relay");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = /* @__PURE__ */ new Map();
  }
  cors(h = {}) {
    return { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache, no-store", ...h };
  }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin") || "*";
      const reqHeaders = request.headers.get("Access-Control-Request-Headers") || "Content-Type";
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": reqHeaders,
          "Access-Control-Max-Age": "86400",
          "Cache-Control": "no-cache, no-store"
        }
      });
    }
    const wsMatch = path.match(/^\/ws\/([^/]+)$/);
    if (wsMatch && request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request, wsMatch[1]);
    }
    const m = path.match(/^\/stream\/([^/]+)(\/(ready|close|stat))?$/);
    if (!m) return new Response("not found", { status: 404, headers: this.cors() });
    const room = m[1];
    const sub = m[3];
    if (request.method === "GET" && sub === "stat") {
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
        closed: !!e.closed
      } : { exists: false };
      body.rooms = Array.from(this.rooms.keys());
      return new Response(JSON.stringify(body), {
        headers: this.cors({ "Content-Type": "application/json" })
      });
    }
    if (request.method === "POST" && sub === "ready") {
      const entry = this.rooms.get(room);
      if (entry) {
        entry.ready = true;
        this.notifyReady(entry);
      }
      return new Response("ok", { headers: this.cors() });
    }
    if (request.method === "GET" && sub === "ready") {
      for (let i = 0; i < 600; i++) {
        const e = this.rooms.get(room);
        if (!e) return new Response("gone", { status: 410, headers: this.cors() });
        if (e.ready) return new Response("ready", { headers: this.cors() });
        await new Promise((r) => setTimeout(r, 50));
      }
      return new Response("timeout", { status: 504, headers: this.cors() });
    }
    if (request.method === "POST" && sub === "close") {
      const entry = this.rooms.get(room);
      if (entry && entry.controller) {
        entry.closed = true;
        try {
          entry.controller.close();
        } catch (e) {
        }
        const ws = entry.pullWaiters;
        entry.pullWaiters = [];
        for (const w of ws) {
          try {
            w();
          } catch (e) {
          }
        }
        this.rooms.delete(room);
      }
      return new Response("closed", { headers: this.cors() });
    }
    if (request.method === "GET") {
      let entry = this.rooms.get(room);
      console.log(`[stream] GET ${room}, entry exists=${!!entry}, locked=${entry?.readable.locked}`);
      if (!entry || entry.readable.locked) {
        if (entry && entry.readable.locked) {
          entry.closed = true;
          const ws = entry.pullWaiters;
          entry.pullWaiters = [];
          for (const w of ws) {
            try {
              w();
            } catch (e) {
            }
          }
          this.rooms.delete(room);
        }
        const oldWsSender = entry && entry.wsSender;
        const oldWsReceiver = entry && entry.wsReceiver;
        entry = this.createRoom(room);
        if (oldWsSender) entry.wsSender = oldWsSender;
        if (oldWsReceiver) entry.wsReceiver = oldWsReceiver;
        console.log(`[stream] GET ${room}, created new room`);
      }
      try {
        await entry.controllerReady;
        entry.controller.enqueue(new Uint8Array([0, 0, 0, 1, 0]));
      } catch (e) {
      }
      entry.getConnected = true;
      if (entry.wsSender && entry.wsSender.readyState === 1) {
        Promise.resolve().then(() => {
          if (entry.wsSender && entry.wsSender.readyState === 1) this.sendJSON(entry.wsSender, { type: "pull" });
        });
      }
      return new Response(entry.readable, {
        headers: this.cors({
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-cache"
        })
      });
    }
    if (request.method === "POST") {
      let entry = this.rooms.get(room);
      console.log(`[stream] POST ${room}, entry exists=${!!entry}`);
      if (!entry) entry = this.createRoom(room);
      entry.posts = (entry.posts || 0) + 1;
      try {
        await entry.controllerReady;
        const parts = [];
        let totalLen = 0;
        const reader = request.body.getReader();
        try {
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            totalLen += value.byteLength;
          }
        } finally {
          try {
            reader.releaseLock();
          } catch (e) {
          }
        }
        const body = new Uint8Array(totalLen);
        {
          let off = 0;
          for (const p of parts) {
            body.set(p, off);
            off += p.byteLength;
          }
        }
        let settleOk, settleErr;
        const mine = new Promise((res, rej) => {
          settleOk = res;
          settleErr = rej;
        });
        const task = /* @__PURE__ */ __name(async () => {
          try {
            const STALL_MS = 7e4;
            const t0 = Date.now();
            while (entry.controller && entry.controller.desiredSize !== null && entry.controller.desiredSize <= 0) {
              if (this.rooms.get(room) !== entry) throw new Error("room replaced");
              if (Date.now() - t0 > STALL_MS) throw new Error("backpressure stall: no pull for " + ((Date.now() - t0) / 1e3 | 0) + "s");
              await new Promise((res) => {
                let done = false;
                const w = /* @__PURE__ */ __name(() => {
                  if (!done) {
                    done = true;
                    res();
                  }
                }, "w");
                entry.pullWaiters.push(w);
                setTimeout(w, 2e4);
              });
            }
            if (this.rooms.get(room) !== entry) throw new Error("room replaced");
            if (entry.closed) throw new Error("room closed");
            entry.controller.enqueue(body);
            entry.enqueued = (entry.enqueued || 0) + body.byteLength;
            entry.lastEnqueueAt = Date.now();
            settleOk();
          } catch (e) {
            console.error("[stream] POST enqueue error:", e?.message || e);
            settleErr(e);
          }
        }, "task");
        entry.writeChain = entry.writeChain.then(task, task);
        await mine;
        console.log(`[stream] POST ${room}, enqueued ${totalLen}B`);
      } catch (e) {
        console.error("[stream] POST error:", e?.message || e);
        return new Response("error: " + (e?.message || e), { status: 500, headers: this.cors() });
      }
      return new Response("ok", { headers: this.cors() });
    }
    return new Response("not found", { status: 404, headers: this.cors() });
  }
  handleWebSocket(request, room) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    let entry = this.rooms.get(room);
    if (!entry) entry = this.createRoom(room);
    console.log(`[ws] ${room} role=${new URL(request.url).searchParams.get("role") || "sender"}, room exists=${!!entry}`);
    const url = new URL(request.url);
    const role = url.searchParams.get("role") || "sender";
    const notifyPeerJoined = /* @__PURE__ */ __name((ws, roleName) => {
      if (ws && ws.readyState === 1) {
        Promise.resolve().then(() => {
          if (ws.readyState === 1) this.sendJSON(ws, { type: "peer-joined", role: roleName });
        });
      }
    }, "notifyPeerJoined");
    if (role === "sender") {
      entry.wsSender = server;
      if (entry.getConnected) Promise.resolve().then(() => {
        if (server.readyState === 1) this.sendJSON(server, { type: "pull" });
      });
      if (entry.ready) Promise.resolve().then(() => {
        if (server.readyState === 1) this.sendJSON(server, { type: "ready" });
      });
      if (entry.wsReceiver && entry.wsReceiver.readyState === 1) notifyPeerJoined(entry.wsReceiver, "sender");
      if (entry.wsReceiver && entry.wsReceiver !== server) notifyPeerJoined(server, "receiver");
    } else {
      entry.wsReceiver = server;
      if (entry.wsSender && entry.wsSender.readyState === 1) notifyPeerJoined(entry.wsSender, "receiver");
      if (entry.wsSender && entry.wsSender !== server) notifyPeerJoined(server, "sender");
    }
    const log = entry.signalLog;
    if (log && log.length) {
      for (const item of log) {
        if (item.from !== role && server.readyState === 1) this.sendJSON(server, item.data);
      }
    }
    server.addEventListener("message", (event) => {
      try {
        const cur = this.rooms.get(room) || entry;
        const data = JSON.parse(event.data);
        if (data.type === "ready" && role === "receiver") {
          cur.ready = true;
          this.notifyReady(cur);
        } else if (role === "receiver" && (data.type === "progress" || data.type === "recv-done" || data.type === "recv-ready")) {
          if (cur.wsSender) this.sendJSON(cur.wsSender, data);
        } else if (data.type === "cancel") {
          const target = role === "sender" ? cur.wsReceiver : cur.wsSender;
          if (target) this.sendJSON(target, data);
        } else if (data.type === "rtc-signal") {
          const target = role === "sender" ? cur.wsReceiver : cur.wsSender;
          cur.signalLog = cur.signalLog || [];
          cur.signalLog.push({ from: role, data });
          if (cur.signalLog.length > 200) cur.signalLog.shift();
          if (target) this.sendJSON(target, data);
        }
      } catch (e) {
        console.error("[ws] parse error:", e?.message || e);
      }
    });
    server.addEventListener("close", () => {
      if (role === "sender" && entry.wsSender === server) entry.wsSender = null;
      if (role === "receiver" && entry.wsReceiver === server) entry.wsReceiver = null;
    });
    server.addEventListener("error", (e) => {
      console.error("[ws] error:", e?.message || e);
    });
    return new Response(null, { status: 101, webSocket: client });
  }
  notifyReady(entry) {
    if (entry.wsSender && entry.wsSender.readyState === 1) {
      this.sendJSON(entry.wsSender, { type: "ready" });
    }
  }
  sendJSON(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      console.error("[ws] send error:", e?.message || e);
    }
  }
  createRoom(room) {
    const entry = {};
    let ctrl = null;
    let ctrlResolve = null;
    entry.controllerReady = new Promise((res) => {
      ctrlResolve = res;
    });
    entry.readable = new ReadableStream(
      {
        start(c) {
          ctrl = c;
          entry.controller = c;
          if (ctrlResolve) ctrlResolve();
        },
        pull() {
          entry.lastPullAt = Date.now();
          const ws = entry.pullWaiters;
          if (ws && ws.length) {
            entry.pullWaiters = [];
            for (const w of ws) w();
          }
        }
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 8 * 1024 * 1024 })
    );
    entry.pullWaiters = [];
    entry.writeChain = Promise.resolve();
    entry.ready = false;
    entry.getConnected = false;
    entry.signalLog = [];
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
};

// src/index.js
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/rtc-config") {
      const body = JSON.stringify({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun.qq.com:3478" },
          { urls: "stun:stun.chat.bilibili.com:3478" },
          { urls: "stun:stun.miwifi.com:3478" },
          {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject"
          },
          {
            urls: "turn:openrelay.metered.ca:80?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject"
          }
        ]
      });
      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    if (url.pathname.startsWith("/stream/") || url.pathname.startsWith("/ws/")) {
      const parts = url.pathname.split("/");
      const room = parts[2];
      if (!room) return new Response("need room", { status: 400 });
      const id = env.RELAY.idFromName(room);
      const stub = env.RELAY.get(id);
      return stub.fetch(request);
    }
    return new Response("FlashDrop relay", { status: 200 });
  }
};
export {
  Relay,
  index_default as default
};
//# sourceMappingURL=index.js.map
