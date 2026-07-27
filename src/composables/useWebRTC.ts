// WebRTC P2P 直连传输层（叠加在现有 WebSocket 中继之上，不替换）。
//
// 角色分工：
//  - 发送端(role='sender')：initiator，创建 DataChannel + offer 并发信令。
//  - 接收端(role='receiver')：answerer，收到 offer 回 answer，拿到 DataChannel。
//  - 信令通道复用现有中继 WS：把 SDP/ICE 用 { type:'rtc-signal' } 包裹后经 WS 透传给对端。
//    （relay.js 本就是"两端消息全转发"，所以信令 JSON 自动到达对端，后端零改动。）
//
// 失败处理（NAT 穿透失败等）：
//  - 本层只管"能否建立 P2P DataChannel"。建立失败 / 未建立时，
//    调用方应回退到现有 WebSocket 中继传字节（即"兜底中继"，等同 TURN 的转发角色）。
//  - 发送端在每次传输开始时一次性决定走 DC 还是 WS（避免同一文件混用两路导致乱序）。

export interface RtcOptions {
  role: 'sender' | 'receiver';
  iceServers: RTCIceServer[];
  /** 通过现有中继 WS 把信令发给对端 */
  sendSignal: (msg: { type: 'rtc-signal'; data: any }) => void;
  /** 接收端拿到 DataChannel 时回调（用于挂 onmessage） */
  onDataChannel?: (dc: RTCDataChannel) => void;
  /** 连接状态变化：true=已直连，false=断开/失败 */
  onState?: (open: boolean) => void;
}

