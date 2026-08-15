// 环境检测：是否运行在 Tauri 原生壳内（WebView2/WKWebView），而非普通浏览器。
// 普通浏览器里 isTauri() 返回 false，@tauri-apps/api 不会抛错，走原 FSA/StreamSaver/Blob 路径。
import { isTauri } from '@tauri-apps/api/core';

export function isTauriEnv(): boolean {
  return isTauri();
}
