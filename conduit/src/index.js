// 入口 Worker：把 /relay WebSocket 升级请求路由到对应房间的 Durable Object。
// 房间码 → DO 实例（同一房间两端落到同一实例，实现内存流转）。
import { Relay } from './relay.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // WebRTC 信令用的 ICE 服务器清单（前端握手时拉取）。
    // 仅 STUN 即可覆盖大多数 NAT；对称 NAT 穿透失败会自动回退到现有 WebSocket 中继（等同 TURN 的兜底角色）。
    // 若日后自部署 coturn，把下方注释的 turn 项填上即可，无需改前端。
    if (url.pathname === '/rtc-config') {
      // ICE 服务器清单：多地址并存，浏览器会逐个尝试；
      // 谷歌 STUN 在海外可用、国内常被墙，故并列国内可达 STUN 作备用。
      // TURN 暂留空（对称 NAT 兜底走现有 WebSocket 中继，比海外免费 TURN 更快）。
      // 若日后在国内 VPS 自部署 coturn，取消下方注释并填入凭据即可，前端无需改动。
      return Response.json({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun.qq.com:3478' },
          { urls: 'stun:stun.chat.bilibili.com:3478' },
          { urls: 'stun:stun.miwifi.com:3478' },
          // { urls: 'turn:YOUR_TURN_HOST:3478?transport=udp', username: 'flashdrop', credential: 'change-me' },
          // { urls: 'turn:YOUR_TURN_HOST:3478?transport=tcp', username: 'flashdrop', credential: 'change-me' },
        ],
      });
    }
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
