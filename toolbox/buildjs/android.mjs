// 安卓全链路：gen 校准（BuildTask 路径修正 + 自定义图标注入）、64 位双 ABI 构建、APK 自签名。
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join, delimiter, basename } from 'node:path';
import { projectRoot, sh, green, yellow, cyan } from './common.mjs';
import { resolveAndroidEnv, resolveJava } from './env.mjs';
import { cleanInstallArtifacts } from './clean.mjs';

/** 修正 Tauri `android init` 生成的坏 BuildTask.kt：
 *  其把 `tauri` 当脚本名直接传给 node（node tauri …），本机无法解析 → Cannot find module。
 *  改为指向真实的 tauri.js。gen 是 gitignore 的本地产物、init 会重写它，故每次构建前校准一次（幂等）。 */
export function patchBuildTaskTauri() {
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
export function injectForegroundCopyTask() {
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
export function ensureAndroidGen() {
  const genAndroid = join(projectRoot, 'src-tauri', 'gen', 'android');
  if (!existsSync(genAndroid)) {
    console.log(yellow('gen/android 不存在，先执行 tauri android init'));
    sh('node node_modules/@tauri-apps/cli/tauri.js android init');
  }
  patchBuildTaskTauri();
  injectForegroundCopyTask();
}

export function buildAndroid() {
  cleanInstallArtifacts(join(projectRoot, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs'), 'Android');
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
  // 只出 APK（--apk），不出 AAB（AAB 仅上架 Google Play 用，本地装机用不到）。
  sh('node node_modules/@tauri-apps/cli/tauri.js android build -t aarch64 x86_64 --apk');
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

export function signAndroidApks() {
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
