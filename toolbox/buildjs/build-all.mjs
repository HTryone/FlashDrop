#!/usr/bin/env node
/**
 * ArkPulse 统一打包脚本（唯一入口，头部注释即权威规范）。
 * 只做「参数解析 + 主流程编排」；具体逻辑拆到 toolbox/buildjs/ 各模块：
 *   common.mjs   基础能力（项目根、平台判定、彩色日志、shell 执行）
 *   env.mjs      Android/Java/VS 工具链探测
 *   version.mjs  版本号处理
 *   clean.mjs    构建前清理旧安装包
 *   windows.mjs  桌面端（Windows NSIS / macOS dmg）构建
 *   android.mjs  安卓全链路（gen 校准 / 64 位构建 / APK 自签名）
 * 默认全量双端（Windows+Android）；--windows/--android/--macos 只构建指定平台。产物归集 releases/。
 *
 * 铁律：唯一打包命令是 `node toolbox/build-all.mjs`，禁止直调 npm run tauri / tauri.js / gradle / cargo build（绕开会丢 JAVA_HOME/签名/归集并假错）。
 * 用法（开关可组合）：
 *   node toolbox/build-all.mjs                              双端全量
 *   node toolbox/build-all.mjs --windows|--android|--macos  单平台
 *   node toolbox/build-all.mjs --no-android                跳过 Android
 *   node toolbox/build-all.mjs --local-nsis                Windows 走本地 toolbox/nsis（默认网络下载）
 *   node toolbox/build-all.mjs --skip-copy                 不归集 releases/
 *   node toolbox/build-all.mjs --version 1.2.3              同步 tauri.conf.json + package.json 版本再打包
 *   node toolbox/build-all.mjs --version 1.2.3 --version-code 12345   显式锁 Android versionCode（省略则按 semver 自动递增）
 *
 * 本机环境固定位置（脚本自动探测命中，无需 export；ANDROID_HOME/NDK_HOME/NSIS_PATH 可覆盖）：
 *   Android SDK = D:/Apps/SDKS        NDK = D:/Apps/SDKS/ndk/30.0.15729638
 *   JDK17 = D:/Apps/SDKS/jdk17/jdk-17.0.20+8    build-tools = D:/Apps/SDKS/build-tools/36.0.0
 *   VS2026 = D:/Apps/vsc/vsc2026（vswhere 自动注入 MSVC）    NSIS 本地 = toolbox/nsis
 *   cargo 在默认 PATH；Android Studio D:/Apps/android 自带 jbr 作 JDK 兜底。
 *
 * Rust 改动先过四步验证再跑本脚本（前台实时跑，勿 | tail 隐藏报错）：
 *   cargo fmt --check → cargo check → cargo clippy --all-targets -- -D warnings → cargo test
 *   （clippy 只覆盖当前编译目标，桌面 clippy 不触发安卓 cfg 分支；平台专属代码要缩进到对应 cfg 块内取句柄）
 *
 * 踩坑清单（改脚本/壳层时对照）：
 *   - 安卓只打 64 位：❌ npm run tauri android build -t ...（npm 吞多值→编全 4 架构含 32 位）；❌ gradle rust{} 注入 targets（v2 插件无此属性）；✅ node toolbox/build-all.mjs --android
 *   - Tauri v2 API 差异：primary_monitor() 返回 Result（写 if let Ok(Some(m))）；size()/scale_factor() 是方法非字段；改壳层先对照源码确认签名
 *   - node_modules/.bin/tauri 在 Windows 跑不了（bash 脚本）→ 一律走本脚本
 *   - 外置架构远程 IPC：远程页调 open_file/write_chunk 被 v2 默认拦 → capabilities/*.json 加 "remote":{"urls":["https://flashdrop.pages.dev"]}
 *   - 桌面双弹窗：Tauri 内 pickSaveDir 直接 return null，统一单框（composables/filesink.ts）
 *   - 根目录必须英文（中文路径→GBK 乱码）；构建 5–15 分钟非卡死别中断；改完代码再启构建，别按名批量杀 cargo/tauri 进程
 *
 * 图标资产固化在 src-tauri/icons/*（桌面/iOS/Android 全套，含安卓 #0b0e16 自适应底色，git 跟踪）：
 *   安卓自定义图标全套在 src-tauri/icons/android/，打包时由 android.mjs 注入 gradle preBuild 覆盖 Tauri 默认派生版（绿背景+默认机器人前景）；换 logo 跑 `node node_modules/@tauri-apps/cli/tauri.js icon public/logo.svg` 即可全端重生（会改 icon.png）。应用名统一取 tauri.conf.json 的 productName。
 *
 * 产物验证：安卓 APK 解包查 lib/ 只含 arm64-v8a + x86_64（无 32 位）；apksigner verify --print-certs releases/app-universal-release.apk → VERIFY PASSED。
 */

