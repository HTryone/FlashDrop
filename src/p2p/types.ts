// P2P 直连传输模块 — 类型与常量（独立于 HTTP，仅只读引用 @/crypto/e2ee 与 @/composables/useLocalCrypto）

export type P2PRole = 'sender' | 'receiver';

export interface P2PFileMeta {
  name: string;
  size: number; // 字节
}

// 12B 帧头布局（与 HTTP 本地直传完全一致，保证与现有 E2EE 密钥/解密兼容）
// u16 fi @0 | u32 ci @2 | u32 plainLen @6 | (2 字节保留 @10)
export const FRAME_HDR = 12;

// DataChannel 子帧头：u32 totalLen @0 | u32 offset @4（8 字节），其后为 piece
export const SUB_HDR = 8;

// 背压窗口：在途帧数上限（≈ WINDOW_FRAMES * P2P_CHUNK_SIZE ≈ 40MB）
export const WINDOW_FRAMES = 10;
// DC 缓冲阈值（bufferedAmount 超过则等待排空）
export const RTC_LOW = 1 * 1024 * 1024;

// ── P2P 专用大分块 ──
// DC 底层 SCTP 自动分片，无 HTTP/WS 的 ~1MB 消息限制。用 4MB 分块替代
// LOCAL_CHUNK_SIZE(896KB)，crypto 调用次数降 ~4.5 倍，帧头开销占比从 0.07% 降到 0.002%。
// HTTP 中转路径继续用 LOCAL_CHUNK_SIZE（受 DO WS 消息上限约束）。
export const P2P_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB

// DC 上的控制消息（字符串 JSON）。数据子帧为二进制，靠 typeof 区分。
export interface ManifestMsg {
  type: 'manifest';
  files: P2PFileMeta[];
  totalBytes: number;
}
export interface AckMsg {
  type: 'ack';
  seq: number; // 已连续确认的最高全局序号
}
export interface DoneMsg {
  type: 'done';
}
export type ControlMsg = ManifestMsg | AckMsg | DoneMsg;

export type P2PState =
  | 'idle'
  | 'signaling'
  | 'connecting' // RTCPeerConnection 协商中
  | 'connected' // DataChannel open
  | 'transferring'
  | 'done'
  | 'error'
  | 'aborted';

export interface P2PProgress {
  sent: number; // 已发送字节（发送端）
  received: number; // 已落盘字节（接收端）
  total: number;
}

export interface SenderOpts {
  relayBase: string; // https://flashdrop-relay.315461.xyz
  room: string; // 共享房间码
  pass: string; // 口令（#k=），用于 deriveKey
  files: File[]; // 待发送文件
  onState?: (s: P2PState, detail?: string) => void;
  onProgress?: (p: P2PProgress) => void;
  onFail?: (err: Error) => void;
  signal?: AbortSignal;
}

export interface ReceiverOpts {
  relayBase: string;
  room: string;
  pass: string;
  // 接收端目录句柄（FSA）；为 null 时退化为逐文件 Blob 下载
  dirHandle?: FileSystemDirectoryHandle | null;
  onState?: (s: P2PState, detail?: string) => void;
  onProgress?: (p: P2PProgress) => void;
  onFail?: (err: Error) => void;
  signal?: AbortSignal;
}
