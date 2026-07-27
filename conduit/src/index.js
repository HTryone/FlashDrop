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
      // 必须带 CORS 头：前端（pages.dev / localhost）跨域 fetch 此端点，
      // 缺 CORS 浏览器会拦截并报 "TypeError: Failed to fetch"，导致 P2P 永远拿不到 ICE 配置。
      const body = JSON.stringify({
        iceServers: [
          // —— STUN：多地址并存，浏览器自动逐个尝试打洞 ——
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun.qq.com:3478' },
          { urls: 'stun:stun.chat.bilibili.com:3478' },
          { urls: 'stun:stun.miwifi.com:3478' },
          // —— TURN（公共免费，走 TCP，对称 NAT / UDP 被挡时兜底）——
          // 国内节点（astral.fan 阿里云段，延迟低，TUN 代理下必通）；匿名公开，随时可能限流/下线，不稳定即换。
          { urls: 'turn:8.148.29.206:11010?transport=tcp' },
          // 海外节点（OpenRelay/metered）；匿名可能拒连，仅作候选，不影响其余 STUN/TURN 使用。
          // 如需专属凭据，去 metered.ca 注册后替换下方端点（仍走 ?transport=tcp）。
          { urls: 'turn:openrelay.metered.ca:443?transport=tcp' },
          { urls: 'turn:openrelay.metered.ca:80?transport=tcp' },
        ],
      });
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
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
