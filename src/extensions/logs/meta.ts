// 日志扩展模块：仅原生端（PC 桌面 + 安卓）出现；Web 不显示。
// 「更多」→ 扩展页 → 点「日志」即跳到真实诊断页 DiagPage（页面本身不改，只换入口）。
import DiagPage from '../../components/diagnostics/DiagPage.vue';
import type { Extension } from '../types';

export default {
  id: 'logs',
  title: '日志',
  desc: '收发全链路诊断 · 导出 ZIP',
  icon: '📜',
  kind: 'panel',
  order: 5,
  component: DiagPage,
  platforms: ['windows', 'phone'],
} as Extension;
