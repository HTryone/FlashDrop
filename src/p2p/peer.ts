// PeerLink：RTCPeerConnection + DataChannel 生命周期管理。
// 发送端 initiator 创建 DC + offer；接收端 answerer 回 answer。信令经 SignalingClient 透传。
// 失败重协商重连：connectionState='failed' 时保留信令 WS，仅重建 pc+dc 重新 offer/answer（房间码不变）。
import type { P2PRole } from './types';
import { RTC_LOW } from './types';
import { info, warn } from '@/diagnostics/logger';

type DcHandler = (dc: RTCDataChannel) => void;
type MsgHandler = (data: string | ArrayBuffer) => void;
type StateHandler = (connected: boolean) => void;
type ReconnectHandler = () => void;

export class PeerLink {
  role: P2PRole;
  private sendSignal: (msg: any) => void;
  private onDcOpenCb: DcHandler | null = null;
  private onDcMsgCb: MsgHandler | null = null;
  private onStateCb: StateHandler | null = null;
  private onReconnectCb: ReconnectHandler | null = null;
  private onPeerJoinedCb: (() => void) | null = null;
  private pendingSignals: any[] = []; // pc 就绪前到达的信令（relay 回放可能早于 pc），就绪后按序冲刷
  private peerJoinedNotified = false;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private iceServers: RTCIceServer[] = [];
  private gotRemote = false; // 是否收到对端 answer/candidate
  private offerTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(opts: {
    role: P2PRole;
    sendSignal: (msg: any) => void;
    onDcOpen?: DcHandler;
    onDcMessage?: MsgHandler;
    onState?: StateHandler;
    onReconnect?: ReconnectHandler;
    onPeerJoined?: () => void;
  }) {
    this.role = opts.role;
    this.sendSignal = opts.sendSignal;
    this.onDcOpenCb = opts.onDcOpen || null;
    this.onDcMsgCb = opts.onDcMessage || null;
    this.onStateCb = opts.onState || null;
    this.onReconnectCb = opts.onReconnect || null;
    this.onPeerJoinedCb = opts.onPeerJoined || null;
  }

  private wireDc(dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';
    (dc as unknown as { bufferedAmountLowThreshold: number }).bufferedAmountLowThreshold = RTC_LOW;
    dc.onopen = () => {
      this.onStateCb?.(true);
      this.onDcOpenCb?.(dc);
    };
    dc.onclose = () => this.onStateCb?.(false);
    dc.onmessage = (ev: MessageEvent) => this.onDcMsgCb?.(ev.data as string | ArrayBuffer);
    dc.onerror = (e: any) => console.warn('[p2p] dc error:', e);
  }

