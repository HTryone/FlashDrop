import UsagePanel from './UsagePanel.vue';
import type { Extension } from '../types';

export default {
  id: 'usage',
  title: '使用说明',
  desc: '发送、接收、续传、加密的完整用法',
  icon: '📖',
  kind: 'panel',
  order: 10,
  component: UsagePanel,
} as Extension;
