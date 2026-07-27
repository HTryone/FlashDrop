// 入口 Worker：把 /stream/:room HTTP 请求路由到对应房间的 Durable Object。
// 房间码 → DO 实例（同一房间两端落到同一实例，实现流式中转）。
import { Relay } from './relay.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebRTC 信令用的 ICE 服务器清单（前端握手时拉取，保留给未来 P2P 用）。
    if (url.pathname === '/rtc-config') {
      const body = JSON.stringify({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun.qq.com:3478' },
          { urls: 'stun:stun.chat.bilibili.com:3478' },
          { urls: 'stun:stun.miwifi.com:3478' },
          {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:80?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      });
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // HTTP 流式中继：/stream/:room 或 /stream/:room/ready
    if (url.pathname.startsWith('/stream/')) {
      const parts = url.pathname.split('/');
      const room = parts[2];
      if (!room) return new Response('need room', { status: 400 });
      // 同一 room 固定映射到同一个 DO 实例，保证两端会合
      const id = env.RELAY.idFromName(room);
      const stub = env.RELAY.get(id);
      return stub.fetch(request);
    }

    return new Response('FlashDrop relay', { status: 200 });
  },
};

export { Relay };
