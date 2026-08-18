# 闪云 ArkPulse — 双端系统级日志与传输全链路诊断（草稿方案）

> 状态：草稿，待评审。你先看，确认方向（尤其 Flutter 那节）我再动手。

## 0. 背景与目标

**现状证据（已 grep `console.*` 全仓）**
- 仅 10 个文件散落 `console.log/warn/error`，共约 36 处：
  - `p2p/peer.ts` ×13、`transfer/tus/stream-download.ts` ×6、`https/receiver.ts` ×3、`https/sender.ts` ×2、`p2p/ice.ts` ×2、`p2p/signaling.ts` ×2、`composables/filesink.ts` ×2、`https/useLocalCrypto.ts` ×1、`p2p/channel.ts` ×1、`transfer/tus/useTusUpload.ts` ×1
- 无统一出口、无分级、无持久化、无 `traceId` 关联；Rust 原生侧（落盘/IO/权限）完全无日志，前端看不到。

**目标（对应你的原话：系统级日志，可检测软件的所有问题）**
1. 双端（Windows 桌面 + Android）加**系统级日志**：分级、持久化落盘、可导出，**覆盖软件全部子系统**（不止传输）。
2. **监控软件所有问题**：`traceId` 把一次传输/任务的每一步串成时间线；同时全局捕获 UI/路由/生命周期、传输三链路、原生 IO/权限/SAF、IPC 桥接、崩溃与未捕获异常、性能异常——问题不漏网、全流程可追溯。
3. **问题检测 / 健康总览**：按 severity 聚合，自动标红异常；首页/悬浮窗给出「X 错误 / Y 警告 / 各子系统状态灯」。
4. 原生 app 内部实现：壳 = Tauri（Vue webview + Rust 核心）。
5. UI：**窗口级悬浮玻璃**（浮于所有内容上方）+ 底部**圆形长条**导航（主页左 / 更多右，切换玻璃内容）；日志可打包 **ZIP** 导出、分发、分享。
6. 关于 Flutter：见 §7（与 §1.1 死纪律冲突，需你拍板）。

## 1. 总体架构

```
[全子系统埋点 + 全局捕获，统一带 traceId]
  UI/路由/生命周期 · 传输三链路(tus/https/p2p) · 原生IO/权限/SAF · IPC桥接 · 崩溃/未捕获 · 性能
      │  window.onerror / unhandledrejection / Rust panic_hook 全量接住
      ▼
┌─────────────────────────────────────────────┐
│  Web 日志器  src/diagnostics/logger.ts        │  RingBuffer(内存, 2000条)
│  log(level, channel, scope, msg, data)        │
└───────────────────┬─────────────────────────┘
        │  diagnostics_capture (command)  命令转发原生
        ▼
┌─────────────────────────────────────────────┐
│  Rust 诊断模块  src-tauri/src/diagnostics/     │  RingBuffer + 文件持久化
│  logger.rs  store.rs  commands.rs  panic_hook  │  日志目录 log/ (安装根/Android files, 7天滚动覆盖)
│  捕获：落盘字节/IO成败/权限/SAF/native错误/panic │
└───────────────────┬─────────────────────────┘
        │  event stream 回传前端(实时)
        ▼
┌─────────────────────────────────────────────┐
│  UI 层 (Vue, 毛玻璃, 窗口级悬浮)                 │
│  ① 窗口级悬浮玻璃 DiagShell (浮于所有内容正上方)   │
│  ② 底部圆形长条 (主页左/更多右, 切换玻璃内容)       │
└─────────────────────────────────────────────┘
```
关键点：`traceId` 由 Web 生成，经 command 上下文带入 Rust，Rust 落盘也带同一 `traceId` → 双端同一 bug 全流程串联；`window.onerror`/`unhandledrejection`/Rust `panic_hook` 保证任何未捕获异常都进日志，做到「所有问题不漏网」。

### 1.1 覆盖矩阵（系统级 = 全子系统）

| 子系统 | 捕获点 | 标识 |
|--------|--------|------|
| UI / 路由 / 生命周期 | `App.vue`、路由守卫、`app.config.errorHandler`、组件 `onErrorCaptured` | `tag=ui` |
| 全局未捕获 | `window.onerror` / `unhandledrejection` | `tag=global` |
| 传输三链路 | `tus/` `https/` `p2p/` 各模块 | `traceId` |
| 加密协商 | 密钥派生、加/解密、HMAC 校验失败（frame 头/IV/密文） | `tag=crypto` |
| 网络层 / 连接 | DNS、TCP/TLS 握手、proxy、STUN/TURN 可达性、超时/重试 | `tag=net` |
| 原生 IO / 权限 / SAF | Rust `write_chunk`/`close_file`/`resolve_save_path` 等 | `traceId + native` |
| 权限授予（OS 级） | Android 存储/通知权限弹窗、拒绝；Windows UAC/防火墙拦截 | `tag=perm` |
| 配置 / 设置变更 | 用户改设置导致异常（线路优先级、分块大小等） | `tag=config` |
| 更新 / 自检 | 壳冷更新(Rust+壳配置)、远程热更新(CF 推送)、启动自检失败 | `tag=update` |
| IPC 桥接 | Tauri `invoke` 失败 / 超时 | `tag=ipc` |
| 看门狗 / 存活 | 主线程阻塞、心跳超时、web→native ping 丢失 | `tag=watchdog` |
| Web Worker / WASM | 解密 Worker 内存累积崩溃、WASM 模块加载/初始化失败 | `tag=worker` |
| 后台限制（Android） | Doze / app-standby / 后台被杀、省电策略中断传输 | `tag=bg` |
| 崩溃 / panic | Rust `panic_hook`、前端崩溃、硬崩边界(见 §3.2) | `tag=crash` |
| 性能异常 | 耗时超阈、内存峰值、JS 堆压力 | `tag=perf` |

## 1.2 发送端全流程环节清单（每一环节 = 一个日志检查点）

> 目标：发送端三链路每一步都留痕，任一环节无日志 = 该环节未覆盖，E2E 测试不通过（证据来自实际代码）。

