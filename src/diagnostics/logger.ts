// 核心统一日志器（§2 采集层 A）。收编散落 console.*，分级 + traceId + 渠道，实时进 RingBuffer，
// 关键节点经桥接写进 Rust 原生持久化（双端都落盘，崩溃可恢复）。
import { diagStore } from './store';
import { getTrace } from './trace';
import type { DiagChannel, LogEntry, LogLevel, Platform } from './types';

// 平台标签由壳注入（§3.3）：window.__ARKPULSE_CLIENT__.kind（'windows' | 'phone'）。
// 'phone' 映射为 'android' 与 Rust 端一致；远程前端无注入时回退 'web'。
function readPlatform(): Platform {
  const kind = (globalThis as any).__ARKPULSE_CLIENT__?.kind as string | undefined;
  if (kind === 'phone') return 'android';
  if (kind === 'windows') return 'windows';
  return 'web';
}

// 原生桥接钩子（由 src/tauri/diagnostics.ts 注入），Web 端为 no-op。
let nativeCapture: ((e: LogEntry) => void) | null = null;
export function setNativeCapture(fn: ((e: LogEntry) => void) | null) {
  nativeCapture = fn;
}

// 原生端（windows/phone）全量实时落盘：debug 也同步写文件，杀后台/闪退不丢日志。
// 内存 RingBuffer 仅服务 UI 实时展示；Web 不安装（无输出）。
const PERSIST_MIN: LogLevel = 'debug';

export function log(
  level: LogLevel,
  channel: DiagChannel,
  scope: string,
  msg: string,
  data?: unknown,
  traceId?: string,
): void {
  const entry: LogEntry = {
    ts: Date.now(),
    level,
    channel,
    scope,
    msg,
    data: data !== undefined ? safeStringify(data) : undefined,
    traceId: traceId ?? getTrace(),
    platform: readPlatform(),
  };
  diagStore.push(entry);
  if (nativeCapture && levelRank(level) >= levelRank(PERSIST_MIN)) {
    try {
      nativeCapture(entry);
    } catch {
      // 原生桥接失败不得影响业务线程（§1.8：不阻塞业务）
    }
  }
}

function levelRank(l: LogLevel): number {
  return { debug: 0, info: 1, warn: 2, error: 3 }[l];
}

// 便捷封装（替代 console.*）。
export const debug = (c: DiagChannel, s: string, m: string, d?: unknown, t?: string) =>
  log('debug', c, s, m, d, t);
export const info = (c: DiagChannel, s: string, m: string, d?: unknown, t?: string) =>
  log('info', c, s, m, d, t);
export const warn = (c: DiagChannel, s: string, m: string, d?: unknown, t?: string) =>
  log('warn', c, s, m, d, t);
export const error = (c: DiagChannel, s: string, m: string, d?: unknown, t?: string) =>
  log('error', c, s, m, d, t);

// 与现有 console.* 调用兼容：替换全局 console，使其进入诊断系统（§2 收编 36 处）。
export function installConsoleProxy() {
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  console.log = (...a: unknown[]) => { orig.log(...a); proxy('info', a); };
  console.info = (...a: unknown[]) => { orig.log(...a); proxy('info', a); };
  console.debug = (...a: unknown[]) => { orig.log(...a); proxy('debug', a); };
  console.warn = (...a: unknown[]) => { orig.warn(...a); proxy('warn', a); };
  console.error = (...a: unknown[]) => { orig.error(...a); proxy('error', a); };
}

function proxy(level: LogLevel, args: unknown[]) {
  const msg = args
    .map((x) => (typeof x === 'string' ? x : safeStringify(x)))
    .join(' ');
  log(level, 'core', 'console', msg);
}

function safeStringify(x: unknown): string {
  try {
    return typeof x === 'object' ? JSON.stringify(x) : String(x);
  } catch {
    return String(x);
  }
}
