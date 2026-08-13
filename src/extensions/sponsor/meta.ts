import SponsorPanel from './SponsorPanel.vue';
import type { Extension } from '../types';

export default {
  id: 'sponsor',
  title: '赞助链接',
  desc: '支持本项目持续维护',
  icon: '💝',
  kind: 'panel',
  order: 40,
  component: SponsorPanel,
} as Extension;
