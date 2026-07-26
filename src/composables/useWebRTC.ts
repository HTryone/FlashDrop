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
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;

  function wireDc(channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => opts.onState?.(true);
    channel.onclose = () => opts.onState?.(false);
  }

  function ensurePc(): RTCPeerConnection {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: opts.iceServers });
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

  // 经 DataChannel 发一帧；成功返回 true（调用方无需再走 WS）
  function sendFrame(frame: Uint8Array<ArrayBuffer>): boolean {
    if (dc && dc.readyState === 'open') {
      dc.send(frame as unknown as ArrayBufferView<ArrayBuffer>);
      return true;
    }
    return false;
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
export async function fetchIceServers(host: string, proto: string): Promise<RTCIceServer[]> {
  try {
    const r = await fetch(`${proto}://${host}/rtc-config`);
    const j = await r.json();
    if (Array.isArray(j.iceServers) && j.iceServers.length) return j.iceServers as RTCIceServer[];
  } catch (e) {
    console.warn('[rtc] 获取 ICE 配置失败，回退默认 STUN:', e);
  }
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
}
