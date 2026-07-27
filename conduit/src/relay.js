// 每个房间一个 Durable Object 实例，两端 WebSocket 在此会合、内存转发。
// 不落盘：文件数据只在两端 WebSocket 间流过内存。
// 使用 Hibernatable WebSocket API（state.acceptWebSocket），生产环境稳定可靠。
//
// 流控原则（v3）：
//   1. 二进制帧进「有界队列」但【绝不丢弃】，靠接收端 pause 控制上游速度。
//   2. 对端 WS 缓冲满（peer.send 返回 false）时保留队列，用定时器重试排空，
//      不依赖「新消息到来」才重试（否则发送端暂停后队列永远卡死）。
//   3. 队列积压超 PAUSE_BYTES 时，中继自行发 pause(src:'relay') 给发送端作兜底，
//      正常情况下接收端会在更早（自身 16MB 积压）就先发 pause。
export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // 每对 peer 一个发送队列；key 为 "room:sender" / "room:receiver"
    this.queues = new Map();
    // 背压兜底阈值：队列积压超过 PAUSE_BYTES 时中继自行发 pause 给发送端；
    // 正常情况下接收端会在更早（自身 16MB 积压）就发 pause，这里是防 pause 信令丢失的最后保险。
    this.PAUSE_BYTES = 32 * 1024 * 1024; // 32MB
    this.RESUME_BYTES = 8 * 1024 * 1024;  // 8MB
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = url.searchParams.get('room');
    const role = url.searchParams.get('role');
    if (!room || !role) return new Response('need room & role', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ room, role });
    this.state.acceptWebSocket(server);

    // 双向通知：老一端收到「新端加入」，新一端收到「对端已在线」
    const peer = this.findPeer(room, role === 'sender' ? 'receiver' : 'sender');
    if (peer) {
      peer.send(JSON.stringify({ type: 'peer-joined', role }));
      server.send(JSON.stringify({ type: 'peer-joined', role: role === 'sender' ? 'receiver' : 'sender' }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  findPeer(room, role) {
    const all = [...this.state.getWebSockets()];
    return all.find((ws) => {
      const att = ws.deserializeAttachment();
      return att && att.room === room && att.role === role;
    });
  }

  // 获取/创建某方向的发送队列
  getQueue(room, fromRole) {
    const key = `${room}:${fromRole}`;
    if (!this.queues.has(key)) {
      this.queues.set(key, { bytes: 0, frames: [], draining: false, paused: false, drainTimer: null });
    }
    return this.queues.get(key);
  }

  // 尝试排空队列（由 webSocketMessage 或 scheduleDrain 调用）。绝不丢弃帧。
  tryDrain(queue, peer, room) {
    if (queue.draining || !peer || queue.frames.length === 0) return;
    queue.draining = true;
    try {
      while (queue.frames.length > 0) {
        const msg = queue.frames[0];
        let ok = true;
        try { ok = peer.send(msg); } catch { ok = false; }
        if (!ok) {
          // 对端 WS 缓冲区满：保留队列，稍后定时重试（不依赖新消息到来）
          this.scheduleDrain(queue, peer, room);
          break;
        }
        queue.frames.shift();
        queue.bytes -= msg.byteLength || 0;
        if (queue.bytes < 0) queue.bytes = 0;
      }
    } finally {
      queue.draining = false;
    }
    // 背压兜底：队列积压过多则通知【发送端】暂停（防 pause 信令丢失导致 DO 内存爆）
    const sender = this.findPeer(room, 'sender');
    if (!sender) return;
    if (queue.bytes > this.PAUSE_BYTES && !queue.paused) {
      queue.paused = true;
      try { sender.send(JSON.stringify({ type: 'pause', src: 'relay' })); } catch {}
    } else if (queue.bytes < this.RESUME_BYTES && queue.paused) {
      queue.paused = false;
      try { sender.send(JSON.stringify({ type: 'resume', src: 'relay' })); } catch {}
    }
  }

  // 对端缓冲满时，用定时器重试排空（DO 活跃传输期间定时可靠触发）
  scheduleDrain(queue, peer, room) {
    if (queue.drainTimer) return;
    queue.drainTimer = setTimeout(() => {
      queue.drainTimer = null;
      this.tryDrain(queue, peer, room);
    }, 50);
  }

  webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment();
    const peerRole = att.role === 'sender' ? 'receiver' : 'sender';
    const peer = this.findPeer(att.room, peerRole);
    if (!peer) return; // 对端还没连，丢弃

    // 文本控制消息（JSON）直接转发，不走队列（pause/resume/ack/done/offer 等）
    if (typeof message === 'string') {
      peer.send(message);
      return;
    }

    // 二进制数据帧：进有界队列，**绝不丢弃**，靠接收端 pause 控制上游速度
    const queue = this.getQueue(att.room, att.role);
    const msgSize = message.byteLength || 0;
    queue.frames.push(message);
    queue.bytes += msgSize;

    this.tryDrain(queue, peer, att.room);
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (att) {
      const peer = this.findPeer(att.room, att.role === 'sender' ? 'receiver' : 'sender');
      if (peer) peer.send(JSON.stringify({ type: 'peer-left' }));
      // 清理该方向的队列（含定时器）
      const keys = [
        `${att.room}:${att.role}`,
        `${att.room}:${att.role === 'sender' ? 'receiver' : 'sender'}`,
      ];
      for (const k of keys) {
        const q = this.queues.get(k);
        if (q && q.drainTimer) { clearTimeout(q.drainTimer); q.drainTimer = null; }
        this.queues.delete(k);
      }
    }
    ws.close();
  }

  webSocketError(ws) {
    ws.close();
  }
}
