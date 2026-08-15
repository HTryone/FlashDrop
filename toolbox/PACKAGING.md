# 闪传 FlashDrop 打包规范

> 本文件是打包的**唯一权威规范**。改动打包流程前先读这里。
> 配套记忆：`D:\arkpulse\.workbuddy\memory\MEMORY.md` 的「Rust 开发工作流铁律」「Tauri 桌面端」两节。

## 0. 一句话

打包 = 出**双产物**：桌面 NSIS 安装包 + 安卓 APK/AAB（**仅 64 位**）。由 `toolbox/build-all.mjs` 编排。**任何 Rust 改动必须先过四步验证，再跑完整构建。**

## 1. 命令

| 场景 | 命令 |
|------|------|
| 双端（默认） | `node toolbox/build-all.mjs` |
| 仅桌面 | `node toolbox/build-all.mjs --windows` |
| 仅安卓 | `node toolbox/build-all.mjs --android` |
| 走本地 NSIS | `--local-nsis`（或设 `NSIS_PATH=toolbox/nsis`，默认走网络下载） |
| 跳过归集 | `--skip-copy`（产物留 `src-tauri/target/...`，不复制到 `releases/`） |
| 指定版本号 | `--version 1.2.3 [--version-code 123]` |

**不要用 `npm run tauri build` 直接打安卓**——见 §3 坑 7。桌面可用 `npm run tauri build`（脚本内 `buildWindows()` 就是这么调的）。

## 2. Rust 改动四步验证（铁律，先做）

在 `src-tauri/` 目录、前台实时跑（**不要 `| tail`**，会隐藏报错）：

1. `cargo fmt --check` —— 格式。不符则 `cargo fmt` 自动修后再 `--check` 复核。
2. `cargo check` —— 编译期校验，不产二进制。
3. `cargo clippy --all-targets -- -D warnings` —— 警告当错误，必须清零。
4. `cargo test` —— 单元检查。

任一步报错**立刻修**，不过下一步。四步过后再跑 `node toolbox/build-all.mjs`。

⚠️ **clippy 只覆盖当前编译目标**：桌面 clippy 不会触发安卓 `#[cfg(android)]` 分支里的告警（如「未使用变量」）。规避法：把目标平台专属代码缩进到对应 `cfg` 块内用句柄，避免跨端未用变量；或临时 `cargo clippy --target aarch64-linux-android` 复核安卓分支。

## 3. 踩坑清单（必读，每一条都真实发生过）

1. **中文路径乱码**：项目根目录曾用中文名（`D:\点对点传输项目`），Rust/NDK 工具链按 GBK 解析路径整片乱码。→ **根目录必须英文**。
2. **构建慢**：Rust 4 架构串行编译 + 首次补齐 SDK，一次 5–15 分钟，非卡死。别中断。
3. **`basename is not defined`**：`build-all.mjs` 用了未 `import` 的 `basename`，签名后崩。→ 改脚本先确认所有函数已 import。
4. **只打单端**：`--windows` 只出桌面，用户要双端。→ 默认 `build-all.mjs` 不加参数即双端。
5. **误杀新构建**：曾用 `Stop-Process` 按 `cargo/tauri` 名匹配，把刚启动的新构建子进程一起杀掉。→ 改完代码再启构建；中途不要按名字批量杀进程。
6. **外置架构远程 IPC 被拦**：远程页（`flashdrop.pages.dev`）调 `open_file`/`write_chunk` 被 Tauri v2 安全层默认拦掉。→ 必须在 `capabilities/*.json` 加 `"remote": {"urls":["https://flashdrop.pages.dev"]}`（铁律，换域名同步改）。
7. **安卓 ABI「只打 64 位」长期没生效**（最关键）：
   - ❌ `npm run tauri android build -t aarch64 x86_64` —— npm 把 `-t` 多值参数整个吞掉 → 默认编全部 4 架构（含 32 位 armeabi-v7a/x86）。
   - ❌ 在 gradle `rust { }` 注入 `targets = listOf("arm64-v8a","x86_64")` —— **Tauri v2 的 gradle 插件根本没有 `targets` 属性** → `Unresolved reference`。
   - ✅ **正确做法**：`node node_modules/@tauri-apps/cli/tauri.js android build -t aarch64 x86_64`（node 直跑入口，绕过 npm 吞参数）。ABI 由 CLI `-t` 决定，gradle 默认打包所有已编译的 `.so`，所以**只编译这俩 target 就只出这俩**。
   - **验证**：解包 APK 查 `lib/` 只含 `arm64-v8a` + `x86_64`，无任何 32 位（见 §6）。
8. **`lib.rs` Tauri v2 API 签名差异**：
   - `primary_monitor()` 返回 `Result`，不是 `Option` → 写成 `if let Ok(Some(m))` 不是 `if let Some(m)`。
   - `Monitor::size()` / `scale_factor()` 是**公开方法**（返回 `&PhysicalSize<u32>` / `f64`），不是字段、不是 `Result` → 调方法 `m.size()`，不要 `m.size`。
   - 改完对照 `tauri-<version>/src/` 源码确认签名再编译，别猜。
9. **`node_modules/.bin/tauri` 在 Windows 跑不了**：那是 bash 脚本，cmd 报「不是内部或外部命令」。→ 走 `npm run tauri ...`（npm 转 `.cmd`）或 `node .../tauri.js`。
10. **NDK 探测误报警告**：`findNdk` 只查 `ndk-build` 直接路径，而本机 NDK 的 `ndk-build` 在 `build/` 子目录。→ 警告不致命（gradle 靠 `ANDROID_HOME` 自己能找），但脚本要兼容 `build/ndk-build`。
11. **桌面双弹窗**：`pickSaveDir` 在 Tauri 内仍弹浏览器 FSA 框 + `makeSinks` 再弹原生框。→ Tauri 内 `pickSaveDir` 直接 `return null`，统一单框（已在 `composables/filesink.ts` 修）。

