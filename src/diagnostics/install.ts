// 全局捕获（§1.5/§2）：系统级兜底，任何未处理异常都进日志，不依赖业务主动埋点。
// 须在 main.ts 最前调用（早于业务代码），保证初始化阶段闪退也有记录（§3.2 早初始化）。
//
// 平台门控（用户定）：PC 桌面 + 移动端（均为 Tauri 原生壳）统一启用日志；
// Web 浏览器明确排除，不安装任何诊断/埋点逻辑。
import { error, setNativeCapture } from './logger';
import { isTauriEnv } from '../tauri/env';
import { isPhone, isWindows } from '../tauri/client';
import { installObservers } from './observe';
import type { LogEntry } from './types';
import { invoke } from '@tauri-apps/api/core';

// 原生侧（windows | phone）启用诊断；web 浏览器排除（用户定：Web 不需要日志）。
function diagnosticsEnabled(): boolean {
  return isWindows() || isPhone();
}

// 「动态 import 完成前」的早期缓存：避免 registerNativeCapture 还没装上时早期 log() 被丢失（导致导出文件只有「近期新增」的那一段）。
// 所有 entry 先入 earlyBuf；registerNativeCapture 接管时把 pre 整批 invoke 灌入 Rust，之后 setNativeCapture 的钩子替换由 registerNativeCapture 内部完成。
const earlyBuf: LogEntry[] = [];
function captureEarly(e: LogEntry): void {
  earlyBuf.push(e);
  // 防止内存爆炸：上限 5000 条，超过按时间顺序丢最早的（与 RingBuffer 同思路）
  if (earlyBuf.length > 5000) earlyBuf.splice(0, earlyBuf.length - 5000);
}

export function installGlobalCapture(): void {
  if (!diagnosticsEnabled()) return;

  // ① 同步接管 nativeCapture：早于任何业务代码被调用。entry 先入 earlyBuf。
  setNativeCapture(captureEarly);

  // ② 异步：等 Tauri 模块加载完，调 registerNativeCapture 接管（新钩子直接走 invoke queue）。
  //    在 registerNativeCapture 覆盖 setNativeCapture 之前，主动把 earlyBuf 一批送入 Rust，确保早期日志不丢。
  if (isTauriEnv()) {
    import('../tauri/diagnostics')
      .then(async (m) => {
        // 顺序固定：先 registerNativeCapture 接管 setNativeCapture 钩子（同步），splice 之后的新 entry 走 invoke queue，不再入 earlyBuf。
        m.registerNativeCapture();
        const pre = earlyBuf.splice(0, earlyBuf.length);
        if (pre.length) {
          try {
            await invoke('diagnostics_capture', { entries: pre });
          } catch (err) {
            console.error('[diagnostics] earlyBuf flush failed:', err);
          }
        }
      })
      .catch((err) => {
        console.error('[diagnostics] failed to load diagnostics module:', err);
      });
  }

  // ③ 全量请求埋点（§1.6）：fetch/WebSocket/WebRTC 全局包裹，覆盖三链路每一笔请求。
  installObservers();

  if (typeof window !== 'undefined') {
    window.addEventListener('error', (ev) => {
      const m = ev.message ?? 'unknown error';
      const detail =
        ev.error && ev.error.stack
          ? `${m}\n${ev.error.stack}`
          : `${m} @ ${ev.filename}:${ev.lineno}:${ev.colno}`;
      error('global', 'window.onerror', detail);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev.reason;
      const msg = r && r.stack ? `${r.message ?? r}\n${r.stack}` : String(r);
      error('global', 'unhandledrejection', msg);
    });
  }
}

// 挂到 Vue 应用：组件渲染/生命周期内抛错也进诊断（§1.5 tag=ui）。
export function installVueErrorHandler(app: any): void {
  if (!app || typeof app.config === 'undefined') return;
  app.config.errorHandler = (err: unknown, _instance: unknown, info: string) => {
    const e = err as Error;
    error('ui', 'vue.errorHandler', `${info}: ${e?.message ?? err}`, e?.stack);
  };
}

// 安装入口（main.ts 调用）。Web 端直接 no-op，不装任何诊断逻辑。
export function installDiagnostics(app?: any): void {
  if (!diagnosticsEnabled()) return;
  installGlobalCapture();
  if (app) installVueErrorHandler(app);
}
