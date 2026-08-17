#!/usr/bin/env node
/**
 * ArkPulse 统一打包脚本 —— 本文件即打包规范，改打包流程只改这里、只维护这里。
 * 默认（不加参数）构建当前系统可构建的全部平台安装包；加 --windows/--android/--macos 只构建指定平台。产物归集到 releases/。
 * 平台：Windows(NSIS) / Android(APK+AAB，仅 arm64-v8a + x86_64) 已通；macOS(dmg) 在 mac 上就地可跑；iOS 待加 --ios。
 *
 * 唯一打包入口（必读）：本脚本是项目唯一的打包命令，只能在项目根目录用 node 跑；禁止 npm run tauri android build / tauri android build / cargo build / 直调 node_modules/@tauri-apps/cli/tauri.js / gradle 等任何其他打包命令（绕开会丢 JAVA_HOME/签名/归集并触发假错）。
 *   语义：不加参数 = 全量双端（Windows+Android）；加 --windows/--android/--macos = 只构建该平台（脚本支持单平台打包）。全量场景勿加单端 flag，也勿加 | tail 隐藏实时输出。用法：
 *   node toolbox/build-all.mjs                        双端全量：Windows NSIS + Android 仅64位
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
 *                     ✅ node toolbox/build-all.mjs --android（脚本内部已正确传 -t aarch64 x86_64，勿手敲 tauri.js）
 *   - Tauri v2 API 差异：primary_monitor() 返回 Result（写 if let Ok(Some(m))）；size()/scale_factor() 是方法非字段；
 *                     改壳层先对照 tauri-<ver>/src/ 源码确认签名，别猜。
 *   - node_modules/.bin/tauri 在 Windows 跑不了（那是 bash 脚本）→ 一律走 node toolbox/build-all.mjs，勿直调 tauri.js/tauri。
 *   - 外置架构远程 IPC：远程页调 open_file/write_chunk 被 v2 默认拦 →
 *                     capabilities/*.json 必须加 "remote":{"urls":["https://flashdrop.pages.dev"]}。
 *   - 桌面双弹窗：Tauri 内 pickSaveDir 直接 return null，统一单框（见 composables/filesink.ts）。
 *   - 根目录必须英文（中文路径→GBK 乱码）；构建 5–15 分钟非卡死别中断；
 *     改完代码再启构建，别按名批量杀 cargo/tauri 进程（会误杀新构建）。
 *
 * 品牌资产（图标）已固化在仓库 src-tauri/icons/*（桌面 / iOS / Android 全套，含安卓 #0b0e16 自适应底色，已被 git 跟踪）：
 *   安卓自定义图标全套在 src-tauri/icons/android/（git 跟踪）：foreground/ 单源 5 尺寸 + 各密度 ic_launcher.png/round.png + anydpi-v26 自适应定义 + values 背景色 #0b0e16。
 *   打包时本脚本把该全套注入 gradle 的 preBuild 任务，覆盖 Tauri 从 icon.png 自动派生的默认版（默认绿背景 + 默认机器人前景）→ 安卓全 API 档位（含 API>=26 自适应）都用自定义图标；桌面图标撑满版另由 icon.png 派生，二者解耦。
 *   换 logo 时手动跑一次 `node node_modules/@tauri-apps/cli/tauri.js icon public/logo.svg` 即可全端重生（注意：会改 icon.png，桌面端随之变化）。
 *   应用名统一取 tauri.conf.json 的 productName（英文），桌面窗口 / NSIS 安装包 / 安卓桌面名都从它来。
 *
 * 产物验证：安卓 APK 解包查 lib/ 只含 arm64-v8a + x86_64（无 32 位）；
 *   apksigner verify --print-certs releases/app-universal-release.apk → VERIFY PASSED。
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

/** 修正 Tauri `android init` 生成的坏 BuildTask.kt：
 *  其把 `tauri` 当脚本名直接传给 node（node tauri …），本机无法解析 → Cannot find module。
 *  改为指向真实的 tauri.js。gen 是 gitignore 的本地产物、init 会重写它，故每次构建前校准一次（幂等）。 */
function patchBuildTaskTauri() {
  const bt = join(projectRoot, 'src-tauri', 'gen', 'android', 'buildSrc', 'src', 'main', 'java', 'com', 'arkpulse', 'xyz', 'kotlin', 'BuildTask.kt');
  if (!existsSync(bt)) return;
  let s = readFileSync(bt, 'utf8');
  if (s.includes('@tauri-apps/cli/tauri.js')) return; // 已修正
  const fixed = s.replace(
    'val args = listOf("tauri", "android", "android-studio-script");',
    'val args = listOf("../node_modules/@tauri-apps/cli/tauri.js", "android", "android-studio-script");'
  );
  if (fixed === s) return;
  writeFileSync(bt, fixed);
  console.log(green('已修正 gen BuildTask.kt 的 tauri CLI 调用路径'));
}