## 4. 安卓 ABI 只打 64 位（标准做法）

```
node node_modules/@tauri-apps/cli/tauri.js android build -t aarch64 x86_64
```

- `aarch64` = `arm64-v8a`（真机主流），`x86_64` = 模拟器/部分平板。不要加 `armv7`/`i686`（32 位老旧设备，明确不兼容）。
- 自签名在构建后由 `signAndroidApks()` 用 `src-tauri/keystore.env`（已 git 忽略）+ `apksigner` 完成，输出 `app-universal-release.apk`。

## 5. 桌面窗口 / 壳层

- 75% 屏居中在 `src-tauri/src/lib.rs` 的 `setup` 内，`#[cfg(not(target_os = "android"))]` 分支：
  - 取句柄用 `app.get_webview_window("main")`（在桌面 cfg 块内取，避免安卓端「未使用变量」告警）。
  - 屏幕逻辑尺寸：`monitor.scale_factor()` 和 `monitor.size()`（v2 是方法）。
- 桌面壳注入设备标识：`.initialization_script("window.__FLASHDROP_CLIENT__={kind:'windows'|'phone'}")`，远程页读此全局即知是哪端；网页端零注入自动为 `web`（见 `src/tauri/client.ts`）。
- 自定义 VS2026 路径（装 `D:\Apps\vsc\vsc2026`）需注入 env：`PATH` 加 `$vc\bin\Hostx64\x64`；`LIB` 加 MSVC lib + Windows Kits lib；`INCLUDE` 加 MSVC include + Windows Kits include（详见 MEMORY.md）。

## 6. 产物与验证

| 产物 | 路径 | 验证 |
|------|------|------|
| 桌面安装包 | `releases/FlashDrop_0.1.0_x64-setup.exe` | 双击安装、打开看窗口是否 75% 居中 |
| 安卓 APK | `releases/app-universal-release.apk` | 见下 |
| 安卓 AAB | `releases/app-universal-release.aab` | — |

**APK 仅 64 位验证（解包查 ABI）**：
```python
import zipfile, collections
z = zipfile.ZipFile('releases/app-universal-release.apk')
c = collections.Counter('/'.join(n.split('/')[:2]) for n in z.namelist() if n.startswith('lib/'))
print(dict(c))  # 应只有 arm64-v8a + x86_64
```
**签名验证**：`apksigner verify --print-certs releases/app-universal-release.apk` → `VERIFY PASSED`。

## 7. 其他项目的标准打包流程，以及我们为什么没有

**典型标准流程（别的成熟项目）**：
- 一份 CI 配置文件（`.github/workflows/build.yml` / `.gitlab-ci.yml`）。
- 触发条件：打 tag 或推特定分支 → 自动 `install → build 前端 → tauri build`（签名证书/keystore 走 **CI Secrets**，不落本地磁盘）→ 产物自动上传到 GitHub Releases / 静态托管。
- 桌面用官方 `tauri-apps/tauri-action`；纯 Web 用 `npm run build` 推 CDN；Electron 用 `electron-builder` 配置写在 `package.json`。
- 特点：**一条命令可复现、无人值守、密钥不落地、每次产物一致**。

**我们为什么没有这套**：
1. **仓库根本没有 CI 配置**（已核实：无 `.github`、无 `.gitlab-ci`、无 `.circleci`）。打包由 AI 代理手动在本地 Bash 跑 `build-all.mjs`，不是流水线。
2. **Tauri 跨端 + 一堆定制**，直接套官方 Action 要改很多：
   - 外置架构（远程加载 `flashdrop.pages.dev`）、远程 IPC capability 白名单、自定义 ABI 限制（且我们发现 gradle 注入路径不通，得用 `tauri.js` 直跑）、自定义 VS 路径、本地/网络 NSIS 双模式。
   - 不同平台要不同 runner：Windows 出 NSIS、macOS 出 dmg（需 macOS 机）、Android 需 SDK/NDK 环境。官方 Action 能省事，但我们的定制点都得逐个映射成 Action 步骤。
3. **外置架构让「打包」含义变了**：壳（Rust/配置）是「冷更新」——改了才重打；前端（传输/UI/解密）是「热更新」——推 Cloudflare 即生效，根本不用重打包。所以很多改动走部署而非打包，降低了建标准打包流水线的紧迫性。
4. **我们的 `build-all.mjs` 其实就是「事实上的标准流程」**，只是没接 CI。它编排了双端、ABI、签名、归集。缺的只是「自动触发 + 密钥托管 + 无人值守」，不是「没有规范」。

> 如果要补标准 CI：最省事是接 `tauri-apps/tauri-action`，把 keystore 放 GitHub Secrets、VS/NDK 环境用 `actions/setup-...` 注入。但需你决定：要不要公开仓库、要不要 macOS runner（出 dmg）、密钥怎么托管。这一步需你授权再做。

## 8. 提交纪律

- 打包相关改动（如 `build-all.mjs`、`lib.rs`、`tauri.conf.json`）commit 后，本项目按授权**自动 `git push origin main`**。
- `src-tauri/target/`、`src-tauri/gen/` 已 git 忽略，绝不入库；`Cargo.lock` 二进制应用应提交。
