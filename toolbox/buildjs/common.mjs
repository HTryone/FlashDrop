// 打包基础能力：项目根路径、平台判定、彩色日志、shell 执行。被 buildjs/ 下所有模块共享。
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename); // toolbox/buildjs
export const projectRoot = dirname(dirname(__dirname)); // toolbox/.. = 项目根
export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

export const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
export const green = (s) => `\x1b[32m${s}\x1b[0m`;
export const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
export const red = (s) => `\x1b[31m${s}\x1b[0m`;

/** 用 shell 执行命令，实时透传输出 */
export function sh(cmd) {
  console.log(`\n${cyan('>>> ' + cmd)}`);
  const r = spawnSync(cmd, { cwd: projectRoot, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    throw new Error(`命令执行失败 (exit ${r.status}): ${cmd}`);
  }
}