| 链路 | 环节 | 关键动作（证据文件:行） | 失败可观测点 |
|------|------|------------------------|--------------|
| 通用 | 选文件/排队 | `QueuedFile` 入队 (`useTusUpload.ts`) | 文件读取失败 |
| tus 中转 | E2EE 加密 | `encryptFile` (`useTusUpload.ts:167`) | 加密异常 |
| tus 中转 | 建上传记录 | `POST /files`→fileId (`createUpload:40`) | HTTP 非 2xx |
| tus 中转 | 块预签名 | `POST /api/presign` (`presign:58`) | presign 失败 |
| tus 中转 | 分块直传 R2 | `uploadSliceXHR` PUT (`uploadSliceXHR:103`) | neterr / 看门狗 55s |
| tus 中转 | 降档 | 32→24→16MB (`TIERS:33`) | 兜底档连续失败→中止 |
| tus 中转 | 提交落盘 | `POST /api/commit` + HEAD 复核 (`headOffset:92`) | commit 失败 / offset≠size |
| https 直传 | 生成房间 | `genRoomCode`+`randomPassphrase` (`sender.ts:88`) | — |
| https 直传 | 控制通道 | `RelayControl.connect` (`sender.ts:321`) | WS 连不上 |
| https 直传 | 发 offer | POST offer JSON (`postOfferSeg:475`) | offer 失败 |
| https 直传 | 就绪闸门 | 等 recv-ready/pull (`sender.ts:346`) | 对方未接收超时(8×15s) |
| https 直传 | 读+加密分片 | `file.slice`+`encryptChunkAsync` (`sender.ts:530`) | 读文件/加密失败 |
| https 直传 | 流水线推流 | 窗口24MB+3路 POST (`pumpPool:567`) | 网络抖动重发 4 次 |
| https 直传 | 段末/关流 | segend + `closeStream` (`postSegendFrame:501`/`closeStream:162`) | close 失败 |
| p2p | 建链 | `createDataChannel`+`createOffer` (`peer.ts:111/118`) | `RTCPeerConnection` 构造失败 |
| p2p | 信令 | `sendSignal`(offer/answer/candidate) (`peer.ts:124/171`) | relay 未缓冲/回声 |
| p2p | ICE 协商 | `onicecandidate`/`addIceCandidate` (`peer.ts:72/189`) | candidate 失败 |
| p2p | 连接态 | `connectionState` connected/failed (`peer.ts:80`) | failed→重连 |

## 1.3 接收端全流程环节清单（每一环节 = 一个日志检查点）

| 链路 | 环节 | 关键动作（证据文件:行） | 失败可观测点 |
|------|------|------------------------|--------------|
| 通用 | 选保存目录 | `pickSaveDir` (`receiver.ts:129` / `stream-download.ts:184`) | 用户取消 / 选择器禁用 |
| 通用 | 目录授权 | `requestPermission('readwrite')` (`receiver.ts:141`) | 未授权 |
| 通用 | 建 Sink | `makeSinks` FSA/StreamSaver/Blob (`receiver.ts:256`) | fallback / 初始化失败 |
| 通用 | 密钥派生 | `deriveKey` (`receiver.ts:155`) | 派生失败 |
| tus 下载 | 并发取数 | `fetchPart` 55s看门狗+整part重取 (`stream-download.ts:67`) | 长度不符 / 403 过期 |
| tus 下载 | 顺序解密 | `FrameDecoder` HMAC 校验 + `decryptFrame` (`stream-download.ts:124/155`) | HMAC 失配→二次重取对比 |
| tus 下载 | 顺序落盘 | `sink.write` (`stream-download.ts:246`) | 写盘失败 |
| tus 下载 | 完成关闭 | `dec.flush` + `sink.close` (`stream-download.ts:281/288`) | 末块未落盘 |
| https 直传 | 解析链接 | `parseLink` room+pass (`receiver.ts:65`) | 非法 URL |
| https 直传 | 建控制WS+GET | `RelayControl.connect` + `fetch /stream` (`receiver.ts:180/197`) | 连接失败 HTTP |
| https 直传 | 读 offer | 文件清单 JSON (`receiver.ts:235`) | 未收到清单 / 无效 |
| https 直传 | 段序号校验 | `segIndex` 比对 (`receiver.ts:243`) | 错乱 |
| https 直传 | 发 recv-ready | POST recv-ready (`receiver.ts:274`) | — |
| https 直传 | 收帧+解密 | `handleDataFrame`+`decryptChunkAsync` (`receiver.ts:353/364`) | 解密失败 / 索引越界 |
| https 直传 | 保序写盘 | `drainWrites` `sink.write` (`receiver.ts:393/401`) | 写盘失败 |
| https 直传 | 完成 | recv-done + `finishRecv` (`receiver.ts:415/320`) | 部分写入失败 |
| p2p | 收 offer | `setRemoteDescription`+`createAnswer` (`peer.ts:166`) | InvalidState |
| p2p | 收 candidate | `addIceCandidate` (`peer.ts:189`) | 失败 |
| p2p | DC open | `ondatachannel`+`wireDc` (`peer.ts:95`) | dc error |
| p2p | 连接态 | `connectionState` (`peer.ts:80`) | failed→重连 |

### 1.4 铁律检查点（最易「假完成」，必须单列入日志）

这两条是历史上出过「假 100%」的根因，诊断必须能单独验证，否则全流程测试无效：
- **上传端铁律**（`useTusUpload.ts` 代码注释）：成功 ≡ 服务器落盘成功。需逐块记录 `PUT 200 + commit head 确认 + HEAD 复核 offset===size`；进度硬封顶 99% 直到 `finished=true`。日志须能区分「最后一块已发出」vs「真正落盘」。
- **下载端铁律**（`stream-download.ts` 代码注释）：返回成功 ≡ 用户落盘成功。需记录 `sink.write 末块 + dec.flush 通过 + sink.close 关闭句柄` 三者齐全才标 100%；任何「提前完成/提前关闭」在日志中标红。

**E2E 门禁**：§8 Phase 4 的故障注入必须逐环节命中——落盘失败、网络断、对方取消、段序号错乱、HMAC 失配、看门狗超时——且每一环节日志都能在 `log/`（安装根/Android files）与 `crash-*.json` 中找到对应记录，缺一则测试不通过。

### 1.5 排查盲区清单（直接影响问题定位、当前方案未覆盖）

> 下列项不补，一线反馈（"连不上""传不完""文件坏了"）将无法复现与定位。按「盲了就抓瞎」的严重程度分三档。

**Tier 1 — 盲了就定位不了（必须补）**

| # | 盲区 | 为什么直接影响排查 | 要补的日志/检测点 |
|---|------|--------------------|-------------------|
| 1 | **运行环境指纹** | 没有环境，"连不上"半数无法复现。需在启动 + 崩溃快照里固化 | OS 版本、App 版本(**commit hash**)、Tauri/webview 版本、网络类型(WiFi/有线/蜂窝)、**NAT 类型(STUN 绑定测试结果)**、IPv4/IPv6 双栈、UDP 入站是否通、本地时区时钟 vs NTP |
| 2 | **磁盘空间余量** | 接收端落盘失败最常见根因之一，当前完全没监测 | 落盘前记录可用空间，`<阈值` 标红；空间不足导致的 write 失败带余量值 |
| 3 | **文件名/路径编码与冲突重命名** | Windows 经典落盘 bug 源（emoji/空格/超长路径/中文），当前未覆盖 | `resolve_save_path` 记原始名、规范化名、是否触发冲突重命名(`file (1).ext`)、路径长度超限 |
| 4 | **端到端全文件完整性**（静默损坏） | 现有仅 per-frame HMAC，HMAC 过但整文件损坏时无法发现 | 源端算全文件 hash → 接收端校验，作为铁律之外的**第三道**；不一致标红并附偏移段 |
| 5 | **卡死检测**（非崩溃但流程没走完） | "每一环节不落下"的延伸：卡在 connecting/transferring 也算没走完 | per-phase 超时：offer 发后 N 秒无 answer、established 后 N 秒无首字节、落盘后 N 秒无 flush → 日志标红"卡在 X 环节" |
| 6 | **代理/VPN 干扰专项** | 你明确用代理，多数"连不上"根因在代理拦截/篡改 relay/WS/STUN | 检测是否对 relay 域名/WebSocket/STUN 走系统代理、proxy 地址、响应是否被代理改写 |

