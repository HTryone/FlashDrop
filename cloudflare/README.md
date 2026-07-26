# FlashDrop 本地磁盘模式 · Cloudflare Worker 中继

本地磁盘模式下，文件**不落服务器磁盘**，只在网站（本 Worker）内存里流转，两端浏览器实时收发。
本文件夹即中继服务，可直接部署到 Cloudflare Workers。

## 协议
- 连接：`wss://<你的Worker域名>/relay?room=<房间码>&role=sender|receiver`
- 房间码仅用于信令会合，Worker 不存任何文件/密钥。
- 控制消息（JSON）：`offer` / `ready` / `* -joined` / `peer-left` / `done`
- 数据消息（二进制）：`[fileIndex u16][chunkIndex u32][16B IV][ciphertext][32B HMAC]`，密文由浏览器端 E2EE 加密

## 本地调试
```bash
cd cloudflare
npm install
npm run dev        # wrangler dev，本地 http://localhost:8787/relay
```

## 部署方式一：命令行
```bash
cd cloudflare
npm install
npm run deploy     # wrangler deploy，需要已登录 Cloudflare
```
部署成功后记下 Worker 域名（如 `flashdrop-relay.<subdomain>.workers.dev`）。

## 部署方式二：Cloudflare 控制台连 Git
1. 控制台 → Workers & Pages → 创建 → 连接到 Git
2. 选本仓库，构建目录/根目录填 `cloudflare`
3. 框架预设选“无 / 其他”，它会读取 `cloudflare/wrangler.toml` 部署

## 前端对接
前端“本地直传”默认连**同源** `/relay`。线上若前端与 Worker 不同域，构建前端时设：
```bash
VITE_RELAY_URL=flashdrop-relay.<subdomain>.workers.dev npm run build
```
（前端代码已支持 `import.meta.env.VITE_RELAY_URL`，未设则回退同源）

## 大文件注意（20GB）
- 前端已做背压：接收方慢时反压发送方，Worker 内存只留“飞行中”小块窗口，不会爆内存。
- 传输是实时的：两端必须同时在线，断开即止，**无有效期、无断点续传**（需重新选择文件再传）。
- Cloudflare 免费版 DO 有实例/请求限制，生产大文件建议付费计划。
