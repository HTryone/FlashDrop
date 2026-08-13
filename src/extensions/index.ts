// 扩展/导航注册表：右侧「更多」常驻分栏里的左侧导航。
// 数组顺序 = 导航展示顺序（可配置，首项即默认展示）；「首页」不在此列，由顶栏 ✕ 关闭后回到主界面。
// 核心逻辑写 .ts，UI 写对应子目录的 .vue（见各 extension 子目录）。
// 类型：
//  - panel: 静态面板组件（如 usage / sponsor）
//  - action: 操作型（如 clearCache）
//  - doc:   后端文档模块（目录 + 翻页，如 markdown-post）—— 内容由后端按 moduleId 提供，前端只读

import type { Component } from 'vue';
import UsagePanel from './usage/UsagePanel.vue';
import ClearCachePanel from './clearCache/ClearCachePanel.vue';
import SponsorPanel from './sponsor/SponsorPanel.vue';

export type ExtensionKind = 'panel' | 'action' | 'doc';

export interface Extension {
  id: string;
  title: string;
  desc: string;
  icon: string;
  kind: ExtensionKind;
  component: Component; // panel/action 用：点导航后渲染的页面组件
  moduleId?: string; // kind==='doc' 时：后端数据源的模块标识
}

export const extensions: Extension[] = [
  {
    id: 'usage',
    title: '使用说明',
    desc: '发送、接收、续传、加密的完整用法',
    icon: '📖',
    kind: 'panel',
    component: UsagePanel,
  },
  {
    id: 'clearCache',
    title: '清空缓存',
    desc: '清除本机浏览器保存的偏好与临时数据',
    icon: '🧹',
    kind: 'action',
    component: ClearCachePanel,
  },
  {
    id: 'markdown-post',
    title: '项目动态',
    desc: '公告与更新（后端发布，前端只读展示）',
    icon: '📰',
    kind: 'doc',
    component: SponsorPanel, // 占位，doc 实际渲染走 ModuleView
    moduleId: 'posts',
  },
  {
    id: 'sponsor',
    title: '赞助链接',
    desc: '支持本项目持续维护',
    icon: '💝',
    kind: 'panel',
    component: SponsorPanel,
  },
];