**Tier 2 — 影响定位效率（建议补）**

| # | 盲区 | 排查价值 | 检测点 |
|---|------|----------|--------|
| 7 | **残留文件扫描与清理报告** | 强杀后下载一半的临时文件/未 close 句柄占盘，下次启动应扫描报告 | 启动扫描 `ArkPulse/` 与临时区，列出未完成传输的孤儿文件 |
| 8 | **并发多传输争用** | 同跑多个传输时的 Sink/锁/Worker 竞争、串行化失败 | 多 traceId 并发时的锁等待、Worker 排队时长 |
| 9 | **内存/句柄泄漏趋势** | 已知解密 Worker 内存累积崩溃的根；单次看不出，要看趋势 | 每次传输结束记 JS heap / native RSS 增量，连续增长=泄漏信号 |
| 10 | **连接质量量化** | 配合上传优化项目对 MB/s 的关注，验证"流畅"而非只看成败 | 每传输记吞吐量曲线、重传次数、RTT/抖动、丢帧 |
| 11 | **取消语义区分** | 用户主动取消(正常) vs 异常中断(需排查) 必须分开 | 终止原因 `reason=cancel|crash|peer-left|timeout` 明确标注 |

**Tier 3 — 边界但值得（可后置）**

| # | 盲区 | 检测点 |
|---|------|--------|
| 12 | **前后端版本错配** | 冷更新(Rust+壳) vs 远程热更新(前端) 版本号不一致 → IPC 命令找不到时记双方版本 |
| 13 | **中继响应明细** | CloudFlare 5xx/429 的 `cf-ray`、`retry-after` 记下来定位云端侧 |
| 14 | **时钟/证书有效期** | 每次 TLS 错误记本地时间 vs 证书有效期，排除时钟偏移导致校验失败 |

**落点**：Tier 1 的 1/2/3/4/5/6 在 Phase 1 一并落地（环境指纹进 crash 快照 + 启动日志；磁盘/文件名/完整性/卡死/代理进各自链路埋点）；Tier 2 在 Phase 3 前补；Tier 3 可后置到维护期。

### 1.6 全量请求埋点铁规（所有请求一律都看）

> 你的原话："所有请求一律都看"。据此立规：**任何跨进程/跨网络/跨线程的"请求-响应"都必须留痕，无一例外**。统一结构，便于检索与崩溃回放。

**统一请求记录结构**（每条请求一行，必带 `traceId`）：
```
{ dir: out|in, layer: http|ws|webrtc-sig|stun|turn|ipc|fileio,
  method, host/url(脱敏密钥), path, key_headers(脱敏),
  status/code, bytes, duration_ms, attempt, retry_backoff_ms, error }
```

**覆盖清单（全量，三链路 + 原生）**

| 层 | 必记请求 | 证据/位置 |
|----|----------|-----------|
| HTTP | 全部 `XHR`/`fetch`：presign、commit、PUT(分块)、HEAD(复核)、fetchPart、GET-stream、postOffer、recv-ready、segend、recv-done | `useTusUpload.ts`、`stream-download.ts`、`sender.ts`、`receiver.ts` 现有 fetch/XHR 调用点 |
| WebSocket | `open`/`close(code+reason)`/`ping`/`pong`/`error` + **每条 app 消息**(type/size/收发时间戳) | `RelayControl.connect`(`sender.ts:321`/`receiver.ts:180`)、`postOfferSeg`/`handleDataFrame` |
| WebRTC 信令 | 每条 `signal`(offer/answer/candidate) 收发 + 时间戳 + 是否回声/丢缓冲 | `peer.ts:124/166/171/189`、`ice.ts`、`signaling.ts` |
| STUN/TURN | binding 请求/响应、TURN allocation/refresh（transport udp/tcp/tls） | `ice.ts` |
| IPC | 每次 `tauri invoke` 命令名 + 耗时 + 结果/错误 | 全部 `#[tauri::command]` 调用方 |
| 文件 IO | 每次 `write_chunk`/`close_file`/`abort_file`/`resolve_save_path` + 字节 + 耗时 + 错误 | Rust `diagnostics` 捕获（§3） |

**脱敏**：URL 中 presigned token、`Authorization`、`passphrase`、SDP 内候选 IP 仅留 `type/protocol/port`，不落明文密钥。

### 1.7 分层深度埋点（网络层 / 协商协议 / WebSocket / 收发端 / 卡死 / 代理）

#### 1.7.1 网络层（network，全部三链路共用）

- **DNS**：`host→IP` 解析、耗时、所用 resolver、失败(含 NXDOMAIN/超时)。
- **TCP/TLS**：connect RTT、TLS 握手耗时、cipher、`alpn`、SNI、**证书有效期(本地时间 vs `notAfter`，排除时钟偏移)**。
- **代理（见 §1.7.7）**：每请求是否走系统代理 + 地址 + 是否被改写响应。
- **STUN/TURN**：binding req/resp + `mapped address` + **NAT 类型推断**(open/symmetric/...)、TURN allocation(transport `udp/tcp/tls`) + 中继地址 + refresh 周期。
- **连接质量**：RTT 采样、丢包估算(WebRTC `getStats`)、带宽估算、重传次数；**ICE restart** 触发与结果。
- **超时**：每 socket 读/写超时配置值与实际触发点。

#### 1.7.2 协商协议（negotiation，p2p 为主）

- **SDP 全量**：offer/answer **完整 SDP 进 crash 快照 + 内存 ring**(脱敏候选 IP 仅留 type/protocol/port)；记录 `createOffer`/`setLocalDescription`/`setRemoteDescription`/`createAnswer` 各自时间戳。
- **ICE candidate**：全集(每个 candidate 的 `type=host/srflx/relay`、`protocol=udp/tcp`、`port`)、配对过程(`pair formed`/`nominated`/`selected`)、**选中理由**(优先级/可达性)。
- **信令往返**：每条 signal 的发起方/接收方/时间戳/是否回声/relay 是否缓冲到(对方离线时)。
- **协商超时**：`createOffer→answer` 阈值、`ICE 收敛`(connected)阈值，超阈标红。

