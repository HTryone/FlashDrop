// 设备标识（核心逻辑层，类比 .ts）：统收"我是哪一端"，UI 只认本模块输出，不在组件里散判。
//
// 识别规则（用户定，纯同步、零网络、零异步兜底）：
//   - 壳（App）在网页代码运行前注入 window.__ARKPULSE_CLIENT__.kind：
//       'windows' → 桌面 App（当前仅 Windows 桌面）
//       'phone'  → 手机 App（Android）
//   - 零注入（浏览器直接打开）→ 'web'
// 网页内容本身从 Cloudflare 拉取（外置架构），但设备识别与布局切换全在本地，不额外走网络。
export type ClientKind = 'windows' | 'phone' | 'web';

declare global {
  interface Window {
    __ARKPULSE_CLIENT__?: { kind?: string };
  }
}

let cached: ClientKind | null = null;

export function getClientKind(): ClientKind {
  if (cached) return cached;
  const k = window.__ARKPULSE_CLIENT__?.kind;
  cached = k === 'windows' || k === 'phone' ? k : 'web';
  return cached;
}

export const isWindows = () => getClientKind() === 'windows';
export const isPhone = () => getClientKind() === 'phone';
export const isWeb = () => getClientKind() === 'web';
