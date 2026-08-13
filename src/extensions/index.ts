// 扩展模块注册表：右侧「更多」抽屉里的内容。
// 数组顺序 = 抽屉展示顺序（可配置/可排序）；新增模块只需加一项 + 一个子目录，抽屉零改动。
// 核心逻辑写 .ts，UI 写对应子目录的 .vue（见各 extension 子目录）。

import type { Component } from 'vue';
import UsagePanel from './usage/UsagePanel.vue';
import ClearCachePanel from './clearCache/ClearCachePanel.vue';
import MarkdownPostPanel from './markdown-post/MarkdownPostPanel.vue';
import SponsorPanel from './sponsor/SponsorPanel.vue';

export type ExtensionKind = 'panel' | 'action';

export interface Extension {
  id: string;
  title: string;
  desc: string;
  icon: string; // emoji 或字符
  kind: ExtensionKind;
  component: Component; // 点方框后渲染的页面组件
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
    title: '帖子合成',
    desc: '粘贴 Markdown，套品牌头尾，一键复制成帖',
    icon: '✍️',
    kind: 'panel',
    component: MarkdownPostPanel,
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
