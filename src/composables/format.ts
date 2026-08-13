// 字节大小格式化：统一替代各组件中重复的 fmt / fmtSize 实现（共 6 处）。
// 边界严格对应：<1024 显示 B，之后 KB / MB / GB；返回值与传入字节数一一对应，无精度丢失。
export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// 时间格式化：中转接收面板（ReceivePanel）与传输管理面板（ManagePanel）原各写一份，
// 此处统一。withSeconds 控制是否带「秒」——ManagePanel 看创建时间需要，ReceivePanel 看有效期不需要。
export function fmtTime(ts: number, withSeconds = false): string {
  if (!ts) return '-';
  const opts: Intl.DateTimeFormatOptions = {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  };
  if (withSeconds) opts.second = '2-digit';
  return new Date(ts).toLocaleString('zh-CN', opts);
}

// 有效期剩余文字：>1h 显示「约 X 小时」，否则「约 X 分钟」，已过期显示「已过期」。ReceivePanel 用。
export function remainText(expiresAt: number): string {
  if (!expiresAt) return '';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return '已过期';
  const h = Math.floor(ms / 3600000);
  if (h >= 1) return `剩余约 ${h} 小时`;
  const m = Math.ceil(ms / 60000);
  return `剩余约 ${m} 分钟`;
}

// 有效期剩余毫秒（已过期返回 0）。ManagePanel 用于「剩余 X 小时」数字展示。
export function remainMs(expiresAt: number): number {
  if (!expiresAt) return 0;
  return Math.max(0, expiresAt - Date.now());
}

// 16 位登录码分组显示：XXXX XXXX XXXX XXXX。非 16 位原样返回。
export function formatLoginCode(raw: string): string {
  if (!raw || raw.length !== 16) return raw;
  return raw.slice(0, 4) + ' ' + raw.slice(4, 8) + ' ' + raw.slice(8, 12) + ' ' + raw.slice(12, 16);
}