/** 把仓库维护的带 padding 安卓 foreground 单源，作为 gradle 任务注入构建流程：
 *  在 preBuild 阶段覆盖到各密度 res 下的 ic_launcher_foreground.png，
 *  使最终 APK 用我们的留白版，而非 Tauri 从 icon.png 自动派生的贴满版。
 *  源：src-tauri/icons/android/foreground/{WxH}.png（git 跟踪，单文件夹 5 尺寸）。幂等。 */
function injectForegroundCopyTask() {
  const bg = join(projectRoot, 'src-tauri', 'gen', 'android', 'app', 'build.gradle.kts');
  if (!existsSync(bg)) return;
  let s = readFileSync(bg, 'utf8');
  if (s.includes('ARKPULSE_FOREGROUND_FIX')) return;
  const inject = `
// ARKPULSE_FOREGROUND_FIX: 用仓库维护的安卓自定义图标覆盖 Tauri 自动派生版
tasks.register("copyArkPulseForeground") {
    val iconBase = file("../../../icons/android")
    val resBase = file("src/main/res")
    doLast {
        // 1) foreground 单源 → 各密度 ic_launcher_foreground.png（留白版，与桌面撑满版解耦）
        val fgMap = mapOf(
            "mdpi" to "108x108", "hdpi" to "162x162", "xhdpi" to "216x216",
            "xxhdpi" to "324x324", "xxxhdpi" to "432x432"
        )
        for ((density, size) in fgMap) {
            val src = File(iconBase, "foreground/\$size.png")
            val dst = File(resBase, "mipmap-\$density/ic_launcher_foreground.png")
            if (src.exists()) { dst.parentFile.mkdirs(); src.copyTo(dst, overwrite = true) }
        }
        // 2) 完整图标 + round（各密度 png，API<26 设备直接用它）
        for (density in listOf("mdpi","hdpi","xhdpi","xxhdpi","xxxhdpi")) {
            for (name in listOf("ic_launcher","ic_launcher_round")) {
                val src = File(iconBase, "mipmap-\$density/\$name.png")
                val dst = File(resBase, "mipmap-\$density/\$name.png")
                if (src.exists()) { dst.parentFile.mkdirs(); src.copyTo(dst, overwrite = true) }
            }
        }
        // 3) 自适应图标定义 anydpi-v26（API>=26 设备用它组合 foreground+背景色）
        val anydpiSrc = File(iconBase, "mipmap-anydpi-v26/ic_launcher.xml")
        val anydpiDst = File(resBase, "mipmap-anydpi-v26/ic_launcher.xml")
        if (anydpiSrc.exists()) { anydpiDst.parentFile.mkdirs(); anydpiSrc.copyTo(anydpiDst, overwrite = true) }
        // 4) 背景色（覆盖 Tauri 默认绿 #3DDC84 → 我们的 #0b0e16 深蓝黑）
        val bgSrc = File(iconBase, "values/ic_launcher_background.xml")
        val bgDst = File(resBase, "values/ic_launcher_background.xml")
        if (bgSrc.exists()) { bgDst.parentFile.mkdirs(); bgSrc.copyTo(bgDst, overwrite = true) }
    }
}
tasks.preBuild { dependsOn("copyArkPulseForeground") }
`;
  s = s.replace('apply(from = "tauri.build.gradle.kts")', inject + '\napply(from = "tauri.build.gradle.kts")');
  writeFileSync(bg, s);
  console.log(green('已注入安卓 foreground 固定任务到 gradle 构建'));
}

/** 确保 gen/android 存在且处于可构建状态（缺失则先 init），并校准构建脚本。 */
function ensureAndroidGen() {
  const genAndroid = join(projectRoot, 'src-tauri', 'gen', 'android');
  if (!existsSync(genAndroid)) {
    console.log(yellow('gen/android 不存在，先执行 tauri android init'));
    sh('node node_modules/@tauri-apps/cli/tauri.js android init');
  }
  patchBuildTaskTauri();
  injectForegroundCopyTask();
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
  // 确保 gen/android 就绪并校准构建脚本（含安卓图标固定）
  ensureAndroidGen();
  // 构建 64 位双 ABI：arm64-v8a(aarch64) + x86_64(X64，模拟机/Intel 安卓真机用)。不打 32 位 x86/armeabi。gradle 内已注入 foreground 固定任务。
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
  const alias = kv.KEY_ALIAS || 'arkpulse';
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
