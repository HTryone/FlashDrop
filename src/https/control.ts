// 控制通道：每段独立 WebSocket（保持该段 DO 活跃，避免整段传输期 DO hibernate 丢状态）。
// 发送端/接收端共用，按 role 区分；封装连接、消息分发、发送、关闭与自动重连。

export function wsUrl(base: string, room: string, role: 'sender' | 'receiver'): string {
  return base.replace(/^https:/, 'wss:') + `/ws/${room}?role=${role}`;
}

export interface RelayControlOptions {
  base: string;
  room: string;
  role: 'sender' | 'receiver';
  onMessage: (data: any) => void;
  onOpen?: () => void;
  onClose?: () => void;
  /** 是否自动重连（发送端每段开启，接收端关闭） */
  reconnect?: boolean;
  reconnectDelay?: number;
  /** 自动重连判定（返回 false 则不再重连） */
  shouldReconnect?: () => boolean;
  /** 心跳间隔（ms），传 0 关闭。默认 20s，防中间设备/边缘掐断空闲控制连接 */
  heartbeatMs?: number;
}

export class RelayControl {
  ws: WebSocket | null = null;
  private opened = false;
  private closedByUs = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: RelayControlOptions) {}

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl(this.opts.base, this.opts.room, this.opts.role));
      this.ws = ws;
      ws.onopen = () => {
        this.opened = true;
        if (this.opts.role === 'receiver') {
          try { ws.send(JSON.stringify({ type: 'ready' })); } catch { /* ignore */ }
        }
        this.startHeartbeat();
        this.opts.onOpen?.();
        resolve();
      };
      ws.onmessage = (ev: MessageEvent) => {
        try { this.opts.onMessage(JSON.parse(ev.data)); } catch { /* ignore */ }
      };
      ws.onerror = () => {
        if (!this.opened) {
          if (this.opts.role === 'receiver') {
            // WebSocket 不可用 → 回退 HTTP POST /ready
            void fetch(`${this.opts.base}/stream/${this.opts.room}/ready`, { method: 'POST' }).catch(() => {});
          }
          resolve(); // 接收端在 WS 不可用时以 HTTP 兼容通道继续
        }
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        this.stopHeartbeat();
        this.opts.onClose?.();
        if (!this.opened) {
          reject(new Error('控制通道连接失败'));
          return;
        }
        if (this.opts.reconnect && this.opts.shouldReconnect?.()) {
          setTimeout(() => {
            if (!this.closedByUs) this.connect().catch(() => {});
          }, this.opts.reconnectDelay ?? 1000);
        }
      };
    });
  }

  send(obj: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  close() {
    this.closedByUs = true;
    this.stopHeartbeat();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  /**
   * 轻量心跳：定时向 relay 发 {type:'ping'}。relay 的消息处理只认
   * ready/progress/recv-done/recv-ready，未知类型静默忽略，故无需改 Worker。
   * 作用是让连接始终有流量，防中间设备/CF 边缘按空闲掐断控制通道。
   */
  private startHeartbeat() {
    this.stopHeartbeat();
    const ms = this.opts.heartbeatMs ?? 20_000;
    if (!ms) return;
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send('{"type":"ping"}'); } catch { /* ignore */ }
      }
    }, ms);
  }

  private stopHeartbeat() {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  /**
   * 触发底层 WS 重连（用于发送端 recvReady 活性重试）：关闭当前 WS 但不置 closedByUs，
   * 让 onclose 按 reconnect/shouldReconnect 自动重建连接。等价于原始裸 WebSocket 的
   * `lWs?.close()`（其 onclose 会重连）。切勿用 close()——那会永久阻断重连导致多段传输失败。
   */
  nudgeReconnect() {
    if (this.closedByUs) return;
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
