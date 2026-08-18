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
    const res = await invoke<{ name: string; bytes: string }>('diagnostics_export_android', { share });
    await invoke('mediastore_insert', {
      name: res.name,
      relative_path: 'Download/ArkPulse/log',
      bytes: res.bytes,
    });
    return `Download/ArkPulse/log/${res.name}`;
  }
  return invoke<string>('diagnostics_export', { share });
}

export async function diagnosticsClear(): Promise<void> {
  return invoke<void>('diagnostics_clear');
}

// 注册原生捕获：Web 日志 → Rust 持久化（批量、异步、不阻塞业务线程，§1.8）。
export function registerNativeCapture(): void {
  const queue: LogEntry[] = [];
  let flushing = false;

  const flush = async () => {
    if (flushing) return;
    flushing = true;
    while (queue.length) {
      const batch = queue.splice(0, 50);
      try {
        await invoke('diagnostics_capture', { entries: batch });
      } catch {
        // 桥接失败不得影响业务（§1.8）
      }
    }
    flushing = false;
  };

  setNativeCapture((e: LogEntry) => {
    queue.push(e);
    if (!flushing) queueMicrotask(flush);
  });
}
