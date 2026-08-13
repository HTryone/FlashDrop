import ClearCachePanel from './ClearCachePanel.vue';
import type { Extension } from '../types';

export default {
  id: 'clearCache',
  title: '清空缓存',
  desc: '清除本机浏览器保存的偏好与临时数据',
  icon: '🧹',
  kind: 'action',
  order: 20,
  component: ClearCachePanel,
} as Extension;
