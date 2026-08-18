// 全局捕获（§1.5/§2）：系统级兜底，任何未处理异常都进日志，不依赖业务主动埋点。
// 须在 main.ts 最前调用（早于业务代码），保证初始化阶段闪退也有记录（§3.2 早初始化）。
import { error, setNativeCapture } from './logger';
import { isTauriEnv } from '../tauri/env';
import { installObservers } from './observe';

export function installGlobalCapture(): void {
  // 原生桥接：Tauri 壳内才接，Web 端 no-op（§3.3 应用层专属）。
  if (isTauriEnv()) {
    import('../tauri/diagnostics').then((m) => m.registerNativeCapture()).catch(() => {});
  }

  // 全量请求埋点（§1.6）：fetch/WebSocket/WebRTC 全局包裹，覆盖三链路每一笔请求。
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

// Web 侧安装入口（main.ts 调用）。
export function installDiagnostics(app?: any): void {
  installGlobalCapture();
  if (app) installVueErrorHandler(app);
}
