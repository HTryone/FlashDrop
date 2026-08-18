// 构建前清理旧安装包：每次迭代 tauri build 只往固定输出目录追加新版本包、不删旧的，导致原始目录越叠越多。
// 在各自构建函数开头清掉对应原始输出目录里的旧安装包文件（保留目录结构，非 rm -rf 整目录），
// 构建后目录只留当前版本；copy-bundles 仍照常把新包归集到 releases/（它已先清空 releases）。
import { existsSync, readdirSync, unlinkSync, statSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { yellow } from './common.mjs';

const PKG_EXTS = new Set(['.exe', '.msi', '.appimage', '.deb', '.dmg', '.apk', '.aab', '.idsig']);

export function cleanInstallArtifacts(dir, label) {
  if (!existsSync(dir)) return;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      cleanInstallArtifacts(p, label);
      try { rmdirSync(p); } catch { /* 仍含非安装包产物的非空子目录保留 */ }
    } else if (PKG_EXTS.has(name.toLowerCase().slice(name.lastIndexOf('.')))) {
      unlinkSync(p);
      n++;
    }
  }
  if (n) console.log(yellow(`清理旧安装包（${label}）: ${n} 个`));
}
