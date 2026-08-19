// 云端工厂：默认全部走线上。
// 设计原则（用户 2026-08-02「一律都改为线上和线上数据库」）：
//   文件柜 -> R2（凭 KV bucket_cfg S3 直连，见 storage-router）；索引本 -> D1。
// 运行环境：CF Worker（env 含 D1Database 绑定）。

import { IndexBackend, TransferError } from '../../src/transfer/tus/types';
import { D1IndexBackend } from './d1-index';

export interface TusEnv {
  DB?: D1Database;
}

/** 默认云端索引本：D1。缺绑定即报错（强制线上数据库）。 */
export function createIndex(env: TusEnv): IndexBackend {
  if (!env.DB) {
    throw new TransferError('INDEX', '未配置 DB(D1) 绑定，无法启用线上数据库索引');
  }
  return new D1IndexBackend(env.DB);
}
