// Tauri 桥接：封装诊断命令 + 注册原生捕获钩子（§4 桥接）。
// 仅 Tauri 壳内加载（install.ts 动态 import）。普通浏览器不会走到这里。
import { invoke } from '@tauri-apps/api/core';
import { setNativeCapture } from '../diagnostics/logger';
import { isPhone } from '../tauri/client';
import type { LogEntry } from '../diagnostics/types';

// 把 Web 侧过滤后的日志查回来（UI 需要时调用，日常靠内存 RingBuffer）。
export async function diagnosticsQuery(filter: Record<string, unknown> = {}): Promise<LogEntry[]> {
  return invoke<LogEntry[]>('diagnostics_query', { filter });
}

// 导出当前日志为 ZIP。Windows 落系统下载目录；Android 复用 mediastore_insert 权限落 Download/ArkPulse/log，返回该路径串。
export async function diagnosticsExport(share = false): Promise<string> {
  if (isPhone()) {
    // ⚠️ diagnostics_export_android 是命名参数命令，必须用对象格式，不能用数组
    const res = await invoke<{ name: string; bytes: string }>('diagnostics_export_android', { share });
    await invoke('plugin:arkpulse-android-fs|mediastore_insert', { name: res.name, relative_path: 'Download/ArkPulse/log', bytes: res.bytes });
    return `Download/ArkPulse/log/${res.name}`;
  }
  // ⚠️ diagnostics_export 是命名参数命令，必须用对象格式
  return invoke<string>('diagnostics_export', { share });
}

export async function diagnosticsClear(): Promise<void> {
  return invoke<void>('diagnostics_clear');
}

// 注册原生捕获：Web 日志 → Rust 持久化（批量、异步、不阻塞业务线程，§1.8）。
export function registerNativeCapture(): void {
  const queue: LogEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;

  const FLUSH_INTERVAL = 100; // ms：合并窗口，把高频日志压成 ≤10 批/秒
  const MAX_QUEUE = 500; // 队列上限，超出丢最旧，防内存膨胀

  const flush = async () => {
    if (flushing) return;
    flushing = true;
    try {
      // 一次性把当前队列全部取走，避免与入队竞争；分 50 条一批串行提交。
      while (queue.length) {
        const batch = queue.splice(0, 50);
        try {
          // ⚠️ diagnostics_capture 是命名参数命令，必须用对象格式
          await invoke('diagnostics_capture', { entries: batch });
        } catch {
          // 桥接失败不得影响业务（§1.8）
        }
      }
    } finally {
      flushing = false;
    }
  };

  setNativeCapture((e: LogEntry) => {
    // 队列限长：超出时丢最旧，保留最近 MAX_QUEUE-50 条上下文（不降采样，全量留存于窗口内）。
    if (queue.length >= MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE + 50);
    queue.push(e);
    // 用 setTimeout 替代 queueMicrotask：微任务会在 await IPC 期间被反复重排、
    // 队列永不空导致循环钉死（日志量≈IPC 次数）。定时器合并提交，从根本断掉裂变。
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, FLUSH_INTERVAL);
    }
  });
}
