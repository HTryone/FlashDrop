# 闪云 ArkPulse

基于浏览器的大文件端到端加密传输工具，免安装、跨平台。支持中转 / 本地直传 / P2P 直连三种模式，文件全程不经第三方明文。

当前版本：**0.1.10**（三链路均经 2.1GB 真机大文件回归验证，字节级 SHA256 一致性全部通过）。

## 项目简介

闪云 ArkPulse 要解决的核心问题只有一句话：**把一个大文件，安全、简单地发给另一个人。**

传统做法总有这样那样的别扭——第三方网盘要注册、文件明文落盘有泄露风险；邮件和聊天工具动辄几百 MB 就触到上限；专用客户端又要求收发双方都装同一款软件。ArkPulse 把这些门槛都拆掉了：

- **免安装**：纯网页运行，发件人和收件人都不用装任何软件，打开链接就能收发。
- **端到端加密**：文件在本机浏览器内加密后才离场，服务器和中转方只经手密文，连我们都无从知晓你传了什么。
- **跨平台一致体验**：同一套前端代码，可运行于浏览器、Windows 桌面端、安卓 App 三种形态（后两者由 Tauri 原生壳承载）。
- **三种传输策略**：根据网络条件在「中转 / 本地直传 / P2P 直连」间选择，兼顾速度、隐私与跨网络可达性。

无论给同事发设计稿、给朋友传相机原始文件，还是在内网临时搬一份大体积备份，都能用它完成，且全程不经第三方明文。

## 开发环境与技术栈

### 技术栈

- **前端**：Vue 3.5 + TypeScript 5.6 + Vite 6.0（SPA，构建出 `dist/`）
- **桌面 / 移动端原生壳**：Tauri 2（Rust 接管大文件落盘，跨 Windows / Android）
- **安卓原生插件**：Kotlin（`src-tauri/plugins/arkpulse-android-fs`，SAF 流式写盘）
- **中继服务**：Cloudflare Worker（`conduit/`，内存流转 + P2P 信令透传）
- **端到端加密**：HTTP 链路 crypto-js（AES-256-CBC + HMAC），tus / P2P 链路 WebCrypto（AES-NI 硬件加速）

### 构建与运行环境

| 工具 | 版本 | 路径 / 说明 |
|------|------|-------------|
| Node.js | 22.22.2（managed） | `~/.workbuddy/binaries/node/versions/22.22.2/node.exe` |
| Python | 3.13.14（managed） | `~/.workbuddy/binaries/python/versions/3.13.12/python.exe`（脚本/工具用） |
| Rust | 1.97.1（MSRV 1.77） | 系统 PATH（`rustc` / `cargo`） |
| Tauri CLI | 2.11.4 | `cargo tauri` / `npx @tauri-apps/cli` |
| Android SDK | — | `D:/Apps/SDKS` |
| NDK | 30.0.15729638 | `D:/Apps/SDKS/ndk/30.0.15729638` |
| JDK | 17 | `D:/Apps/SDKS/jdk17` |
| build-tools | 35.0.0 / 36.0.0 | `D:/Apps/SDKS/build-tools` |

> ⚠️ Windows 下 `toolbox/build-all.bat` 因中文 + UTF-8 BOM 在 cmd.exe 中会乱码，**请用 Git Bash 运行**：`node toolbox/build-all.mjs`（命令清单见 `toolbox/build-commands.txt`）。

### 前端依赖（package.json）

- 运行时：`@tauri-apps/api` `^2`、`@tauri-apps/plugin-dialog` `^2`、`@tauri-apps/plugin-fs` `^2.5.1`、`@tauri-apps/plugin-notification` `^2.3.3`、`@tauri-apps/plugin-os` `^2.3.2`、`@tus/file-store` `^2.1.0`、`@tus/s3-store` `^1.6.0`、`@tus/server` `^2.4.2`、`agent-browser` `^0.27.0`、`archiver` `^6.0.2`、`crypto-js` `^4.2.0`、`express` `^5.2.1`、`selfsigned` `^5.5.0`、`streamsaver` `^2.0.6`、`tus-js-client` `^4.3.1`、`vue` `^3.5.13`、`vue-router` `^4.6.4`、`ws` `^8.21.1`
- 开发期：`@tauri-apps/cli` `^2`、`@types/crypto-js` `^4.2.2`、`@vitejs/plugin-vue` `^5.2.1`、`nodemon` `^3.1.14`、`sharp` `^0.35.3`、`typescript` `^5.6.3`、`vite` `^6.0.5`、`vite-plugin-compression` `^0.5.1`、`vue-tsc` `^2.1.10`

