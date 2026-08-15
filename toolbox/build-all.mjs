#!/usr/bin/env node
/**
 * FlashDrop 统一打包脚本
 * ---------------------------------------------------------------------------
 * 一执行即按当前操作系统自动构建可构建的全部平台安装包，并归集到 releases/。
 *
 * 已支持：
 *   - Windows 桌面  (NSIS 安装包)        —— 在 Windows 上自动构建
 *   - Android       (APK)               —— 需要 Android SDK/NDK（脚本自动探测常见路径）
 * 预留扩展：
 *   - macOS 桌面    (dmg / app)         —— 在 macOS 上自动构建（本机在 Windows，暂不触发）
 *   - iOS           (ipa)              —— 未来在 macOS 上加 --ios 即可
 *
 * 用法（在项目根目录执行）：
 *   node toolbox/build-all.mjs                # 构建当前系统能构建的全部平台（默认含 Android）
 *   node toolbox/build-all.mjs --windows     # 只构建 Windows 桌面
 *   node toolbox/build-all.mjs --android     # 只构建 Android
 *   node toolbox/build-all.mjs --macos       # 只构建 macOS（需在 macOS 上运行）
 *   node toolbox/build-all.mjs --no-android  # 跳过 Android
 *   node toolbox/build-all.mjs --local-nsis # Windows 构建走本地 toolbox/nsis（默认走网络下载）
 *   node toolbox/build-all.mjs --skip-copy   # 不执行归集到 releases/
 *
 * 版本号（一键改版本再打包，电脑版与手机版同时生效）：
 *   node toolbox/build-all.mjs --version 1.2.3
 *       ↑ 同时修改 tauri.conf.json 顶层 version（驱动 PC 安装包版本 + Android versionName）
 *         与 package.json version，保持单一认知；Android versionCode 按 semver 自动推导。
 *   node toolbox/build-all.mjs --version 1.2.3 --version-code 12345
 *       ↑ --version-code 显式指定 Android versionCode（升级必须递增，省略则随版本号自动递增）。
 *
 * 可选环境变量（脚本也会自动探测，无需手动设置）：
 *   ANDROID_HOME    Android SDK 根目录
 *   NDK_HOME        Android NDK 根目录
 *   NSIS_PATH       Windows 本地 NSIS 目录（等价于 --local-nsis）
 * ---------------------------------------------------------------------------
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
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
  // 探测顺序：本机临时工具链配套 JDK → Android Studio 自带 JBR
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
// --version X.Y.Z   指定本次构建版本（同时驱动 PC 安装包版本与 Android versionName）
// --version-code N  可选，显式设置 Android versionCode（升级必须递增）；省略则按 semver 自动推导
function parseVersionArg() {
  const i = argv.indexOf('--version');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--version='));
  return eq ? eq.slice('--version='.length) : undefined;
}
function parseVersionCodeArg() {
  const i = argv.indexOf('--version-code');
  if (i !== -1 && argv[i + 1]) {
    const v = parseInt(argv[i + 1], 10);
    return Number.isNaN(v) ? undefined : v;
  }
  const eq = argv.find((a) => a.startsWith('--version-code='));
  if (!eq) return undefined;
  const v = parseInt(eq.slice('--version-code='.length), 10);
  return Number.isNaN(v) ? undefined : v;
}
function isValidVersion(v) {
  return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);
}
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

// ---------- 安卓 ABI 限制（只 64 位）----------
// 控制点：直接调 `tauri.cmd android build -t aarch64 x86_64`（见 buildAndroid）。
// 关键坑：-t 的多值参数经 `npm run` 会被吞，必须直接调 tauri.cmd 绕过。
// 注意：Tauri v2 的 gradle `rust {}` 插件无 `targets` 属性，不要往 gradle 注入（会 Unresolved reference）。

// ---------- 各平台构建 ----------
function buildWindows() {
  console.log(`\n========== 构建 Windows 桌面 (NSIS) ==========`);
  if (localNsis) {
    process.env.NSIS_PATH = join(projectRoot, 'toolbox', 'nsis');
    console.log(yellow('使用本地 NSIS：' + process.env.NSIS_PATH));
  }
  sh('npm run tauri build');
}

function buildMacOS() {
  console.log(`\n========== 构建 macOS 桌面 (dmg/app) ==========`);
  sh('npm run tauri build');
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
  // 限制 ABI：只构建 64 位（aarch64 + x86_64），不兼容 32 位老旧设备。
  // 用 node 直跑 tauri 入口 tauri.js（不经 npm run，避免 npm 吞掉多值 -t 参数）；-t 后跟空格分隔的架构列表。
  sh('node node_modules/@tauri-apps/cli/tauri.js android build -t aarch64 x86_64');
  return true;
}

// ---------- Android 自签名 ----------
// Tauri 2.x 的 `tauri android build` 只出 unsigned APK（gen 目录被 Tauri 托管、会重建，
// 改 gradle 文件签名不持久）。故统一在 build 之后由打包脚本用 keystore + apksigner 自动签名，
// 输出已签名 APK（去掉 -unsigned），这才是能直接装真机/分发的包。
// 密钥与密码来自 src-tauri/keystore.env（已 git 忽略）；缺失则降级为 unsigned（旧行为一致）。
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
console.log(green('FlashDrop 统一打包脚本'));
console.log(`当前系统: ${isWin ? 'Windows' : isMac ? 'macOS' : 'Linux'}`);

try {
  // 版本号：若指定 --version 则先改版本再构建（电脑版 + 手机版同步）
  const ver = parseVersionArg();
  const codeArg = parseVersionCodeArg();
  if (ver) {
    if (!isValidVersion(ver)) {
      console.error(red(`版本号格式错误: "${ver}"（应为 X.Y.Z，如 1.2.3）`));
      process.exit(1);
    }
    setVersion(ver, codeArg);
  } else {
    console.log(yellow('未指定 --version，使用 tauri.conf.json 当前版本构建。'));
  }

  // Windows 桌面
  if (explicit ? only.windows : isWin) buildWindows();
  // macOS 桌面（未来扩展）
  if (explicit ? only.macos : isMac) buildMacOS();
  // Android
  let androidBuilt = false;
  if (explicit ? only.android : !skipAndroid) {
    androidBuilt = buildAndroid();
    if (!androidBuilt && explicit && only.android) process.exit(1); // 显式要求 Android 却失败
  }
  // Android 自签名（keystore 自签名，输出已签名 APK；无 keystore 则跳过保持旧行为）
  if (androidBuilt) signAndroidApks();
  // 归集到 releases/
  if (!skipCopy) {
    console.log(`\n========== 归集安装包到 releases/ ==========`);
    sh('node toolbox/copy-bundles.mjs');
  }
  console.log(`\n${green('全部构建完成 ✅')}`);
} catch (e) {
  console.error(`\n${red('构建中断：' + e.message)}`);
  process.exit(1);
}
