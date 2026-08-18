// traceId 生成与传播（§4 桥接）。Web 生成，经命令带入 Rust，双端同一 bug 一条线。

let currentTrace: string | undefined;

export function newTrace(): string {
  const t =
    (globalThis.crypto?.randomUUID?.() ??
      `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  currentTrace = t;
  return t;
}

export function getTrace(): string | undefined {
  return currentTrace;
}

// 在一段逻辑内绑定 traceId，便于自动随日志带出。
export function withTrace<T>(fn: (traceId: string) => T, traceId?: string): T {
  const id = traceId ?? newTrace();
  const prev = currentTrace;
  currentTrace = id;
  try {
    return fn(id);
  } finally {
    currentTrace = prev;
  }
}
