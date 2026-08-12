// 字节大小格式化：统一替代各组件中重复的 fmt / fmtSize 实现（共 6 处）。
// 边界严格对应：<1024 显示 B，之后 KB / MB / GB；返回值与传入字节数一一对应，无精度丢失。
export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
