# 闪云 ArkPulse

基于浏览器的大文件端到端加密传输工具，免安装、跨平台。支持中转 / 本地直传 / P2P 直连三种模式，文件全程不经第三方明文。

当前版本：**v1.0**（三链路均经 2.1GB 真机大文件回归验证，字节级 SHA256 一致性全部通过）。

## 特性

### 三种传输模式（前端分 Tab 切换）

- **中转模式（tus）**：文件经服务器中转落盘（本地磁盘 `uploads/` 或线上 Cloudflare R2），支持分享码、有效期、登录码、断点续传、留言。适合跨网络、非实时场景。
- **本地直传（HTTP 中继）**：网站仅做 WebSocket 内存流转中继（`/relay`），文件**不落服务器磁盘**，双方实时在线传输，关闭即止，无有效期/登录码。适合同网络或对隐私敏感场景。
- **P2P 直连（WebRTC DataChannel）**：浏览器之间建立点对点数据通道，**不经中心服务器中继**，双方直接互传，是三种模式中最快的一种。信令经轻量 relay 转发 SDP/ICE，数据面完全 P2P。

### 端到端加密（E2EE）

所有链路默认端到端加密，密钥由房间口令（`#k=...`）派生，服务器/中转方只经手密文。两链路共用**同一字节级帧格式**，解析逻辑共享、互不干扰：

```
[4B 长度前缀][12B 帧头: 文件索引 u16 + 块索引 u32 + 明文长度 u32][e2ee 密文体: 16B IV + AES-256-CBC 密文 + 32B HMAC]
```

- **HTTP 本地直传链路**：基于 `crypto-js` 的 AES-256-CBC + HMAC-SHA256，PBKDF2 派生密钥，借助 Web Worker 池并发加解密（`composables/useLocalCrypto` + `workers/localCrypto.worker.ts`）。
- **中转(tus)链路**：基于浏览器原生 WebCrypto（`subtle`）的 AES-256-CBC + HMAC-SHA256，AES-NI 硬件加速（约 GB/s），帧格式与 HTTP 链路一致、可跨库互通（`crypto/tus-crypto.ts`）。
- **P2P 链路**：基于浏览器原生 WebCrypto（`subtle`）的 AES-256-CBC + HMAC-SHA256（encrypt-then-MAC、恒定时间比较），主线程 `await` 派生，无需 Worker 池，更省 CPU。数据以 4MB 逻辑块为单位，DataChannel 拆为 ≤256KB 子帧在接收端重组。

### 大文件友好

- 中转模式：tus 分片续传，20GB 不爆内存。
- 本地直传 / P2P：背压流式传输（`bufferedAmount` 原生反压 + 后台异步落盘），边收边写、支持 seek 续传。

### 纯前端 / 零外网依赖

Vue3 + TypeScript + Vite 构建，无 CDN、无第三方运行时依赖，可完全离线部署。

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
2. **本地直传 / P2P 中继**：`conduit/` 文件夹即 Cloudflare Worker 中继服务，可直接部署：
   ```bash
   cd conduit
   npm install
   npm run deploy   # wrangler deploy
   ```
   部署成功后，前端构建时设置 `VITE_RELAY_URL=<你的Worker域名>` 指向中继；不设置则回退同源 `/relay`。P2P 信令经 `${room}::p2p` 透传，`/rtc-config` 提供 ICE 配置。
3. **中转模式 R2**：配置 `STORAGE_TYPE=r2` 及 R2 凭据（Account ID / Bucket / Access Key / Secret）后启用。

详见 `conduit/README.md`。

## 项目结构

```
ArkPulse/
├── index.html
├── package.json
├── package-lock.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── server.mjs              # Node 后端：tus 中转 + 分享码索引 + 下载
├── relay.mjs               # Node /relay WebSocket 内存流转中继
├── conduit/                # Cloudflare Worker 中继（可直部署）
│   └── src/
│       ├── index.js        # Worker 入口
│       └── relay.js        # 内存流转 / rtc-signal 信令透传
├── public/                 # 静态资源
└── src/
    ├── main.ts
    ├── App.vue
    ├── components/          # 前端 Vue 组件（纯 UI 壳）
    │   ├── SendPanel.vue
    │   ├── ReceivePanel.vue
    │   ├── LocalTransfer.vue
    │   ├── ManagePanel.vue
    │   ├── ExtensionsDrawer.vue
    │   ├── SendFileRow.vue
    │   └── ReceiveFileRow.vue
    ├── crypto/
    │   ├── e2ee.ts          # 本地直传(HTTP) E2EE（crypto-js，AES-256-CBC+HMAC）
    │   ├── tus-crypto.ts    # 中转(tus) E2EE（WebCrypto，AES-NI 硬件加速）
    │   └── p2p-crypto.ts    # P2P 专用 WebCrypto 加密（AES-CBC+HMAC，独立派生）
    ├── https/               # 本地直传链路（HTTP relay）
    │   ├── index.ts
    │   ├── types.ts         # 链路类型定义
    │   ├── frame.ts         # 统一帧格式编解码
    │   ├── segment.ts       # 按时间/字节切段（SEGMENT_TIME_MS 等）
    │   ├── sender.ts
    │   ├── receiver.ts
    │   ├── control.ts       # 控制 WS（含心跳）
    │   └── sink.ts
    ├── p2p/                 # P2P WebRTC 链路
    │   ├── index.ts
    │   ├── signaling.ts     # ${room}::p2p 信令
    │   ├── peer.ts
    │   ├── channel.ts       # DataChannel 背压（bufferedAmount）
    │   ├── framing.ts
    │   ├── sinks.ts         # 接收端异步落盘（8MB 合并写）
    │   ├── sender.ts
    │   ├── receiver.ts
    │   ├── ice.ts
    │   └── types.ts
    ├── transfer/            # 公共房间与状态（HTTP/P2P 共用）
    │   └── room.ts
    ├── composables/
    │   ├── useTusUpload.ts  # 中转模式上传
    │   └── useLocalCrypto.ts# HTTP 加密 Worker 池封装
    ├── workers/
    │   └── localCrypto.worker.ts
    ├── api/
    │   ├── client.ts
    │   └── transfer.ts
    ├── types/
    │   └── transfer.ts
    └── extensions/
        └── index.ts
```

## 性能与已知边界

- **P2P 吞吐天花板 ≈ 26 MB/s**：由浏览器内置 `libwebrtc` 数据通道栈决定（C++ 侧，JS 无调优接口）。实测 unordered / 多 DataChannel / 多 PeerConnection / 调整子帧大小等方向均无法突破，属终局瓶颈，不在优化范围。
- **接收端落盘呈 OS 层梯形震荡**：Windows 任务管理器「磁盘传输速率」曲线呈周期性脉冲，是操作系统写回缓存的固有行为，与传输吞吐无关（网络层 DC 接收为恒速）。此现象不反映性能劣化，也不在优化范围。

## 许可证

[MIT](LICENSE)
