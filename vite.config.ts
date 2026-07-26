import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// 开发期 Vite 跑在 5173，把 API / 上传 / 下载 代理到 Node 服务(3000)，避免跨域。
// 生产期：node server.mjs 直接托管 dist/，同源零跨域。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true, // 暴露到局域网，方便手机/其他电脑测
    port: 5173,
    proxy: {
      '/files': { target: 'http://localhost:3000', changeOrigin: true },
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/download': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