  private ensurePc(): RTCPeerConnection {
    if (this.pc) return this.pc;
    try {
      this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    } catch (e) {
      console.warn('[p2p] RTCPeerConnection 构造失败，剔除 TURN 后重试:', e);
      const stunOnly = this.iceServers.filter((s) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return urls.every((u) => /^stun:/i.test(String(u)));
      });
      this.pc = new RTCPeerConnection({ iceServers: stunOnly });
    }
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        console.log(`[p2p] 本地 ICE 候选: ${e.candidate.candidate.substring(0, 80)}`);
        this.sendSignal({ type: 'candidate', candidate: e.candidate.toJSON() });
      } else {
        console.log('[p2p] ICE 候选收集完毕(null candidate)');
      }
    };
    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      const st = this.pc.connectionState;
      console.log(`[p2p] ICE connectionState: ${st}${st === 'connected' ? ' ✅' : st === 'failed' ? ' ❌ 将重连' : ''}`);
      if (st === 'connected') {
        this.gotRemote = true;
        this.clearOfferTimer();
        info('p2p', 'peer', `WebRTC 连接已建立 (connected)`);
        this.onStateCb?.(true);
      } else if (st === 'failed') {
        warn('p2p', 'peer', `WebRTC 连接失败 (failed), 触发重连`);
        this.onStateCb?.(false);
        this.reconnect();
      }
      // 'disconnected' 先观察，待其自行恢复或转 failed 再处理
    };
    if (this.role === 'receiver') {
      this.pc.ondatachannel = (e) => {
        this.dc = e.channel;
        this.wireDc(this.dc);
      };
    }
    return this.pc;
  }

  async connect(iceServers: RTCIceServer[]) {
    this.iceServers = iceServers;
    info('p2p', 'peer', `建立 WebRTC 连接 (role=${this.role}), ICE服务器=${iceServers.length}个`, { role: this.role, iceServers: iceServers.length });
    this.ensurePc();
    // 冲刷 connect 之前到达的缓冲信令（relay 回放可能早于 pc 就绪），按到达顺序处理
    const pend = this.pendingSignals;
    this.pendingSignals = [];
    for (const d of pend) { try { await this.onSignal(d); } catch { /* ignore */ } }
    if (this.role === 'sender') {
      this.dc = this.pc!.createDataChannel('arkpulse');
      this.wireDc(this.dc);
      await this.sendOffer();
    }
    // receiver 等待对端 offer（由 onSignal 触发）
  }

  private async sendOffer() {
    if (!this.pc || this.destroyed) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      console.log('[p2p] offer 已创建并发送');
      info('p2p', 'peer', `发送 offer (role=${this.role})`);
      this.sendSignal({ type: 'offer', sdp: this.pc.localDescription?.sdp });
      // 重发 offer 直到收到对端响应（防 relay 未缓冲早期 offer 导致接收端永远收不到）
      this.clearOfferTimer();
      this.offerTimer = setInterval(() => {
        if (this.destroyed || this.gotRemote) {
          this.clearOfferTimer();
          return;
        }
        try {
          this.sendSignal({ type: 'offer', sdp: this.pc?.localDescription?.sdp });
        } catch { /* ignore */ }
      }, 1500);
    } catch (e) {
      console.warn('[p2p] sendOffer 失败:', e);
    }
  }

  private clearOfferTimer() {
    if (this.offerTimer) {
      clearInterval(this.offerTimer);
      this.offerTimer = null;
    }
  }

  // 首条对端信令到达（接收端拿到 offer / 发送端拿到 answer）即视为「对方已加入」，
  // 供 UI 提前点亮在线指示灯与状态提示，不等 DataChannel 真正 open。
  private notifyPeerJoined() {
    if (this.peerJoinedNotified) return;
    this.peerJoinedNotified = true;
    this.onPeerJoinedCb?.();
  }

  async onSignal(data: any) {
    if (this.destroyed) return;
    // pc 尚未就绪（relay 回放可能早于 PeerLink.connect）→ 先缓冲，connect 后按序冲刷
    if (!this.pc) { this.pendingSignals.push(data); return; }
    const p = this.pc;
    try {
      if (data?.type === 'offer') {
        if (this.role !== 'receiver') return; // sender 忽略自己的 offer 回声
        if (this.gotRemote) return; // 忽略重复 offer（relay 回放 + 发送端重发可能重复投递）
        console.log('[p2p] 收到 offer，开始创建 answer…');
        info('p2p', 'peer', `收到 offer, 开始协商 answer`);
        await p.setRemoteDescription({ type: 'offer', sdp: data.sdp } as RTCSessionDescriptionInit);
        this.gotRemote = true;
        this.notifyPeerJoined();
        const answer = await p.createAnswer();
        await p.setLocalDescription(answer);
        this.sendSignal({ type: 'answer', sdp: p.localDescription?.sdp });
      } else if (data?.type === 'answer') {
        if (this.role !== 'sender') return;
        // 状态守卫：仅在处于等待 answer 的状态时才处理。stable/已连接时收到旧 answer（息屏重连后 relay 回放）直接丢弃，
        // 避免 'Failed to set remote answer sdp: Called in wrong state: stable' 的 InvalidStateError。
        if (p.signalingState !== 'have-local-offer' && p.signalingState !== 'have-remote-pranswer') {
          console.warn('[p2p] 丢弃过期 answer，当前 signalingState:', p.signalingState);
          return;
        }
        console.log('[p2p] 收到 answer，ICE 协商开始…');
        info('p2p', 'peer', `收到 answer, ICE 协商开始`);
        this.gotRemote = true;
        this.notifyPeerJoined();
        this.clearOfferTimer();
        await p.setRemoteDescription({ type: 'answer', sdp: data.sdp } as RTCSessionDescriptionInit);
      } else if (data?.type === 'candidate') {
        try {
          const c = data.candidate as RTCIceCandidateInit;
          console.log(`[p2p] 收到远程候选: ${(c.candidate || '').substring(0, 80)}`);
          await p.addIceCandidate(c);
        } catch (e) {
          console.warn('[p2p] addIceCandidate 失败:', e);
        }
      }
    } catch (e) {
      console.warn('[p2p] onSignal 失败:', e);
    }
  }

  private reconnect() {
    if (this.destroyed) return;
    try {
      this.dc?.close();
    } catch { /* ignore */ }
    try {
      this.pc?.close();
    } catch { /* ignore */ }
    this.pc = null;
    this.dc = null;
    this.gotRemote = false;
    this.clearOfferTimer();
    // 保留 sendSignal（relay WS 不断），重建 pc 并重新协商
    this.ensurePc();
    this.onReconnectCb?.();
    info('p2p', 'peer', `重连: 重建 pc 并重新协商 (role=${this.role})`);
    if (this.role === 'sender') {
      this.dc = this.pc!.createDataChannel('arkpulse');
      this.wireDc(this.dc);
      this.sendOffer();
    }
    // receiver 等待新 offer
  }

  get channel() {
    return this.dc;
  }
  get isOpen() {
    return !!(this.dc && this.dc.readyState === 'open');
  }

  destroy() {
    this.destroyed = true;
    this.clearOfferTimer();
    try {
      this.dc?.close();
    } catch { /* ignore */ }
    try {
      this.pc?.close();
    } catch { /* ignore */ }
    this.pc = null;
    this.dc = null;
  }
}
