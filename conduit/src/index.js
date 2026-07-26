// 入口 Worker：把 /relay WebSocket 升级请求路由到对应房间的 Durable Object。
// 房间码 → DO 实例（同一房间两端落到同一实例，实现内存流转）。
import { Relay } from './relay.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/relay') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const room = url.searchParams.get('room');
      const role = url.searchParams.get('role');
      if (!room || !role) return new Response('need room & role', { status: 400 });
      // 同一 room 固定映射到同一个 DO 实例，保证两端会合
      const id = env.RELAY.idFromName(room);
      const stub = env.RELAY.get(id);
      return stub.fetch(request);
    }
    return new Response('FlashDrop relay', { status: 200 });
  },
};

export { Relay };
