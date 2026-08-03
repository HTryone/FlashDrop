// 云端工厂：默认全部走线上。
// 设计原则（用户 2026-08-02「一律都改为线上和线上数据库」）：
//   文件柜 -> R2；索引本 -> D1。本地磁盘 / 本地文件实现作为可插拔备选，需显式注入，不在默认路径。
// 运行环境：CF Worker（env 含 R2Bucket 与 D1Database 绑定）。

import { StorageBackend, IndexBackend, TransferError } from '../../src/transfer/tus/types';
import { R2StorageBackend } from './r2-storage';
import { D1IndexBackend } from './d1-index';

export interface TusEnv {
  R2_TRANSFERS?: R2Bucket;
  DB?: D1Database;
  /** R2 S3 兼容预签名 URL 所需凭证（createPresignedUrl 用 aws4fetch 签名）。
   *  accessKeyId/secretAccessKey 为敏感信息，生产环境应通过 wrangler secret 注入，不在 wrangler.toml 明文保存。 */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

/** 默认云端文件柜：R2。缺绑定即报错（强制云端，不静默回退本地）。 */
export function createStorage(env: TusEnv): StorageBackend {
  if (!env.R2_TRANSFERS) {
    throw new TransferError('STORAGE', '未配置 R2_TRANSFERS 绑定，无法启用云端文件柜');
  }
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new TransferError('STORAGE', '未配置 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY，无法生成 presigned URL');
  }
  return new R2StorageBackend(env.R2_TRANSFERS, {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucketName: 'flashdrop-transfers',
  });
}

/** 默认云端索引本：D1。缺绑定即报错（强制线上数据库）。 */
export function createIndex(env: TusEnv): IndexBackend {
  if (!env.DB) {
    throw new TransferError('INDEX', '未配置 DB(D1) 绑定，无法启用线上数据库索引');
  }
  return new D1IndexBackend(env.DB);
}
