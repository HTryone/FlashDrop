import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';

// 尽早注册 Service Worker：让 StreamSaver 下载走「SW 直连通道」而非脆弱的 mitm iframe 兜底。
// mitm 兜底要求每条消息带 MessageChannel 端口，被扩展/时序干扰后抛 "didn't send a messageChannel" 导致下载建不起来。
// 关键：必须在页面加载早期注册，使 SW 在用户开始下载前就 active 并 claim 当前页面
// （新注册的 SW 需 install→activate→claim 周期，下载时才注册往往 3s 超时退回 mitm）。
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  const proto = location.protocol;
  const host = location.hostname;
  if (proto === 'https:' || host === 'localhost' || host === '127.0.0.1') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// 系统级日志：最早安装全局捕获（先于业务，初始化阶段闪退也有记录，§3.2）。
import { installDiagnostics } from './diagnostics/install';
const app = createApp(App);
installDiagnostics(app);
app.use(router).mount('#app');
