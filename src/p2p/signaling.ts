// 信令客户端：复用现有 relay WS（后端加 rtc-signal 双向透传分支），把 SDP/ICE 用 { type:'rtc-signal' } 透传给对端。
// 信令房间命名空间 `::p2p`，避免与同房间码的 HTTP 控制通道互相串扰。
import type { P2PRole } from './types';

export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onSignal: (data: any) => void;
  private onOpen: (() => void) | null;
  private onClose: (() => void) | null;
  private onReconnecting: (() => void) | null;
  private shouldClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: any[] = []; // 信令 WS 断开期间缓冲的待发消息，重连后刷出
  static readonly MAX_RECONNECT_ATTEMPTS = 20;

  constructor(opts: {
    relayBase: string;
    room: string;
    role: P2PRole;
    onSignal: (data: any) => void;
    onOpen?: () => void;
    onClose?: () => void;
    onReconnecting?: () => void;
  }) {
    const proto = opts.relayBase.startsWith('https') ? 'wss' : 'ws';
    const host = opts.relayBase.replace(/^https?:\/\//, '');
    const sigRoom = `${opts.room}::p2p`;
    this.url = `${proto}://${host}/ws/${encodeURIComponent(sigRoom)}?role=${opts.role}`;
    this.onSignal = opts.onSignal;
    this.onOpen = opts.onOpen || null;
    this.onClose = opts.onClose || null;
    this.onReconnecting = opts.onReconnecting || null;
  }

  connect() {
    this.shouldClose = false;
    this.reconnectAttempts = 0;
    this.open();
  }

  // 建立底层 WS；初始连接与自动重连共用。成功 open 即刷出断开期间缓冲的信令。
  private open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempts = 0;
      const q = this.pending;
      this.pending = [];
      for (const m of q) this.rawSend(m); // 重连后补发缓冲的 offer/answer/candidate
      this.onOpen?.();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg && msg.type === 'rtc-signal' && msg.data) this.onSignal(msg.data);
      } catch (e) {
        console.warn('[p2p] 信令解析失败:', e);
      }
    };
    ws.onclose = () => {
      if (this.shouldClose) { this.onClose?.(); return; }
      this.scheduleReconnect(); // 意外断开 → 指数退避自动重连，不拆 P2P 数据通道
    };
    ws.onerror = (e) => console.warn('[p2p] 信令 WS 错误:', e);
  }

  // 指数退避重连（1s→2s→4s…封顶 10s）。达到上限仍失败则放弃并通知上层。
  private scheduleReconnect() {
    this.reconnectAttempts++;
    if (this.reconnectAttempts > SignalingClient.MAX_RECONNECT_ATTEMPTS) {
      this.pending = [];
      this.onClose?.(); // 长时间无法恢复，交上层处理（当前 sender/receiver 未传 onClose，安全 no-op）
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);
    this.onReconnecting?.();
    this.reconnectTimer = setTimeout(() => {
      if (!this.shouldClose) this.open();
    }, delay);
  }

  private rawSend(data: any): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'rtc-signal', data }));
      return true;
    }
    return false;
  }

  send(data: any) {
    // 连接未就绪时缓冲，待重连 open 后由 open() 刷出，避免丢 offer/answer/candidate
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pending.push(data);
      return;
    }
    this.rawSend(data);
  }

  close() {
    this.shouldClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.pending = [];
    try {
      this.ws?.close();
    } catch { /* ignore */ }
    this.ws = null;
  }
}
