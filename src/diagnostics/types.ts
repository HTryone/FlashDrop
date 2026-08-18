// 诊断系统类型定义（Web 侧）。与 Rust diagnostics 模块字段对齐。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// 覆盖矩阵（§1.5/§1.7）：每类子系统一个 channel 标识。
export type DiagChannel =
  | 'tus'        // tus 中转链路
  | 'https'      // https 本地直传链路
  | 'p2p'        // p2p WebRTC 链路
  | 'ui'         // UI / 路由 / 生命周期
  | 'global'     // 全局未捕获
  | 'ipc'        // Tauri invoke 桥接
  | 'crash'      // 崩溃 / panic
  | 'perf'       // 性能异常 / 卡死
  | 'crypto'     // 加解密 / HMAC
  | 'net'        // DNS / TLS / STUN / TURN / 超时 / 代理
  | 'perm'       // OS 权限弹窗
  | 'config'     // 设置变更
  | 'update'     // 壳冷更新 / 远程热更新 / 启动自检
  | 'watchdog'   // 主线程阻塞 / 心跳
  | 'worker'     // 解密 Worker / WASM
  | 'bg'         // Android Doze / 后台被杀
  | 'core';      // 其他核心

export type Platform = 'windows' | 'android' | 'web';

export interface LogEntry {
  ts: number;            // 毫秒时间戳
  level: LogLevel;
  channel: DiagChannel;
  scope: string;         // 来源模块，如 'p2p/peer' 'filesink'
  msg: string;
  data?: unknown;        // 结构化附加信息（脱敏后）
  traceId?: string;      // 跨端关联同一传输/会话
  platform?: Platform;  // 由注入标签填充（§3.3）
}

export interface DiagFilter {
  level?: LogLevel;
  channel?: DiagChannel;
  keyword?: string;
  traceId?: string;
}

// 崩溃快照（§3.2）：越具体越好。
export interface CrashSession {
  traceId: string;
  name: string;
  size: number;
  progress: number;
  bytes: number;
  startedAt: number;
  result: string;
}

export interface CrashNegotiation {
  link: 'tus' | 'https' | 'p2p';
  sdp?: string;          // p2p offer/answer（脱敏后）
  iceCandidates?: string[];
  stunReachable?: boolean;
  relayUrl?: string;     // tus upload URL / https relay 地址（脱敏）
  signalingLog?: string[];
}

export interface CrashSnapshot {
  capturedAt: string;    // ISO 8601，含时区
  system: {
    os: string;
    osVersion: string;
    appVersion: string;
    device: string;
    arch: string;
    memoryMb: number;
    thread: string;
    platform: Platform;
  };
  activeTransfers: CrashSession[];
  negotiation: CrashNegotiation[];
  internal: {
    lastEvents: string[];     // 崩溃前最后 N 条
    activeModules: string[];
    lastHeartbeat: number;
    watchdogWarned: boolean;
  };
}
