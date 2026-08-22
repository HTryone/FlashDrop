import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import viteCompression from 'vite-plugin-compression';
import { fileURLToPath, URL } from 'node:url';

// 启动遮罩 splashscreen.html 由 Rust 壳层经 bundle.resources 内嵌进安装包
// （桌面落 exe 同目录 splash/，安卓落 APK assets/splash/），Rust 侧用 resource_dir()/App 加载，
// 不进前端 frontendDist(dist/)。故 vite 无需为 splash 做任何复制。

// 开发期 Vite 跑在 5173，把 API / 上传 / 下载 代理到 Node 服务(3000)，避免跨域。
// 生产期：node server.mjs 直接托管 dist/，同源零跨域。
export default defineConfig({
  plugins: [
    vue(),
    // 预压缩：gzip + brotli 双格式，Cloudflare 自动选最优发给浏览器
    viteCompression({ algorithm: 'gzip', ext: '.gz' }),
    viteCompression({ algorithm: 'brotliCompress', ext: '.br' }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true, // 暴露到局域网，方便手机/其他电脑测
    port: Number(process.env.ARKPULE_DEV_PORT || '3001'),
    watch: {
      // 忽略 Tauri 原生壳目录，避免 Rust 改动触发 Vite 热重载
      ignored: ['**/src-tauri/**'],
    },
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
