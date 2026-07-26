# 闪传 FlashDrop

大文件（约 20GB）端到端加密远程传输工具。网页版免安装，发送方和接收方通过浏览器即可传输，文件不经过第三方明文。

## 特性

- **两种传输模式**（前端分 Tab 切换）
  - **中转模式**：文件经服务器中转落盘（本地磁盘 `uploads/` 或线上 Cloudflare R2），支持分享码、有效期、登录码、断点续传、留言。
  - **本地直传模式**：网站仅做 WebSocket 内存流转中继，文件**不落服务器磁盘**，双方实时在线传输，关闭即止，无有效期/登录码。
- **端到端加密（E2EE）**：基于 `crypto-js` 的 AES-256-CBC + HMAC-SHA256，密钥不出本地，服务器/中转方只经手密文。
- **大文件友好**：tus 分片续传（中转模式）、背压流式传输（本地直传模式），20GB 不爆内存。
- **零外网前端依赖**：Vue3 + TypeScript + Vite 打包，前端库全部本地化。

## 本地开发

```bash
npm install

# 终端 1：后端（含 /relay 内存流转中继，:3000，nodemon 自动重启）
npm run dev:server

# 终端 2：前端（Vite 热更新，:3001）
npm run dev
```

打开 http://localhost:3001 即可使用。

- `:3001` — 开发版（源码热更新，测前端用这个）
- `:3000` — 生产版（托管已构建的 `dist/`，`npm run build` 后生效）

## 生产构建

```bash
npm run build      # 类型检查 + vite 构建出 dist/
node server.mjs    # 启动服务，访问 http://<lan-ip>:3000
```

## 部署到 Cloudflare

1. **前端**：构建 `dist/`，部署到 Cloudflare Pages（或任意静态托管）。
2. **本地直传中继**：`conduit/` 文件夹即 Cloudflare Worker 中继服务，可直接部署：
   ```bash
   cd conduit
   npm install
   npm run deploy   # wrangler deploy
   ```
   部署成功后，前端构建时设置 `VITE_RELAY_URL=<你的Worker域名>` 指向中继；不设置则回退同源 `/relay`。
3. **中转模式 R2**：配置 `STORAGE_TYPE=r2` 及 R2 凭据（Account ID / Bucket / Access Key / Secret）后启用。

详见 `conduit/README.md`。

## 项目结构

```
src/
  components/   前端组件（SendPanel / ReceivePanel / LocalTransfer / ManagePanel / ExtensionsDrawer …）
  crypto/       E2EE 加解密（e2ee.ts）
  api/          后端接口封装
  composables/ 上传逻辑（useTusUpload）
  types/       类型定义
  extensions/  可插拔扩展模块
server.mjs      Node 后端（tus 中转 + 分享码索引 + 下载）
relay.mjs       Node 端 /relay WebSocket 内存流转中继
conduit/       Cloudflare Worker 中继（可直部署）
```

## 许可证

[MIT](LICENSE)
