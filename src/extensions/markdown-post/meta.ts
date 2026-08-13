import type { Extension } from '../types';

// 文档类模块：内容由后端按 moduleId 提供，前端只读展示（走 ModuleView）。
export default {
  id: 'markdown-post',
  title: '项目动态',
  desc: '公告与更新（后端发布，前端只读展示）',
  icon: '📰',
  kind: 'doc',
  order: 30,
  moduleId: 'posts',
} as Extension;
