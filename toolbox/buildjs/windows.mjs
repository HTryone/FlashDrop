// 桌面端（Windows NSIS / macOS dmg）构建。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, sh, green, yellow } from './common.mjs';
import { resolveVsDevCmd } from './env.mjs';
import { cleanInstallArtifacts } from './clean.mjs';

export function buildWindows(localNsis) {
  cleanInstallArtifacts(join(projectRoot, 'src-tauri', 'target', 'release', 'bundle'), 'Windows');
  console.log(`\n========== 构建 Windows 桌面 (NSIS) ==========`);
  if (localNsis) {
    process.env.NSIS_PATH = join(projectRoot, 'toolbox', 'nsis');
    console.log(yellow('使用本地 NSIS：' + process.env.NSIS_PATH));
  }
  // 自动注入 Windows SDK 路径到环境，确保 vcvarsall 能拼出 kernel32.lib 等系统库 LIB 路径。
  // Git Bash 启动链不继承 User/Machine 环境变量，故在此显式注入（已存在则不覆盖）。
  if (!process.env.WindowsSdkDir) {
    const sdkCandidates = [
      'D:/Windows Kits/10',
      'C:/Program Files (x86)/Windows Kits/10',
      'C:/Program Files/Windows Kits/10',
    ];
    const sdk = sdkCandidates.find((p) => existsSync(join(p, 'Lib')));
    if (sdk) {
      process.env.WindowsSdkDir = sdk;
      console.log(green(`Windows SDK: 注入 WindowsSdkDir=${sdk}（供 vcvarsall 定位系统库）`));
    } else {
      console.log(yellow('[警告] 未发现 Windows SDK（Windows Kits\\10\\Lib），kernel32.lib 将找不到，链接会失败。'));
    }
  }
  // 自动注入 VS 编译环境（vswhere 定位，免手动开 Dev Prompt）
  const vcvars = resolveVsDevCmd();
  if (vcvars) {
    console.log(green(`VS 环境: 通过 ${vcvars} 自动注入 MSVC 工具链（无需手动开 Dev Prompt）`));
    sh(`call "${vcvars}" x64 && npm run tauri build`);
  } else {
    console.log(yellow('[提示] 未发现 VS（vswhere 缺失或非标准安装）；若当前 shell 已含 MSVC 环境则继续，否则将失败。'));
    sh('npm run tauri build');
  }
}

export function buildMacOS() {
  console.log(`\n========== 构建 macOS 桌面 (dmg/app) ==========`);
  sh('npm run tauri build');
}
