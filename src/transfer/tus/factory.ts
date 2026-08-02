// 云端工厂：默认全部走线上。
// 设计原则（用户 2026-08-02「一律都改为线上和线上数据库」）：
//   文件柜 -> R2；索引本 -> D1。本地磁盘 / 本地文件实现作为可插拔备选，需显式注入，不在默认路径。
// 运行环境：CF Worker（env 含 R2Bucket 与 D1Database 绑定）。

import { StorageBackend, IndexBackend, TransferError } from './types';
import { R2StorageBackend } from './r2-storage';
import { D1IndexBackend } from './d1-index';

export interface TusEnv {
  R2_TRANSFERS?: R2Bucket;
  DB?: D1Database;
}

/** 默认云端文件柜：R2。缺绑定即报错（强制云端，不静默回退本地）。 */
export function createStorage(env: TusEnv): StorageBackend {
  if (!env.R2_TRANSFERS) {
    throw new TransferError('STORAGE', '未配置 R2_TRANSFERS 绑定，无法启用云端文件柜');
  }
  return new R2StorageBackend(env.R2_TRANSFERS);
}

/** 默认云端索引本：D1。缺绑定即报错（强制线上数据库）。 */
export function createIndex(env: TusEnv): IndexBackend {
  if (!env.DB) {
    throw new TransferError('INDEX', '未配置 DB(D1) 绑定，无法启用线上数据库索引');
  }
  return new D1IndexBackend(env.DB);
}
