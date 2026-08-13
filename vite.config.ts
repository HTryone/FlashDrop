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
    port: 3001,
    proxy: {
      '/files': { target: 'http://localhost:3000', changeOrigin: true },
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/download': { target: 'http://localhost:3000', changeOrigin: true },
      '/stream': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // 把第三方库拆成独立 vendor 块，便于浏览器长期缓存、并行加载
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/](vue|vue-router|@vue)[\\/]/.test(id)) return 'vue-vendor';
          if (/[\\/]node_modules[\\/]crypto-js[\\/]/.test(id)) return 'crypto';
          if (/[\\/]node_modules[\\/]streamsaver[\\/]/.test(id)) return 'streamsaver';
        },
      },
    },
  },
});