import { isWin, isMac, sh, green, yellow, red } from './common.mjs';
import { setVersion } from './version.mjs';
import { buildWindows, buildMacOS } from './windows.mjs';
import { buildAndroid, signAndroidApks } from './android.mjs';

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
/** 取 `--flag value` 或 `--flag=value` 的值 */
const argVal = (f) => {
  const i = argv.indexOf(f);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return argv.find((a) => a.startsWith(f + '='))?.slice(f.length + 1);
};
const only = { windows: has('--windows'), android: has('--android'), macos: has('--macos') };
const explicit = only.windows || only.android || only.macos;
const skipAndroid = has('--no-android') || has('--skip-android');
const skipCopy = has('--skip-copy');
const localNsis = has('--local-nsis') || Boolean(process.env.NSIS_PATH);

// 阶段进度提示：前台窗口逐段显示当前环节（▶ 阶段 N  名称）
let _phase = 0;
function phase(name) {
  _phase++;
  console.log(`\n${green(`▶ 阶段 ${_phase}  ${name}`)}`);
}

// ---------- 主流程 ----------
console.log(green('ArkPulse 统一打包脚本'));
console.log(`当前系统: ${isWin ? 'Windows' : isMac ? 'macOS' : 'Linux'}`);

try {
  // 指定 --version 则先同步改版本再构建（电脑版 + 手机版一致）
  phase('版本校验 / 同步');
  const ver = argVal('--version');
  const codeArg = Number.parseInt(argVal('--version-code') ?? '', 10); // NaN → setVersion 走自动推导
  if (ver) {
    if (!/^\d+\.\d+\.\d+$/.test(ver)) {
      console.error(red(`版本号格式错误: "${ver}"（应为 X.Y.Z，如 1.2.3）`));
      process.exit(1);
    }
    setVersion(ver, codeArg);
  } else {
    console.log(yellow('未指定 --version，使用 tauri.conf.json 当前版本构建。'));
  }

  if (explicit ? only.windows : isWin) { phase('构建 Windows 桌面 (NSIS)'); buildWindows(localNsis); }
  if (explicit ? only.macos : isMac) { phase('构建 macOS 桌面 (dmg)'); buildMacOS(); }
  let androidBuilt = false;
  if (explicit ? only.android : !skipAndroid) {
    phase('构建 Android (APK 64位)');
    androidBuilt = buildAndroid();
    if (!androidBuilt && explicit && only.android) process.exit(1); // 显式要求 Android 却失败
  }
  if (androidBuilt) { phase('Android APK 自签名'); signAndroidApks(); } // 无 keystore 时函数内部自行跳过
  if (!skipCopy) {
    phase('归集安装包到 releases/');
    sh('node toolbox/buildjs/copy-bundles.mjs');
  }
  console.log(`\n${green('全部构建完成 ✅')}`);
} catch (e) {
  console.error(`\n${red('构建中断：' + e.message)}`);
  process.exit(1);
}
