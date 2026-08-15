// 打包后把 exe/apk 等安装包从 Tauri 默认输出目录复制到仓库根 releases/
// 原因：Tauri v2 配置无 bundle 自定义输出目录字段，bundle 固定落在
//       src-tauri/target/<profile>/bundle/；Android 产物在 src-tauri/gen/android/**/outputs。
// 这里用 post-build 复制把它们归集到根目录 releases/，releases/ 已在 .gitignore 忽略。
//
// NSIS 回退说明（tauri:build 在 package.json）：
//   默认走网络下载 NSIS（tauri build 会自动从 GitHub 拉）。
//   若网络下不动（卡在 Downloading nsis-3.11.zip），把 tauri:build 改回：
//     set "NSIS_PATH=toolbox\nsis" && tauri build && node toolbox/copy-bundles.mjs
//   即用本地 toolbox/nsis/（含 makensis.exe + 插件）跳过联网。
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const outDir = join(projectRoot, 'releases');

// Tauri 默认产物位置（Windows/Linux/macOS + Android）
const sources = [
  join(projectRoot, 'src-tauri', 'target', 'release', 'bundle'),
  join(projectRoot, 'src-tauri', 'gen', 'android'),
];

// 要收集的安装包后缀
const exts = new Set(['.exe', '.msi', '.appimage', '.deb', '.dmg', '.apk', '.aab']);

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
for (const p of hits) {
  const dest = join(outDir, basename(p));
  copyFileSync(p, dest);
  console.log(`[copy-bundles] ${basename(p)} -> releases/`);
}
console.log(`[copy-bundles] 完成，共 ${hits.length} 个文件已输出到 releases/`);
// 打印绝对路径，避免换了目录名/盘符后找不到 releases（今天踩过的坑）
console.log(`[copy-bundles] releases 绝对路径: ${resolve(outDir)}`);
