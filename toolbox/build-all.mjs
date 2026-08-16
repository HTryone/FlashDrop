#!/usr/bin/env node
/**
 * ArkPulse（闪云）统一打包脚本 —— 本文件即打包规范，改打包流程只改这里、只维护这里。
 * 一执行即按当前系统构建可构建的全部平台安装包，并归集到 releases/。
 * 平台：Windows(NSIS) / Android(APK+AAB，仅 arm64-v8a + x86_64) 已通；macOS(dmg) 在 mac 上就地可跑；iOS 待加 --ios。
 *
 * 用法（在项目根目录 D:\arkpulse 执行；环境已固化，勿先 export 变量）：
 *   node toolbox/build-all.mjs                        双端：Windows NSIS + Android 仅64位
 *   node toolbox/build-all.mjs --windows|--android|--macos    只构建单个平台
 *   node toolbox/build-all.mjs --no-android           跳过 Android
 *   node toolbox/build-all.mjs --local-nsis           Windows 走本地 toolbox/nsis（默认走网络下载）
 *   node toolbox/build-all.mjs --skip-copy            不归集到 releases/
 *   node toolbox/build-all.mjs --version 1.2.3        同步改 tauri.conf.json + package.json 版本再打包
 *                                                     （驱动 PC 安装包版本 + Android versionName）
 *   ... --version 1.2.3 --version-code 12345          显式锁 Android versionCode（省略则按 semver 自动递增）
 *   以上开关可组合，如 `--version 1.0.0 --windows`。
 *
 * 本机环境固定位置（脚本自动探测即命中，无需 export；ANDROID_HOME / NDK_HOME / NSIS_PATH 可覆盖）：
 *   Android SDK = D:/Apps/SDKS                  NDK         = D:/Apps/SDKS/ndk/30.0.15729638
 *   JDK 17      = D:/Apps/SDKS/jdk17/jdk-17.0.20+8   build-tools = D:/Apps/SDKS/build-tools/36.0.0
 *   VS2026      = D:/Apps/vsc/vsc2026（vswhere 自动定位并注入 MSVC）   NSIS 本地 = toolbox/nsis
 *   cargo 已在默认 PATH；Android Studio D:/Apps/android 自带 jbr 作 JDK 兜底。
 *
 * 铁律：任何 Rust 改动先过【四步验证】再跑本脚本（前台实时跑，勿 | tail 隐藏报错）：
 *   cargo fmt --check（不符则 cargo fmt 后复核）→ cargo check
 *   → cargo clippy --all-targets -- -D warnings（警告清零）→ cargo test
 *   clippy 只覆盖当前编译目标，桌面 clippy 不触发安卓 cfg 分支告警；
 *   故平台专属代码要缩进到对应 cfg 块内取句柄，避免跨端未用变量。
 *
 * 踩坑清单（每条都真实发生过，改脚本/壳层时对照）：
 *   - 安卓只打 64 位：❌ npm run tauri android build -t ...（npm 吞多值→编全 4 架构含 32 位）
 *                     ❌ gradle rust{} 注入 targets（v2 插件无此属性→Unresolved reference）
 *                     ✅ node node_modules/@tauri-apps/cli/tauri.js android build -t aarch64 x86_64
 *   - Tauri v2 API 差异：primary_monitor() 返回 Result（写 if let Ok(Some(m))）；size()/scale_factor() 是方法非字段；
 *                     改壳层先对照 tauri-<ver>/src/ 源码确认签名，别猜。
 *   - node_modules/.bin/tauri 在 Windows 跑不了（那是 bash 脚本）→ 用 npm run 或 node .../tauri.js。
 *   - 外置架构远程 IPC：远程页调 open_file/write_chunk 被 v2 默认拦 →
 *                     capabilities/*.json 必须加 "remote":{"urls":["https://flashdrop.pages.dev"]}。
 *   - 桌面双弹窗：Tauri 内 pickSaveDir 直接 return null，统一单框（见 composables/filesink.ts）。
 *   - 根目录必须英文（中文路径→GBK 乱码）；构建 5–15 分钟非卡死别中断；
 *     改完代码再启构建，别按名批量杀 cargo/tauri 进程（会误杀新构建）。
 *
 * 品牌资产单一源：换 logo 只改 public/logo.svg，改应用名只改 tauri.conf.json 的 productName（英文，
 *   桌面窗口 / NSIS 安装包 / 安卓桌面名统一取它），跑本脚本即全端生效、不用手跑 tauri icon。
 *   桌面 bundle.icon 直读 icons/*；安卓图标 + 自适应底色 + 应用名由 syncAndroidBrand() 自动对齐（坑见该函数）。
 *
 * 产物验证：安卓 APK 解包查 lib/ 只含 arm64-v8a + x86_64（无 32 位）；
 *   apksigner verify --print-certs releases/app-universal-release.apk → VERIFY PASSED。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, cpSync } from 'node:fs';
import { join, dirname, delimiter, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname); // toolbox/.. = 项目根

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

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

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

/** 用 shell 执行命令，实时透传输出 */
function sh(cmd) {
  console.log(`\n${cyan('>>> ' + cmd)}`);
  const r = spawnSync(cmd, { cwd: projectRoot, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    throw new Error(`命令执行失败 (exit ${r.status}): ${cmd}`);
  }
}

/** 在 SDK 的 ndk/ 下找已安装的 NDK 目录（兼容 ndk-build 在根目录或 build/ 子目录） */
function findNdk(sdk) {
  const ndkDir = join(sdk, 'ndk');
  if (!existsSync(ndkDir)) return undefined;
  const subs = readdirSync(ndkDir).filter(
    (d) => existsSync(join(ndkDir, d, 'ndk-build')) || existsSync(join(ndkDir, d, 'build', 'ndk-build'))
  );
  return subs.length ? join(ndkDir, subs[subs.length - 1]) : undefined;
}

/** 解析 Android 工具链：优先用环境变量，否则探测常见默认路径 */
function resolveAndroidEnv() {
  let androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  let ndkHome = process.env.NDK_HOME;
  if (androidHome && existsSync(androidHome)) {
    if (!ndkHome) ndkHome = findNdk(androidHome);
    return { androidHome, ndkHome };
  }
  const candidates = [
    'D:/Apps/SDKS',                                        // 本机正式 Android SDK（含 NDK/platform-tools）
    join(homedir(), 'AppData', 'Local', 'Android', 'Sdk'), // Windows 默认
    join(homedir(), 'Android', 'Sdk'),                     // Linux
    join(homedir(), 'Library', 'Android', 'sdk'),          // macOS
  ];
  for (const c of candidates) {
    if (existsSync(c)) { androidHome = c; break; }
  }
  if (androidHome && !ndkHome) ndkHome = findNdk(androidHome);
  return { androidHome, ndkHome };
}

/** 解析 JDK：优先环境变量，否则探测本机常见 JDK 位置（Gradle 构建必须） */
function resolveJava() {
  const hasJava = (p) => p && (existsSync(join(p, 'bin', 'java.exe')) || existsSync(join(p, 'bin', 'java')));
  if (hasJava(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const candidates = [
    'D:/Apps/SDKS/jdk17/jdk-17.0.20+8',                    // 本机正式 JDK 17（Gradle 8.14.3 兼容）
    'D:/Apps/android/jbr',                                // Android Studio 自带 JBR（JDK 25，Gradle 支持后可用）
  ];
  for (const c of candidates) {
    if (hasJava(c)) return c;
  }
  return undefined;
}

// ---------- 版本号 ----------
// --version 同时驱动 PC 安装包版本与 Android versionName；--version-code 省略则按 semver 自动推导。
function semverCode(v) {
  const [maj, min, pat] = v.split('.').map(Number);
  return maj * 1000000 + min * 1000 + pat;
}
function setVersion(v, code) {
  const confPath = join(projectRoot, 'src-tauri', 'tauri.conf.json');
  const conf = JSON.parse(readFileSync(confPath, 'utf8'));
  const old = conf.version;
  conf.version = v;
  if (!conf.bundle) conf.bundle = {};
  if (!conf.bundle.android) conf.bundle.android = {};
  if (Number.isInteger(code) && code >= 1) {
    conf.bundle.android.versionCode = code;
  } else {
    // 省略 versionCode：删除显式值，由 Tauri 按 semver 自动推导（随版本号单调递增）
    delete conf.bundle.android.versionCode;
  }
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  // 同步 package.json 的 version，保持单一认知
  const pkgPath = join(projectRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = v;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const codeMsg = Number.isInteger(code) && code >= 1 ? `, versionCode=${code}` : `, versionCode=自动(${semverCode(v)})`;
  console.log(green(`版本号 ${old} -> ${v}${codeMsg}`));
  console.log(`  tauri.conf.json & package.json 已同步`);
}

// ---------- 各平台构建 ----------
/** 定位 VS 自带的 vcvarsall.bat（vswhere 能发现自定义安装路径），用于注入 cl.exe/LIB/INCLUDE，
 *  免手动开 Developer Command Prompt；找不到返回 undefined（回退到当前 shell 环境）。 */
function resolveVsDevCmd() {
  const vswhere = 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe';
  if (!existsSync(vswhere)) return undefined;
  try {
    const r = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return undefined;
    const list = JSON.parse(r.stdout);
    if (!Array.isArray(list) || !list.length) return undefined;
    const vcvars = join(list[0].installationPath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
    return existsSync(vcvars) ? vcvars : undefined;
  } catch {
    return undefined;
  }
}

function buildWindows() {
  console.log(`\n========== 构建 Windows 桌面 (NSIS) ==========`);
  if (localNsis) {
    process.env.NSIS_PATH = join(projectRoot, 'toolbox', 'nsis');
    console.log(yellow('使用本地 NSIS：' + process.env.NSIS_PATH));
  }
  // 自动注入 VS 编译环境（vswhere 能发现自定义路径的 VS），让脚本在任意 shell 都能直接全打包。
  const vcvars = resolveVsDevCmd();
  if (vcvars) {
    console.log(green(`VS 环境: 通过 ${vcvars} 自动注入 MSVC 工具链（无需手动开 Dev Prompt）`));
    sh(`call "${vcvars}" x64 && npm run tauri build`);
  } else {
    console.log(yellow('[提示] 未发现 VS（vswhere 缺失或非标准安装）；若当前 shell 已含 MSVC 环境则继续，否则将失败。'));
    sh('npm run tauri build');
  }
}

function buildMacOS() {
  console.log(`\n========== 构建 macOS 桌面 (dmg/app) ==========`);
  sh('npm run tauri build');
}

// ---------- 品牌资产同步（全端图标 + 安卓应用名） ----------
// 安卓构建前必走本函数，因为 tauri icon 有三个坑：
//   1. 输出位置随 gen/android 存在与否而变：不存在→写 icons/android（仓库种子）；已存在→直接写 gen/.../res，
//      不再更新 icons/android。（踩坑实录：曾误当 icons/android 是权威 cpSync 铺到 gen，把旧 logo 刷回覆盖新图）
//   2. 不管 values/ic_launcher_background.xml，默认白底 #fff → 深色 logo 周围露白边。
//   3. 不管 values/strings.xml，应用名停在 android init 那一刻的旧 productName。
// 故流程 = 重生成 → 修背景 → 写应用名 → 新图回写 icons/android。桌面端无需同步（bundle.icon 直读 icons/*）。
const BRAND_BG = '#0b0e16'; // 与 src/style.css 的 --bg 同值；改深色主题时两处一起改
function syncAndroidBrand() {
  if (!existsSync(join(projectRoot, 'public', 'logo.svg'))) {
    console.log(yellow('[跳过品牌同步] public/logo.svg 缺失。'));
    return;
  }
  // 1) 从唯一图形源重生成全平台图标（安卓写向由 gen 是否存在决定，见上）
  sh('node node_modules/@tauri-apps/cli/tauri.js icon public/logo.svg');
  const resDir = join(projectRoot, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');
  const iconsAndroid = join(projectRoot, 'src-tauri', 'icons', 'android');
  if (!existsSync(resDir)) {
    console.log(yellow('[品牌同步] gen/android 未初始化：图标已写入 icons/android，android init 时带入。'));
    return;
  }
  // 2) 自适应图标背景：白底 → 品牌深色
  writeFileSync(
    join(resDir, 'values', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${BRAND_BG}</color>\n</resources>\n`,
    'utf8',
  );
  // 3) 安卓桌面应用名 ← tauri.conf.json 的 productName（英文单一源）
  const appName = JSON.parse(
    readFileSync(join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  ).productName;
  writeFileSync(
    join(resDir, 'values', 'strings.xml'),
    `<resources>\n    <string name="app_name">"${appName}"</string>\n    <string name="main_activity_title">"${appName}"</string>\n</resources>\n`,
    'utf8',
  );
  // 4) 新图回写仓库种子（gen 被 git 忽略，不回写则仓库里永远停在旧 logo）
  for (const d of readdirSync(resDir)) {
    if (!d.startsWith('mipmap-')) continue;
    cpSync(join(resDir, d), join(iconsAndroid, d), { recursive: true, force: true });
  }
  cpSync(
    join(resDir, 'values', 'ic_launcher_background.xml'),
    join(iconsAndroid, 'values', 'ic_launcher_background.xml'),
    { force: true },
  );
  console.log(`品牌资产    : logo.svg → 全端图标（安卓底色 ${BRAND_BG}），安卓应用名 = ${appName}`);
}

function buildAndroid() {
  console.log(`\n========== 构建 Android (APK) ==========`);
  const { androidHome, ndkHome } = resolveAndroidEnv();
  if (!androidHome) {
    console.log(yellow('[跳过] 未找到 Android SDK。请设置 ANDROID_HOME，或把 SDK 装到默认路径（~/Android/Sdk 等）。'));
    return false;
  }
  process.env.ANDROID_HOME = androidHome;
  if (ndkHome) {
    process.env.NDK_HOME = ndkHome;
    console.log(`Android SDK : ${androidHome}`);
    console.log(`NDK         : ${ndkHome}`);
  } else {
    console.log(yellow('[警告] 未找到 NDK（设置 NDK_HOME），Android 构建可能失败。'));
  }
  // JDK：Gradle 构建必须。env 优先，否则探测本机常见位置，并补进 PATH。
  const javaHome = resolveJava();
  if (javaHome) {
    process.env.JAVA_HOME = javaHome;
    const bin = join(javaHome, 'bin');
    if (!process.env.PATH.includes(bin)) process.env.PATH = bin + delimiter + process.env.PATH;
    console.log(`JAVA_HOME   : ${javaHome}`);
  } else {
    console.log(yellow('[警告] 未找到 JDK（设置 JAVA_HOME），Android 构建可能失败。'));
  }
  syncAndroidBrand(); // gen 被 git 忽略，图标与应用名必须每次从单一源铺进去
  // 只构建 64 位；直跑 tauri.js 而不走 npm run，否则 npm 会吞掉多值 -t 参数
  sh('node node_modules/@tauri-apps/cli/tauri.js android build -t aarch64 x86_64');
  return true;
}

// ---------- Android 自签名 ----------
// `tauri android build` 只出 unsigned APK，且 gen 被 Tauri 托管会重建（改 gradle 签名不持久），
// 故统一在 build 后用 keystore + zipalign/apksigner 自动签名，输出可直接装机的已签名 APK。
// 密钥来自 src-tauri/keystore.env（已 git 忽略）；缺失则降级为 unsigned（与旧行为一致）。
function findUnsignedApks(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) findUnsignedApks(p, out);
    else if (/-unsigned\.apk$/.test(name)) out.push(p);
  }
  return out;
}

function signAndroidApks() {
  const envPath = join(projectRoot, 'src-tauri', 'keystore.env');
  if (!existsSync(envPath)) {
    console.log(yellow('[跳过签名] 未找到 src-tauri/keystore.env（无 keystore）。将输出未签名 APK（无法直接安装）。'));
    return;
  }
  const kv = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) kv[m[1]] = m[2];
  }
  const ksFile = join(projectRoot, kv.KEYSTORE_FILE || 'src-tauri/release-key.jks');
  const ksPass = kv.KEYSTORE_PASSWORD;
  const alias = kv.KEY_ALIAS || 'flashdrop';
  const keyPass = kv.KEY_PASSWORD || ksPass;
  if (!existsSync(ksFile)) {
    console.log(yellow(`[跳过签名] keystore 不存在: ${ksFile}`));
    return;
  }
  // 探测 build-tools（取含 zipalign/apksigner 的最新版本）
  const { androidHome } = resolveAndroidEnv();
  const btRoot = join(androidHome || 'D:/Apps/SDKS', 'build-tools');
  let btDir;
  if (existsSync(btRoot)) {
    const vers = readdirSync(btRoot)
      .filter((d) => existsSync(join(btRoot, d, 'zipalign.exe')) && existsSync(join(btRoot, d, 'apksigner.bat')))
      .sort()
      .reverse();
    if (vers.length) btDir = join(btRoot, vers[0]);
  }
  if (!btDir) {
    console.log(yellow('[跳过签名] 未找到 Android build-tools（zipalign/apksigner）。'));
    return;
  }
  const zipalign = join(btDir, 'zipalign.exe');
  const apksigner = join(btDir, 'apksigner.bat');

  const apkRoot = join(projectRoot, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk');
  const unsigned = findUnsignedApks(apkRoot);
  if (unsigned.length === 0) {
    console.log(yellow('[签名] 未找到 unsigned APK（可能只构建了 AAB）。'));
    return;
  }
  console.log(`\n${cyan('========== Android APK 自签名 ==========')}`);
  for (const u of unsigned) {
    const aligned = u.replace(/-unsigned\.apk$/, '-aligned.tmp');
    const signed = u.replace(/-unsigned\.apk$/, '.apk');
    sh(`"${zipalign}" -p 4 "${u}" "${aligned}"`);
    sh(`"${apksigner}" sign --ks "${ksFile}" --ks-key-alias "${alias}" --ks-pass pass:${ksPass} --key-pass pass:${keyPass} --out "${signed}" "${aligned}"`);
    unlinkSync(aligned);
    unlinkSync(u);
    console.log(green(`签名完成: ${basename(signed)}`));
  }
  console.log(green('Android APK 已全部自签名 ✅'));
}

// ---------- 主流程 ----------
console.log(green('ArkPulse 统一打包脚本'));
console.log(`当前系统: ${isWin ? 'Windows' : isMac ? 'macOS' : 'Linux'}`);

try {
  // 指定 --version 则先同步改版本再构建（电脑版 + 手机版一致）
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

  if (explicit ? only.windows : isWin) buildWindows();
  if (explicit ? only.macos : isMac) buildMacOS();
  let androidBuilt = false;
  if (explicit ? only.android : !skipAndroid) {
    androidBuilt = buildAndroid();
    if (!androidBuilt && explicit && only.android) process.exit(1); // 显式要求 Android 却失败
  }
  if (androidBuilt) signAndroidApks(); // 无 keystore 时函数内部自行跳过
  if (!skipCopy) {
    console.log(`\n========== 归集安装包到 releases/ ==========`);
    sh('node toolbox/copy-bundles.mjs');
  }
  console.log(`\n${green('全部构建完成 ✅')}`);
} catch (e) {
  console.error(`\n${red('构建中断：' + e.message)}`);
  process.exit(1);
}
