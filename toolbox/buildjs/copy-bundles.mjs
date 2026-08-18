// 打包后把 Tauri 默认输出目录的安装包归集到仓库根 releases/（releases/ 已被 .gitignore 忽略）。
// Tauri v2 无 bundle 自定义输出目录字段，PC 产物固定落 src-tauri/target/<profile>/bundle/，安卓在 src-tauri/gen/android/**/outputs。
// NSIS 回退（默认走网络下载，卡在 Downloading nsis-3.11.zip 时）：把 package.json 的 tauri:build 改为
//   set "NSIS_PATH=toolbox\nsis" && tauri build && node toolbox/buildjs/copy-bundles.mjs
// 即用本地 toolbox/nsis/（含 makensis.exe + 插件）跳过联网。
import { existsSync, mkdirSync, rmdirSync, unlinkSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
// copy-bundles.mjs 现在位于 toolbox/buildjs/，项目根是 toolbox/ 的父目录
const projectRoot = dirname(dirname(scriptDir));
const outDir = join(projectRoot, 'releases');

// Tauri 默认产物位置（Windows/Linux/macOS + Android）
// Android 只扫最终 outputs 目录，避免把 intermediates/ 里的中间 aab 抓出来
const sources = [
  join(projectRoot, 'src-tauri', 'target', 'release', 'bundle'),
  join(projectRoot, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs'),
];

// 要收集的安装包后缀
const exts = new Set(['.exe', '.msi', '.appimage', '.deb', '.dmg', '.apk', '.aab']);

// 拷贝前先清空 releases/（直接覆盖、不累积旧版本）。保留目录本身，只删其下条目，
// 比 rm -rf 整目录更稳；releases/ 本就被 .gitignore 忽略、纯构建产物，清空安全。
function clearDir(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // 递归删子目录（releases 下本无嵌套，防御性处理）
      clearDir(p);
      rmdirSync(p);
    } else {
      unlinkSync(p);
    }
  }
}

function walk(dir, hits) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      walk(p, hits);
    } else {
      const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
      if (exts.has(ext)) hits.push(p);
    }
  }
}

const hits = [];
for (const src of sources) walk(src, hits);

if (hits.length === 0) {
  console.log('[copy-bundles] 未找到任何打包产物（先跑 tauri build / tauri android build）');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
clearDir(outDir); // 先清空，保证只留本次产物（直接覆盖旧版本）
for (const p of hits) {
  const dest = join(outDir, basename(p));
  copyFileSync(p, dest);
  console.log(`[copy-bundles] ${basename(p)} -> releases/`);
}
console.log(`[copy-bundles] 完成，共 ${hits.length} 个文件已输出到 releases/`);
// 打印绝对路径，避免换了目录名/盘符后找不到 releases（今天踩过的坑）
console.log(`[copy-bundles] releases 绝对路径: ${resolve(outDir)}`);