#### 1.7.3 WebSocket 具体点（https 本地直传）

- **连接尝试**：URL、subprotocol、握手耗时、失败码(`100x`/`101`/网络错)。
- **控制帧**：`open`/`close(code+reason)`/`ping`/`pong`/`error` 全记。
- **每条 app 消息**：`type`(offer/answer/candidate/recv-ready/pull/segend/recv-done/frame)、`size`、**发送与接收时间戳**、ack 状态。
- **段序号**：每条 `frame` 的 `segIndex`/`offset`，**乱序检测**(期望 vs 实际)。

#### 1.7.4 传输层 — 发送端（sender）

- **块调度**：窗口(24MB)占用/释放、背压、3 路并发哪路空闲/阻塞(`pumpPool:567`)。
- **重试/降档**：每次重发原因(网络/看门狗/ACK 丢失)、退避时长、**降档 32→24→16 决策**(`TIERS:33`)。
- **吞吐采样**：每 N 秒速率，与稳定态(5.0MB/s)对比，振荡区间记录。
- **中止原因**：`reason=cancel|crash|peer-left|timeout|space` 明确标注(`sender.ts:88` 起)。

#### 1.7.5 传输层 — 接收端（receiver）

- **缓冲**：接收缓冲填充/排空速率、**乱序队列深度**、哪些块乱序到达(`receiver.ts:393`/`drainWrites`)。
- **保序写盘**：期望序号 vs 实际、`sink.write` 节奏、`dec.flush` 时机、`sink.close` 时机(`receiver.ts:401`)。
- **完整性**：per-frame HMAC(`stream-download.ts:124/155`) + **全文件 hash 进度**(§1.5 #4)。
- **卡死**：期望字节 vs 实际到达，**时间窗无增长=卡**(`stream-download.ts:67` 看门狗)。

#### 1.7.6 卡死检测矩阵（stuck，每链路 per-phase 超时）

| 链路 | 超时检查点 | 阈值(初值, 可配) | 日志动作 |
|------|-----------|------------------|----------|
| tus | presign 超时 / PUT 看门狗 / commit 超时 / HEAD 复核超时 | 55s(`headOffset:92`) | 标红"卡在 X" |
| https | 控制 WS 连不上 / offer→answer / ready 闸门(8×15s) / 推流窗口无进展 / close 超时 | 见 `sender.ts:346` | 标红"卡在 X" |
| p2p | createOffer→answer / ICE 收敛 / DC open / 数据首字节 / 无进度看门狗 | 见 `peer.ts` | 标红"卡在 X" |
| 通用 | web↔native 心跳丢失 / 主线程长任务阻塞 | 心跳 5s / 长任务 1s | 标红 + 最后已知状态 |

每条超时 → `log('error','watchdog', '卡在 {环节}，已 {Y}s 无进展', {traceId})`，并写进 crash 快照的"最后 N 条"。

#### 1.7.7 代理（proxy）专项

- **启动读取系统代理**：pac/http/https/socks 配置，记录每条传输是否受其影响。
- **按域名命中**：relay 域名 / STUN / WebSocket 是否命中代理；命中后 **CONNECT 隧道建立(HTTPS over proxy)** 成功与否。
- **TLS 拦截**：代理返回的证书 CA 非预期 → 记录"疑似代理中间人"。
- **绕过开关**：提供"强制直连/绕过代理"开关，记其生效与每请求实际路径。
- 与 §1.7.1 网络层呼应：代理导致的连接失败必须能区分"真断网" vs "代理拦了"。

**落点**：§1.6 全量请求埋点 + §1.7 分层深度埋点在 **Phase 1（采集）** 一并落地，作为收发两端环节清单(§1.2/§1.3)的"请求级下钻"——环节表管"到没到这一步"，本节省"这一步内部请求全貌"。Phase 4 故障注入须能逐请求回放。

### 1.8 诊断系统自身可靠性与开销治理（hardening，Phase 1 一并落地）

> 用户确认：主体已覆盖，剩**可靠性 / 开销 / 反馈闭环**三类 hardening，"能加就加"。本节立规，确保日志系统自己不崩、不干扰被测对象、能把日志拿回来。

**A. 日志系统自身可靠性（meta）**
- **自监控**：文件写失败 / 权限拒 / 只读 FS → 记到 `stderr` + 备选 sink（内存紧急缓冲），打 `tag=diag-self` 标红，**绝不静默丢**。
- **RingBuffer 溢出计数**：每条日志带出 `dropped=N`，便于判断日志是否完整。
- **写盘异常不阻塞业务**：写盘失败被 `catch`，主流程不受影响。

**B. 日志开销预算（不干扰被测对象）**
- **分级写入**：关键/低频事件（环节里程碑、错误、崩溃）**同步**落盘；高频事件（每帧 / 每 chunk / 每 WS 消息）**异步批写**（攒批 + 定时 flush，如 200ms 一批），避免同步 IO 拖慢 5MB/s 传输。
- **开销上限**：单传输诊断写入 CPU 占比目标 `<1%`，超则降采样。

**C. 高频事件采样 / verbosity 分级**
- **三级 verbosity**：`error`(仅错误+崩溃) / `info`(默认，环节里程碑+关键请求) / `debug`(全量逐请求+逐帧)。
- 长传等高频场景 `debug` **自动采样**（如每 50 帧记 1 帧），防 10MB 上限被秒爆、吞历史。
- 切换入口：调试开关 / 单次会话"详记"按钮。

**D. 用户→开发者一键反馈通道（排查闭环）**
- 导出包 = 按天日志 + `crash-*.json` + 环境指纹；新增"**分享给开发者**"：脱敏后（文件名/房间码/IP 仅留哈希/前缀）经 relay 或系统分享上传，生成回执 ID，闭环最后一公里。

**E. 服务端关联 ID 回显（跨服务端对齐，需改 conduit）**
- 请求带 `X-Trace-Id: {traceId}`；relay/Worker/R2 响应头 echo 同一 ID → 云端日志可对齐（属云端侧，Phase 1 提需求，实施随 conduit 排期）。

**F. Android 常开开销双模**
- **常开轻量**：仅 error + 环节里程碑 + 崩溃（系统级 always-on，电量/IO 代价低）。
- **按需详记**：单次会话开 verbose（全量请求+逐帧），会话结束自动回轻量。
- 默认轻量常开，详记由用户/调试开关触发。

**次要 hardening（维护期可补）**：PII 脱敏范围扩展(文件名/房间码/IP)、日志检索索引、崩溃快照大小上限(`crash-*.json` 封顶 2MB)、故障注入测试台(chaos：丢包代理 / Worker 返 500 / 磁盘满模拟，证明"都抓到了")。

## 2. 采集层 A — Web 统一日志器

- 新建模块 `src/diagnostics/`（符合 §1.2 小模块化，新功能开独立文件夹承载）：
  - `logger.ts`：核心 `log(level, channel, scope, msg, data)`，level ∈ `trace|debug|info|warn|error`，channel ∈ `tus|https|p2p|core`。
  - `store.ts`：内存 RingBuffer（上限 2000 条，超出丢弃最旧）、按 `traceId` 聚合、订阅接口供 UI 实时读。
  - `trace.ts`：`newTrace(scope)` 生成 `traceId`，提供 `withTrace(fn)` 上下文。
- **改造（只换日志出口，不动业务逻辑）**：上面 §0 列出的 10 个文件里约 36 处 `console.*` 改为 `log(...)`，保留 `console` 镜像但统一经 logger 一次出口。
- 落盘转发：传输关键节点（开始/分片落盘/校验/完成/失败）额外调 `diagnostics_capture` 写进原生持久化日志，保证前端热更新也不丢。
- **全局捕获（系统级关键，不漏网）**：`src/diagnostics/install.ts` 在 `main.ts` 启动早期注册 `window.onerror` / `unhandledrejection` → 统一 `log('error','global',...)`；挂 Vue `app.config.errorHandler` + 组件 `onErrorCaptured` 接入。任何未处理异常都进日志，不依赖业务主动埋点。

## 3. 采集层 B — Rust 原生日志

- 新建文件夹模块 `src-tauri/src/diagnostics/`（模范 `lan_transfer/`）：
  - `mod.rs`：只 `pub mod` 登记 + 必要 `pub use`，**禁写业务**。
  - `logger.rs`：结构化日志 + 分级 + `traceId` 关联；`init()` 内 `std::panic::set_hook` 捕获 panic 全量落盘（系统级崩溃可见）。
  - `store.rs`：内存 RingBuffer + 文件持久化。落盘到**日志目录** `log/`（Windows 安装根目录 / Android `app_data_dir/files/logs`），按天滚动 `arkpulse-YYYY-MM-DD.log`，**仅保留最近 7 天，超期自动覆盖（删除最旧）**。
  - `commands.rs`：`#[tauri::command]` 薄胶水。
- 捕获 web 层看不到的事件：`write_chunk`/`close_file`/`abort_file`/`resolve_save_path` 成败、字节数、耗时、目录解析、权限、Android SAF、native 网络/TLS 错误。

### 3.1 存储位置与 7 天留存策略（对应你的要求）

**专属软件文件夹（安装时创建，安装根目录下）**
- **Windows 桌面**：在**安装目录新建文件夹 `log`**（如 `安装路径/log/`），日志落 `安装路径/log/arkpulse-YYYY-MM-DD.log` 与 `crash-*.json`。运行时若目录缺失自动创建（按 `current_exe` 推导安装根，复用现有路径解析逻辑，不另起一套）。
- **Android**：应用私有外部存储 `Android/data/<包名>/files/logs/`（免权限、零新权限，崩溃可经 App 内导出取回；系统文件管理器在 Android 11+ 对 `Android/data` 受限，故分享走下方导出 ZIP），首启动确保目录存在（复用现有 `path_resolver` 逻辑）。
- 不塞进 `AppData`/系统缓存深处——保证用户「找得到、导得出」。

**7 天滚动覆盖**
- 按天滚动文件：`arkpulse-YYYY-MM-DD.log`，每天一个。
- 启动初始化 + 每次写入前检查：删除修改时间超过 **7 天**的旧文件（>7 天即「自动覆盖」，最长保留 7 份当天文件）。
- 单文件不强制大小上限（诊断日志量可控），但若单日异常暴涨可叠加「单文件 ≥ 10MB 截断新开」兜底，避免单文件过大。

**导出位置（复用已有逻辑，自动落到下载，不弹选择器）**
- 导出**不弹文件选择器**：直接**复用现有导出/下载逻辑**与**现有 `mediastore_insert` 权限**，把 ZIP 落到系统**下载目录**；文件名 `arkpulse-diagnostics-时间戳.zip`。
  - **Windows**：系统 `Downloads/`（经 Rust `download_dir`）。
  - **Android**：经 `mediastore_insert` 落 `Download/ArkPulse/log/`（复用用户文件保存的同一条 MediaStore 链路与权限，零新权限；相对路径显式传 `Download/ArkPulse/log`）。
- 导出命令 `diagnostics_export {share?:boolean}` 返回**绝对路径**；UI 用 `DiagToast` 在底部浮起玻璃提示条，显示完整保存路径（见 §5），让用户明确知道文件落在哪、能从下载取到。
- 仅当用户主动点「分享」时，才触发系统分享/SAF（Android）或桌面 `share`，不作为导出默认动作。

### 3.2 崩溃可恢复性与崩溃快照（对应「闪退也能从文件夹直接拿出崩溃原因」）

**核心铁律：日志即时落盘，不靠内存**
- 每条日志事件**立即 append 到文件**（`fs` 同步写，非异步缓冲、非仅内存 RingBuffer）。内存 RingBuffer 仅服务 UI 实时展示；**文件才是崩溃可恢复的来源**。
- Rust `panic_hook` 在 panic 时**同步**把回溯(stack trace)+ 上下文写进文件再退出——panic 不丢尾。
- 最早初始化：Rust 在 `setup`/`main` 第一行就装好日志与 `panic_hook`，**早于任何业务代码**；Web 侧 `install.ts` 在 `main.ts` 最前注册 `onerror`——即便初始化阶段闪退也有日志可追溯。

**崩溃快照（越具体越好，你点名要的）**
崩溃时除堆栈外，额外写一份结构化 `crash-YYYYMMDD-HHMMSS.json` 报告，内含：
- **系统**：OS/版本、App 版本、设备型号、架构、时间戳(UTC+时区)、内存占用、线程。
- **活跃传输清单**：每个 `traceId` → 文件名/大小/进度/已传字节/起止时间/结果状态。
- **所用线路与协商**（你点名的核心）：
  - 链路类型：tus 中转 / https 本地直传 / p2p WebRTC。
  - 协商内容 + 时间：p2p 的 SDP offer/answer、交换的 ICE candidate、STUN/TURN 可达性、signaling 报文与各自时间戳；tus 的 upload URL/offset/endpoint；https 的 relay 地址。
  - 经过的链路：是否走中转(relay 不落盘)/直连/打洞成功与否。
- **软件内部状态**：崩溃前最后 N 条事件（从文件尾回读）、当前激活模块、最后心跳时间、看门狗是否曾告警。

**干净退出标记 + 下次启动识别崩溃**
- 启动写 `session.lock`（pid/启动时间/状态=running）；干净退出置 `closed=ok`。
- 下次启动若发现上会话 `!= ok`（无干净退出标记 / lock 残留）→ 底部长条变红、主页健康条标红「检测到上次崩溃」，直接链到 `crash-*.json`。

**硬崩溃边界（必须讲清，hook 抓不到的部分）**
- **WebView/渲染进程崩溃**：JS 引擎直接挂，`onerror` 不再触发。兜底：原生侧心跳(web→native 周期 ping)，超时未达 → 原生记「webview 失活/疑似崩溃」+ 最后已知状态。
- **原生硬崩(segfault / abort / OOM kill)**：`panic_hook` 不覆盖。兜底：① 结构化逐步日志让「最后成功行」暴露死亡点；② 可选 `human-panic` 写 panic 报告；③ 系统级：Windows WER/minidump、Android tombstone+logcat（系统层、不在应用日志内，但指引用户去取）。
- 详见 §9 已知限制。
- 新增 Tauri 命令（IPC 薄胶水）：
  - `diagnostics_capture(level, channel, scope, msg, data, trace_id)`
  - `diagnostics_query(filter)` → 返回过滤后的日志
  - `diagnostics_export()` → 导出/分享当前日志文件
  - `diagnostics_clear()`
- `lib.rs` 改动（符合 §1.1）：仅加 `mod diagnostics;` 一行挂载 + `invoke_handler!` 注册上述 4 命令。

### 3.3 只在应用层（不上网站）+ 手机/电脑逻辑区分（注入标签）

**应用层专属，不进托管前端**
- 诊断 UI 与采集**只在 Tauri 应用内**（Windows 桌面 + Android），**不进托管网站 `flashdrop.pages.dev` 的远程前端**。
- 因此不存在「远程前端白名单」问题：诊断命令跑在应用内嵌 webview，与壳同源，`capabilities` 无需增量加远程 URL；壳 `tauri.conf.json` 的 source URL 仍是 `flashdrop.pages.dev`，但诊断模块随壳打包、本地调用。
- 远程前端若日后需要只读展示，另议；本期范围是应用内看板 + 导出 ZIP。

**平台注入标签（手机 vs 电脑，逻辑分流依据）**
- 启动时由壳**注入平台标签**到日志上下文与运行时开关，所有平台相关逻辑据此分支，不靠 UA 嗅探：
  - 注入点：Rust `setup` 阶段写入全局（桌面 `std::env::consts::OS == "windows"` / 安卓 `target_os="android"`），前端经 `diagnostics_init` 命令或 `window.__ARKPULSE_PLATFORM__` 注入标签 `platform: 'windows' | 'android'`，并随每条 `LogEntry` 带 `platform` 字段（便于按端检索）。
  - 复用现有 `isTauri()` 判定（桌面壳），再叠加 `platform` 标签区分 Windows / Android——`isTauri()` 只回答「是不是桌面壳」，平台标签回答「哪个端」。
- **按标签分流的逻辑点**：
  - **采集器**：两端采集器实现不同，必须各自照顾到——`platform='windows'` 走**电脑采集器**、`platform='android'` 走**手机采集器**，各自抓本端独有事件（Windows: WER/minidump 关联、壳 IO；Android: Doze/后台杀 `tag=bg`、SAF/前台保活），保证两端日志都完整，不漏一端。
  - **存储路径**：Windows → 安装目录 `log/`（如 `安装路径/log/arkpulse-YYYY-MM-DD.log`）；Android → `Android/data/<包名>/files/logs/`（私有、免权限）。落盘前用标签选根，**复用现有 `path_resolver` 逻辑**。
  - **导出/分享**：**复用现有导出/下载逻辑**，自动落系统下载目录（Windows `Downloads/`、Android 公共下载/分享）；不弹文件夹选择器。
  - **崩溃兜底**：Android 独有 → Doze/后台被杀 (`tag=bg`)、前台服务保活心跳；Windows 独有 → WER/minidump 指引。
  - **常开开销**：Android 走「常开轻量 + 按需详记」双模（省电）；Windows 常开详记代价低，默认全量。
  - **UI 不读 platform 标签**：平台标签**只给底层逻辑用**（采集器/存储/分享/导出/崩溃兜底），**不驱动 UI**。UI 走纯**响应式**（按视口尺寸：宽屏居中悬浮、窄屏近全宽），同一套组件自适应大屏与小屏，不写两套、不按标签分 UI。
- **故障注入也要分流**：Phase 4 在两端分别跑（Android 后台杀进程验证 `tag=bg`；Windows 模拟落盘失败/网络断），确保两端日志都能抓全。

## 4. 桥接 — traceId 串联双端

- Web → Rust：`diagnostics_capture` 把关键节点写进原生持久化（双端都落盘）。
- Rust → Web：原生关键节点（落盘字节、IO 错误）经事件流回传前端，悬浮窗实时显示。
- 统一 `traceId`：Web 生成、command 上下文带入 Rust，Rust 落盘带同一 `traceId` → 双端同 bug 全流程一条线。

## 5. UI 层（Vue，毛玻璃，窗口级悬浮，符合 §1.1）

**形态（对应你的原话）**：诊断 UI 是**窗口级**的——浮在所有内容正上方，不挤进现有 `send|receive|manage` 三个 Tab。底部一条**圆形长条**（玻璃丸胶囊），左侧「主页」、右侧「更多」，点击任一侧，上方浮起一块**玻璃体**显示对应页面；主页/更多就是这两个玻璃页面的切换。

- **窗口级悬浮外壳** `components/diagnostics/DiagShell.vue`：
  - 挂在 `App.vue` 根（与 `router-view` 同级），`position: fixed` 全窗口覆盖，自身 `pointer-events: none`，内部玻璃体/长条 `pointer-events: auto` → 不挡主界面交互。
  - 底部**圆形长条** `DiagDock.vue`：胶囊形（`border-radius: 999px`）+ 毛玻璃，左「主页」右「更多」，当前项高亮；点击切换。
    - **主页** = 程序**真实主界面**（现有 `send|receive|manage`，诊断内容**不进主页**，只把底部长条挂在这里）。
    - **更多** = 唤起上方诊断玻璃体（全部诊断内容只在此页）。
  - 上方**诊断玻璃体** `DiagGlass.vue`：`backdrop-filter: blur(14px)` + 半透明 + 圆角（延续 `App.vue` 玻璃美学，低反差浅色），**仅在「更多」内显示**，可整体收起为长条（只留底部条）；**单页、无设置项**。
- **视觉基调（你定的）**：整体**低反差、浅色通透**；主色用**青蓝（泰普蓝）**而非深紫；玻璃面板半透明白 + 细边；按钮为**透明玻璃质感**（`background: rgba(255,255,255,.5)` + 细边 + `backdrop-filter`），点击/悬停有**缩放动效**（`transform: scale(1.03)` / 按下 `scale(.97)`，配 `cubic-bezier` 过渡）。
- **「更多」诊断玻璃页（诊断全貌，唯一页面）**：
  - **顶部健康总览条** `DiagHealthBar.vue`：错误/警告计数 + 各子系统状态灯（异常 error 红 / 警告 warn 黄 / 正常 ok 绿），一眼看全软件健康；点状态灯下钻到对应日志。
  - **实时日志流** `DiagLogStream.vue`：滚动、关键字过滤、按 level/channel 染色（error 红、warn 黄、info 灰、ok 绿）。
  - **会话列表** `DiagSessionList.vue`：按 `traceId` 聚合每次传输（链路 / 起止时间 / 文件数·字节 / 结果 / 耗时 / 错误）；点开看单会话时间线 `DiagTimeline.vue`（连接 → 协商 → 分片 → 落盘 → 校验 → 完成/失败）。
  - **「打包 ZIP 导出」按钮**（青蓝玻璃主操作，带缩放动效）：→ `diagnostics_export {share?:boolean}`，**不弹文件选择器**，**复用现有导出/下载逻辑**自动落系统下载目录，把按天日志（`安装目录/log/` 或 `Android/data/<包名>/files/log/`）+ `crash-*.json` 打包成 `arkpulse-diagnostics-时间戳.zip`，返回绝对路径。
  - **保存位置提示条** `DiagToast.vue`（核心反馈，对齐你给的参考图）：导出成功后底部浮起玻璃质感提示条（半模糊 + 圆角 + 上滑动效），左侧应用图标 + 「已保存」+ **完整保存路径**（如 `下载/arkpulse-diagnostics-20260818-1932.zip`），自动消失也可手动关；一眼知道落在哪、能直接去取。
  - **「分享」**（可选，非默认）：仅用户主动点才触发系统分享/分享开发者（脱敏后回执，§1.8）。
  - **无设置项**：默认保留日志，详细级别 / 7 天覆盖 / 崩溃快照 / 清空等开关**一律移除**，保持「看板 + 看日志 + 导出 ZIP」三件事。
- **always-on 但低调**：采集始终在底层跑（系统级）；玻璃 UI 默认收起为底部长条，异常时长条变红 + 健康条标红「检测到上次崩溃」并直链 `crash-*.json`，不打扰但随时可取。

## 6. 与死纪律对齐

| 条款 | 落实 |
|------|------|
| §1.1 分层 | 逻辑下沉 `.ts`（`src/diagnostics/`），原生下沉 Rust（`src-tauri/src/diagnostics/`）；UI 仅 Vue |
| §1.2 目录 | 新功能用文件夹模块承载，`mod.rs` 只登记、业务落兄弟 `.rs`，`lib.rs` 一行挂载 |
| §1.4 远程白名单 | 若诊断 UI 走远程前端热更新，`capabilities/*.json` 增量加 `diagnostics_capture/query/export/clear` 命令标识 |
| §0 闸门 | 改动后：前端 `npm run build` + Rust 四步（fmt/check/clippy -D warnings/test）+ 安卓交叉编译全绿，**再**真实功能测试（双端真实传文件 + 故障注入：落盘失败/网络断）验证日志抓全，零问题才算通过 |

## 7. Flutter 冲突警示（需你拍板 ⚠️）

**现状**：壳 = Tauri，webview 渲染 **Vue**。`§1.1 死纪律`规定 **Vue 为唯一框架层**，引入 Flutter = 第二个 UI 框架，直接冲突。

若坚持 Flutter，只有两条重路：
1. **独立 Flutter 进程 + 原生桥**：Tauri 旁挂 Flutter Activity/Window，双运行时并存，IPC 复杂、包体暴涨、违反「壳层原生业务留在 Rust」原则。
2. **Flutter 替换 webview**：等于重做整个前端，不属「原生 app 内部加功能」，而是重写。

**建议**：诊断 UI 用 **Vue**（复用现有玻璃美学、零新增框架、符合 §1.1）。除非你明确要 Flutter，我再评估方案②代价。你说的「已经安装了」我理解为 Flutter SDK 已装，但本架构用不上——先确认是否真要引入。

> **已决（2026-08-18）**：用户确认用 Vue（"使用Vue"），Flutter 作废。UI 全部按 Vue 推进，本条关闭。

## 8. 实施步骤（分阶段，每阶段过 §0 闸门）

- **Phase 1 采集 + 全局捕获 + 存储落地**：Web `src/diagnostics/logger.ts` + `install.ts` 全局捕获（onerror/unhandledrejection/Vue errorHandler）+ 36 处 `console.*` 改造；Rust `diagnostics/` 模块 + `panic_hook` + 4 命令 + 日志目录 `log/`（安装根/Android files）创建 + 7 天滚动清理 + `lib.rs` 一行挂载。
- **Phase 2 桥接**：`traceId` 生成与跨端传递；`diagnostics_capture` 接通；原生事件回传。
- **Phase 3 UI**：窗口级悬浮玻璃 `DiagShell` + 底部圆形长条 `DiagDock`（主页=真实程序主页 / 更多=诊断玻璃）+ 诊断单页（健康总览 + 日志流 + 会话时间线 + ZIP 导出 + 保存提示条，无设置项），挂在 `App.vue` 根。
- **Phase 4 真实测试**：双端真实传文件 + 故障注入（落盘失败/网络断），验证日志抓全、时间线正确、导出可用，零问题才算通过。

## 9. 风险与未决

- **Flutter 决策**（§7）：**已决**——用户确认用 Vue，Flutter 作废（2026-08-18），本条关闭。
- **性能**：RingBuffer 上限（内存 2000 条）需在 Phase 1 定死；留存已定为 7 天滚动覆盖，避免移动端内存/IO 压力。
- **硬崩溃边界**（§3.2）：segfault / OOM / webview 崩溃 `panic_hook` 抓不全，依赖「最后日志行」反推 + 系统机制(WER/tombstone)；Phase 1 须定死「早初始化顺序」与「web↔native 心跳」两项兜底。
- **崩溃快照字段**：协商内容(SDP/ICE/信令)的采集点须对齐现有 `p2p/{peer,ice,signaling}.ts` 改造，确保 `crash-*.json` 里线路/协商/链路三段不空。
- **远程白名单**：若诊断走远程前端，需同步 `capabilities` 命令标识（§1.4）。
- **排查盲区已补全**：原「盲了就抓瞎」的 14 项(§1.5) + 全量请求埋点铁规(§1.6) + 分层深度埋点(§1.7：网络层/协商协议/WebSocket/收发端/卡死矩阵/代理专项) 均已立为 Phase 1 落地项；Phase 4 故障注入须能**逐请求回放**。
- **诊断系统自身 hardening 已立规**(§1.8)：日志自可靠(meta自监控/溢出计数/不阻塞业务)、开销预算(分级同步/异步批写/CPU<1%)、verbosity 三级+高频采样、用户→开发者一键反馈闭环、服务端 `X-Trace-Id` 回显(需改 conduit)、Android 常开轻量+按需详记双模。主体方案已无功能盲区。
- **UI 形态已定**(§5/§10.4)：窗口级悬浮玻璃 + 底部圆形长条（主页=程序真实主页 / 更多=诊断玻璃单页）；诊断只在「更多」，不进主页、不新增 Tab、无设置项，仅看板+看日志+导出 ZIP。

## 10. 实施文件结构（代码落点，待确认）

### 10.1 现状事实（已读实际代码）
- Web 特性逻辑按功能建文件夹：`src/transfer/`、`src/p2p/`、`src/https/`、`src/composables/`；视图 `src/views/`；组件扁平 `src/components/`；Rust `lib.rs` 用 `mod xxx;` 登记 + `generate_handler!` 注册命令。
- `App.vue` 实际 `TabType = 'send' | 'receive' | 'manage'`（**仅 3 个，无「主页/更多」**）——与你描述的导航不一致，见 §10.4。
- 现有无 `src/diagnostics`。

### 10.2 新增文件树
```
src/
├── diagnostics/                # 新增 Web 特性逻辑（对齐 transfer/p2p/https 建文件夹惯例）
│   ├── logger.ts               # 核心 log(level,channel,scope,msg,data) + 分级
│   ├── store.ts                # 内存 RingBuffer(2000) + traceId 聚合 + 订阅接口
│   ├── trace.ts                # newTrace/withTrace → traceId
│   ├── install.ts              # 全局捕获(onerror/unhandledrejection/Vue errorHandler)，main.ts 最前调用
│   └── types.ts                # LogEntry / DiagFilter / CrashSnapshot 类型
├── tauri/
│   └── diagnostics.ts          # 封装 invoke(diagnostics_capture/query/export/clear)
└── components/
    └── diagnostics/            # 窗口级悬浮玻璃 UI（挂在 App.vue 根，不进 send/receive/manage Tab；诊断只出现在「更多」）
        ├── DiagShell.vue        # 窗口级外壳：fixed 覆盖、pointer-events 隔离、整体收起/展开
        ├── DiagDock.vue         # 底部圆形长条：主页(左,真实程序主页)/更多(右,唤起诊断玻璃)
        ├── DiagGlass.vue        # 上方诊断玻璃体（仅「更多」内，单页无设置）
        ├── DiagToast.vue        # 保存位置提示条（导出后底部浮起，显示完整路径+上滑动效）
        ├── DiagHealthBar.vue    # 健康总览条（错误/警告/子系统状态灯）
        ├── DiagLogStream.vue    # 实时日志流（过滤+染色）
        ├── DiagSessionList.vue  # 会话列表（traceId 聚合）
        └── DiagTimeline.vue     # 单会话时间线（连接→协商→分片→落盘→校验→完成/失败）

src-tauri/src/
└── diagnostics/                # 新增 Rust 模块（对齐 lan_transfer/ 模范）
    ├── mod.rs                  # 只登记 pub mod，禁写业务
    ├── logger.rs               # 结构化日志 + 分级 + traceId + panic_hook
    ├── store.rs                # RingBuffer + 文件持久化(安装根/log/ 或 Android files/logs/，7天滚动)
    ├── commands.rs             # #[tauri::command] 薄胶水 ×4
    └── panic_hook.rs           # set_hook 同步写回溯（或并入 logger.rs）
lib.rs: 加 `mod diagnostics;` + generate_handler! 内加 4 命令名
```

### 10.3 注册点（必改，否则不编译/不生效）
- **Web**：Vite 无需注册，仅 `import`；`main.ts` 最前 `import './diagnostics/install'` 并调用初始化；`App.vue` 根加 `<DiagShell />`（与 `router-view` 同级，窗口级悬浮）。
- **Rust**：`lib.rs` 加 `mod diagnostics;`（对齐 `mod boot/commands/files/splash/state`）+ `generate_handler!` 内追加 `diagnostics_capture, diagnostics_query, diagnostics_export, diagnostics_export_android, diagnostics_clear`。

### 10.4 已确认决策（按你最新 UI 描述）
- **UI 形态**：**窗口级悬浮玻璃** + 底部**圆形长条**（主页左 = 程序真实主页 / 更多右 = 诊断玻璃）。诊断内容**只在「更多」单页**，不进主页、不新增 Tab；现有 `send|receive|manage` 导航零改动。
- **挂载点**：`DiagShell.vue` 挂在 `App.vue` 根，浮于所有内容上方（`pointer-events` 隔离，不挡主界面）。
- **ZIP 导出**：`diagnostics_export`（Windows 落 `Downloads/`）/ `diagnostics_export_android`（返回 base64，Web 经 `mediastore_insert` 落 `Download/ArkPulse/log/`）打包按天日志 + `crash-*.json` → 系统**下载目录** `arkpulse-diagnostics-时间戳.zip`，并触发系统分享/分发。
- **UI 组件位置**：`src/components/diagnostics/` 子目录（9 组件），避免污染扁平 `components/`。

## 11. 实施进度（2026-08-18）

**Phase 1 + 三链路插桩已全部落地，Web/Rust 双端构建通过。**

- Web 采集层：`src/diagnostics/{types,logger,trace,store,install,observe}.ts` + `src/tauri/diagnostics.ts`，`main.ts` 最前 `installDiagnostics`，`App.vue` 挂 `DiagShell`。
- 全量请求埋点：`observe.ts` 全局包裹 `fetch`/`WebSocket`/`RTCPeerConnection`（脱敏 + 带 traceId），覆盖 tus 预签名/R2/relay、https 控制+GET、p2p 协商全链路。
- 三链路 stage 日志：`useTusUpload.ts`(创建记录/看门狗降档/完成/失败)、`sender.ts`+`receiver.ts`(房间/段/连接/清单/落盘/取消/失败)、`peer.ts`(建连/offer/answer/connected/failed/重连)。
- Rust：`src-tauri/src/diagnostics/{mod,logger,store,commands,panic_hook}.rs`（按天落盘 + 7天清理 + 同步 flush + panic 兜底 + ZIP 导出），`lib.rs` 挂载 + 4 命令 + `setup` 内 `store::init` 与 `panic_hook::install`。
- 路径：`windows` → 安装目录 `log/`；`android` → `app_data_dir/files/logs/`（7 天日志私有存放）；导出 → Windows `download_dir`、Android 复用 `mediastore_insert` 落 `Download/ArkPulse/log/`（零新权限）。
- UI：`src/components/diagnostics/` 8 组件（DiagShell/DiagDock/DiagGlass/DiagHealthBar/DiagLogStream/DiagSessionList/DiagTimeline/DiagToast），青蓝玻璃低反差 + 按钮缩放动效。
- 待办（未做，属后续轮）：①故障注入 E2E 门禁（§8 Phase 4）逐环节回放验证；②`__e2eeSalt` 等个别非空断言按实参；③动态/静态 import 警告清理（无功能影响）。