export function createWebRTC(opts: RtcOptions) {
  // 当前环境（如部分浏览器/扩展/企业策略）可能完全禁用 WebRTC，直接返回“不可用”的 stub，
  // 避免反复 new RTCPeerConnection 抛出 TypeError 污染控制台。
  if (typeof RTCPeerConnection === 'undefined') {
    console.warn('[rtc] 当前环境不支持 RTCPeerConnection，P2P 直连不可用');
    return {
      initiator: async () => {},
      onSignal: async () => {},
      sendFrame: async () => false,
      isOpen: () => false,
      bufferedAmount: () => 0,
      getChannel: () => null,
      destroy: () => {},
    };
  }

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;

  function wireDc(channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => opts.onState?.(true);
    channel.onclose = () => opts.onState?.(false);
  }

  function ensurePc(): RTCPeerConnection {
    if (pc) return pc;
    // 防御：iceServers 配置非法（如缺凭据的 turn 条目）会让构造函数抛 TypeError。
    // 出错时降级为"仅 STUN 条目重试"，保证 P2P 不因一条坏 TURN 全挂。
    try {
      pc = new RTCPeerConnection({ iceServers: opts.iceServers });
    } catch (e) {
      console.warn('[rtc] RTCPeerConnection 构造失败，剔除 TURN 后重试:', e);
      const stunOnly = opts.iceServers.filter((s) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return urls.every((u) => /^stun:/i.test(String(u)));
      });
      pc = new RTCPeerConnection({ iceServers: stunOnly });
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) opts.sendSignal({ type: 'rtc-signal', data: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') opts.onState?.(true);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') opts.onState?.(false);
    };
    if (opts.role === 'receiver') {
      pc.ondatachannel = (e) => {
        dc = e.channel;
        wireDc(dc);
        opts.onDataChannel?.(dc);
      };
    }
    return pc;
  }

  // 发送端主动发起协商
  async function initiator() {
    const p = ensurePc();
    dc = p.createDataChannel('flashdrop');
    wireDc(dc);
    const offer = await p.createOffer();
    await p.setLocalDescription(offer);
    opts.sendSignal({ type: 'rtc-signal', data: { type: 'offer', sdp: p.localDescription?.sdp } });
  }

  // 收到对端信令（offer / answer / ice candidate）
  async function onSignal(data: any) {
    const p = ensurePc();
    try {
      if (data?.type === 'offer') {
        await p.setRemoteDescription({ type: 'offer', sdp: data.sdp } as RTCSessionDescriptionInit);
        const answer = await p.createAnswer();
        await p.setLocalDescription(answer);
        opts.sendSignal({ type: 'rtc-signal', data: { type: 'answer', sdp: p.localDescription?.sdp } });
      } else if (data?.type === 'answer') {
        await p.setRemoteDescription({ type: 'answer', sdp: data.sdp } as RTCSessionDescriptionInit);
      } else if (data?.candidate) {
        await p.addIceCandidate(data as RTCIceCandidateInit);
      }
    } catch (e) {
      console.warn('[rtc] onSignal 失败:', e);
    }
  }

  // DataChannel 分片参数：SCTP 单次 send 不能超过 dc.maxMessageSize（通常 256KB），
  // 而我们本地直传的单帧可达 ~786KB，故发送端必须分片。分片头：[totalLen u32][offset u32]。
  const RTC_LOW = 1 * 1024 * 1024; // 背压阈值 1MiB（bufferedAmountMax 约 16MiB，留足余量）
  const DRAIN_TIMEOUT_MS = 30000;

  function drainDc(): Promise<void> {
    const d = dc;
    if (!d || d.bufferedAmount <= RTC_LOW) return Promise.resolve();
    const channel: RTCDataChannel = d;
    return new Promise((resolve) => {
      const onLow = () => cleanup();
      const onClose = () => cleanup();
      const timer = setTimeout(() => cleanup(), DRAIN_TIMEOUT_MS);
      function cleanup() {
        clearTimeout(timer);
        channel.removeEventListener('bufferedamountlow', onLow as any);
        channel.removeEventListener('close', onClose as any);
        resolve();
      }
      channel.addEventListener('bufferedamountlow', onLow as any, { once: true });
      channel.addEventListener('close', onClose as any, { once: true });
    });
  }

  // 经 DataChannel 发一帧（自动分片以避免超过 maxMessageSize）；全部发出返回 true。
  async function sendFrame(frame: Uint8Array): Promise<boolean> {
    const d = dc;
    if (!d || d.readyState !== 'open') return false;
    const channel: RTCDataChannel = d;
    const max = ((channel as any).maxMessageSize && (channel as any).maxMessageSize > 16) ? (channel as any).maxMessageSize : 65536;
    const HDR = 8;
    const step = max - HDR;
    if (step <= 0) return false;
    channel.bufferedAmountLowThreshold = RTC_LOW;
    try {
      for (let off = 0; off < frame.length; off += step) {
        if (channel.bufferedAmount > RTC_LOW) await drainDc();
        const end = Math.min(off + step, frame.length);
        const piece = frame.subarray(off, end);
        const out = new Uint8Array(HDR + piece.length);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, frame.length);
        dv.setUint32(4, off);
        out.set(piece, HDR);
        channel.send(out as unknown as ArrayBufferView<ArrayBuffer>);
      }
    } catch (e) {
      console.warn('[rtc] sendFrame 分片发送失败:', e);
      return false;
    }
    return true;
  }

  function isOpen() { return !!(dc && dc.readyState === 'open'); }
  function bufferedAmount() { return dc ? dc.bufferedAmount : 0; }
  function getChannel() { return dc; }

  function destroy() {
    try { dc?.close(); } catch { /* ignore */ }
    try { pc?.close(); } catch { /* ignore */ }
    pc = null;
    dc = null;
  }

  return { initiator, onSignal, sendFrame, isOpen, bufferedAmount, getChannel, destroy, ensurePc };
}

// 从中继 host 拉取 ICE 服务器清单；失败回退到公共 STUN。
// 注意：传入的 proto 是信令 WS 协议（wss/ws），但 /rtc-config 是普通 HTTP GET 端点，
// fetch 只支持 http/https，故此处需把 wss→https、ws→http。
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
    console.warn('[rtc] 获取 ICE 配置失败，回退默认 STUN:', e);
  }
  // 兜底列表（/rtc-config 整个 fetch 失败时）：谷歌 + 国内并存，避免国内只剩连不上的谷歌。
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.chat.bilibili.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
  ];
}

// 防御性过滤：浏览器硬性要求 turn:/turns: 条目必须带 username+credential，
// 否则 new RTCPeerConnection 直接抛 TypeError，整个 P2P（含 STUN）全挂。
// 服务端配置手滑（如只填裸 turn 地址）时，这里静默剔除坏条目，只损失 TURN 不炸全局。
function sanitizeIceServers(list: RTCIceServer[]): RTCIceServer[] {
  const ok = list.filter((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    const hasTurn = urls.some((u) => /^turns?:/i.test(String(u)));
    if (hasTurn && (!s.username || !s.credential)) {
      console.warn('[rtc] 剔除缺凭据的 TURN 条目（否则会导致 RTCPeerConnection 构造失败）:', urls);
      return false;
    }
    return true;
  });
  return ok.length ? ok : list; // 全被剔光就原样返回，交给下层 try-catch
}