### Rust 依赖（src-tauri/Cargo.toml）

`tauri` `2`、`tauri-build` `2`、`tauri-plugin-dialog` `2`、`tauri-plugin-fs` `2`、`tauri-plugin-notification` `2`、`arkpulse-android-fs`（本地路径插件）、`serde` `1`、`serde_json` `1`、`uuid` `1`、`base64` `0.22`、`zip` `2`

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

## 能干什么 / 适用场景

| 场景 | 推荐模式 | 说明 |
|------|---------|------|
| 跨网络给朋友 / 客户发大文件 | 中转(tus) | 生成分享码，对方凭码在任意设备下载；支持断点续传、有效期、留言、登录码 |
| 内网 / 同一网络内临时传文件 | 本地直传 | 文件不经任何服务器磁盘，仅 WebSocket 内存流转，连接关闭即止，零留存 |
| 双方都在线、追求最快速度 | P2P 直连 | 浏览器间点对点直传，不经中心服务器，延迟与吞吐最优 |
| 不想装客户端、只用浏览器 | 网页版 | 任意现代浏览器打开即用，无需安装，跨设备无障碍 |
| 需要常驻桌面 / 安卓 | 桌面端 / App | Tauri 壳提供系统级文件选择、系统通知、后台落盘能力 |
| 对隐私极度敏感 | 任意模式 + E2EE | 默认端到端加密，房间口令即密钥，服务器只见密文 |

> 三种模式的加密、帧格式、落盘策略细节见上方「特性」章节。

## 本地开发

```bash
npm install
npm run dev      # Vite 开发服务器，:3001，前端热更新
```

打开 http://localhost:3001 即可使用（纯前端 SPA，无需单独起后端进程）。

> P2P / 本地直传依赖中继（relay）：默认指向线上 Cloudflare Worker 中继；本地联调可在 `conduit/` 下 `npm run dev`（即 `wrangler dev`）起本地中继。详见 `conduit/README.md`。

## 生产构建

```bash
npm run build      # 类型检查(vue-tsc) + vite 构建出 dist/

# 桌面(Windows EXE) + 安卓(APK) 打包，唯一入口：
node toolbox/build-all.mjs                    # 双端
node toolbox/build-all.mjs --version 0.1.11   # 同步版本后打包
node toolbox/build-all.mjs --windows          # 仅 Windows
node toolbox/build-all.mjs --android          # 仅安卓
```

> 打包脚本自动探测 `ANDROID_HOME` / `NDK_VERSION` / `JAVA_HOME` / `BUILD_TOOLS_REVISION`，安卓仅 64 位（`arm64-v8a` + `x86_64`）。禁直调 `tauri` / `gradle` / `cargo build`，否则丢签名与归集。

## 部署到 Cloudflare

1. **前端**：构建 `dist/`，部署到 Cloudflare Pages（或任意静态托管）。
2. **本地直传 / P2P 中继**：`conduit/` 文件夹即 Cloudflare Worker 中继服务，可直接部署：
   ```bash
   cd conduit
   npm install
   npm run deploy   # wrangler deploy
   ```
   部署成功后，前端构建时设置 `VITE_RELAY_URL=<你的Worker域名>` 指向中继（默认已指向线上中继 Worker，可在 `.env` 覆盖）。P2P 信令经 `${room}::p2p` 透传，`/rtc-config` 提供 ICE 配置。
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
├── conduit/                # Cloudflare Worker 中继（可直部署）
│   └── src/
│       ├── index.js        # Worker 入口
│       └── relay.js        # 内存流转 / rtc-signal 信令透传
├── toolbox/               # 打包与开发脚本
│   └── build-all.mjs      # 桌面(Windows EXE)+安卓(APK) 打包唯一入口
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
