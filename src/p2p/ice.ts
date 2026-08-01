// ICE 服务器获取与清洗（从原 useWebRTC.ts 吸收，逻辑不变）。
// 信令 WS 协议是 wss/ws，但 /rtc-config 是普通 HTTP GET，需把 wss→https、ws→http。

export async function fetchIceServers(host: string, proto: string): Promise<RTCIceServer[]> {
  try {
    const httpProto = proto === 'wss' ? 'https' : 'http';
    const cleanHost = host.replace(/^wss?:\/\//, '');
    const r = await fetch(`${httpProto}://${cleanHost}/rtc-config`);
    const j = await r.json();
    if (Array.isArray(j.iceServers) && j.iceServers.length) {
      return sanitizeIceServers(j.iceServers as RTCIceServer[]);
    }
  } catch (e) {
    console.warn('[p2p] 获取 ICE 配置失败，回退默认 STUN:', e);
  }
  // 兜底列表（/rtc-config 整个 fetch 失败时）：镜像 relay 的 rtc-config，
  // 保留 openrelay TURN(443/80 tcp)+ 国内/谷歌 STUN，避免 fetch 失败就退化成纯 STUN 丢 TURN 直连能力。
  // 凭据为 openrelay 公开共享凭据（与 relay 返回一致，本就在浏览器网络响应里可见，非密）。
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.chat.bilibili.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
}

// 防御性过滤：浏览器硬性要求 turn:/turns: 条目必须带 username+credential，
// 否则 new RTCPeerConnection 直接抛 TypeError，整个 P2P（含 STUN）全挂。
// 服务端配置手滑（如只填裸 turn 地址）时，这里静默剔除坏条目，只损失 TURN 不炸全局。
export function sanitizeIceServers(list: RTCIceServer[]): RTCIceServer[] {
  const ok = list.filter((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    const hasTurn = urls.some((u) => /^turns?:/i.test(String(u)));
    if (hasTurn && (!s.username || !s.credential)) {
      console.warn('[p2p] 剔除缺凭据的 TURN 条目（否则会导致 RTCPeerConnection 构造失败）:', urls);
      return false;
    }
    return true;
  });
  return ok.length ? ok : list; // 全被剔光就原样返回，交给下层 try-catch
}
