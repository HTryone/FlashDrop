// Android / Java / VS 工具链探测。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { projectRoot } from './common.mjs';

/** 在 SDK 的 ndk/ 下找已安装的 NDK 目录（兼容 ndk-build 在根目录或 build/ 子目录） */
export function findNdk(sdk) {
  const ndkDir = join(sdk, 'ndk');
  if (!existsSync(ndkDir)) return undefined;
  const subs = readdirSync(ndkDir).filter(
    (d) => existsSync(join(ndkDir, d, 'ndk-build')) || existsSync(join(ndkDir, d, 'build', 'ndk-build'))
  );
  return subs.length ? join(ndkDir, subs[subs.length - 1]) : undefined;
}

/** 解析 Android 工具链：优先用环境变量，否则探测常见默认路径 */
export function resolveAndroidEnv() {
  let androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  let ndkHome = process.env.NDK_HOME;
  if (androidHome && existsSync(androidHome)) {
    if (!ndkHome) ndkHome = findNdk(androidHome);
    return { androidHome, ndkHome };
  }
  const candidates = [
    'D:/Apps/SDKS', // 本机正式 Android SDK（含 NDK/platform-tools）
    join(homedir(), 'AppData', 'Local', 'Android', 'Sdk'), // Windows 默认
    join(homedir(), 'Android', 'Sdk'), // Linux
    join(homedir(), 'Library', 'Android', 'sdk'), // macOS
  ];
  for (const c of candidates) {
    if (existsSync(c)) { androidHome = c; break; }
  }
  if (androidHome && !ndkHome) ndkHome = findNdk(androidHome);
  return { androidHome, ndkHome };
}

/** 解析 JDK：优先环境变量，否则探测本机常见 JDK 位置（Gradle 构建必须） */
export function resolveJava() {
  const hasJava = (p) => p && (existsSync(join(p, 'bin', 'java.exe')) || existsSync(join(p, 'bin', 'java')));
  if (hasJava(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const candidates = [
    'D:/Apps/SDKS/jdk17/jdk-17.0.20+8', // 本机正式 JDK 17（Gradle 8.14.3 兼容）
    'D:/Apps/android/jbr', // Android Studio 自带 JBR（JDK 25，Gradle 支持后可用）
  ];
  for (const c of candidates) {
    if (hasJava(c)) return c;
  }
  return undefined;
}

/** 定位 VS 自带的 vcvarsall.bat（vswhere 能发现自定义安装路径），用于注入 cl.exe/LIB/INCLUDE，
 *  免手动开 Developer Command Prompt；找不到返回 undefined（回退到当前 shell 环境）。 */
export function resolveVsDevCmd() {
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
