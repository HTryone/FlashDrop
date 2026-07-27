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
          // ⚠️ 浏览器硬性要求：turn: 地址必须带 username+credential，否则
          //    new RTCPeerConnection 直接抛 TypeError，整个 P2P（含 STUN）全挂。
          // OpenRelay/metered 公开凭据：openrelayproject / openrelayproject。
          // 如需专属凭据，去 metered.ca 注册后替换（仍走 ?transport=tcp）。
          // 国内节点：暂无带凭据的可靠公共 TURN（此前填的 8.148.29.206 是 EasyTier 组网节点、
          // 非标准 TURN 且无凭据，已移除）；国内兜底继续走现有 WS 中继，日后自建 coturn 再补。
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
