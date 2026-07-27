// 每个房间一个 Durable Object 实例，两端 WebSocket 在此会合、内存转发。
// 不落盘：文件数据只在两端 WebSocket 间流过内存。
// 使用 Hibernatable WebSocket API（state.acceptWebSocket），生产环境稳定可靠。
//
// v2: 加入背压保护。接收端处理慢时，DO 内存不会无限堆积导致被 Cloudflare 杀掉。
export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // 每对 peer 一个发送队列；key 为 "room:sender" / "room:receiver"
    this.queues = new Map();
    // 单个队列最大积压字节数（超过后丢弃最旧帧，防止 DO 内存爆）
    this.MAX_QUEUE_BYTES = 32 * 1024 * 1024; // 32MB（2MB/帧下可缓存 ~15 帧）
    // 单个队列最大积压帧数
    this.MAX_QUEUE_FRAMES = 100;              // 2MB/帧 × 100 = 200MB 上限（字节优先触发）
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
      this.queues.set(key, { bytes: 0, frames: [], draining: false });
    }
    return this.queues.get(key);
  }

  // 尝试排空队列（由 webSocketMessage 或 drainLoop 调用）
  tryDrain(queue, peer) {
    if (queue.draining || !peer || queue.frames.length === 0) return;
    queue.draining = true;
    try {
      while (queue.frames.length > 0) {
        const msg = queue.frames[0];
        const ok = peer.send(msg);
        if (!ok) {
          // 对端 WS 缓冲区满，停止发送，下次 webSocketMessage 触发时再试
          break;
        }
        const frame = queue.frames.shift();
        queue.bytes -= frame.byteLength || (typeof frame === 'string' ? new TextEncoder().encode(frame).length : 0);
        if (queue.bytes < 0) queue.bytes = 0;
      }
    } finally {
      queue.draining = false;
    }
  }

  webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment();
    const peerRole = att.role === 'sender' ? 'receiver' : 'sender';
    const peer = this.findPeer(att.room, peerRole);
    if (!peer) return; // 对端还没连，丢弃

    // 文本控制消息（JSON）直接转发，不走队列
    if (typeof message === 'string') {
      peer.send(message);
      return;
    }

    // 二进制数据帧走背压队列
    const queue = this.getQueue(att.room, att.role);
    const msgSize = message.byteLength || 0;

    // 队列满了 → 丢弃最旧帧（优于让 DO 内存爆炸被杀）
    if (queue.bytes + msgSize > this.MAX_QUEUE_BYTES || queue.frames.length >= this.MAX_QUEUE_FRAMES) {
      const dropped = queue.frames.shift();
      if (dropped) {
        queue.bytes -= dropped.byteLength || 0;
        if (queue.bytes < 0) queue.bytes = 0;
      }
    }

    queue.frames.push(message);
    queue.bytes += msgSize;

    // 尝试立即转发
    this.tryDrain(queue, peer);
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (att) {
      const peer = this.findPeer(att.room, att.role === 'sender' ? 'receiver' : 'sender');
      if (peer) peer.send(JSON.stringify({ type: 'peer-left' }));
      // 清理该方向的队列
      const key1 = `${att.room}:${att.role}`;
      const key2 = `${att.room}:${att.role === 'sender' ? 'receiver' : 'sender'}`;
      this.queues.delete(key1);
      this.queues.delete(key2);
    }
    ws.close();
  }

  webSocketError(ws) {
    ws.close();
  }
}
