import { createRouter, createWebHashHistory } from 'vue-router';
import HomeView from '@/views/HomeView.vue';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    // 更多：/ext = 模块选择页；/ext/:id = 对应模块整页（刷新可保活，无需回首页）
    { path: '/ext', name: 'ext', component: () => import('@/views/ExtensionPanel.vue') },
    {
      path: '/ext/:id',
      name: 'ext-module',
      component: () => import('@/views/ExtensionPanel.vue'),
      props: true,
    },
  ],
});

export default router;
