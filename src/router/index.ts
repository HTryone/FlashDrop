import { createRouter, createWebHistory } from 'vue-router';
import HomeView from '@/views/HomeView.vue';

// 扩展模块懒加载：用户点"更多"时才下载，首屏不捆绑
const ExtensionPanel = () => import('@/views/ExtensionPanel.vue');

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    // 更多：/ext = 模块选择页；/ext/:id = 对应模块整页（刷新可保活，无需回首页）
    { path: '/ext', name: 'ext', component: ExtensionPanel },
    {
      path: '/ext/:id',
      name: 'ext-module',
      component: ExtensionPanel,
      props: true,
    },
  ],
});

export default router;
