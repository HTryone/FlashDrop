// 存储桶路由：把传输/文件路由到正确的后端 R2 存储桶（多 Cloudflare 账户 / 多桶）。
// 设计：共享的 tus-handler / download-handler / transfer-handler 不在内部感知桶，
// 而是在 index.ts 按 传输→account_id 解析出对应 R2StorageBackend 再构造，从而零改动共享代码。
//
// 全 KV 化（用户 2026-08-20 决定，无过渡期）：不再有仓库硬编码绑定。
// 每桶配置存 KV `quota:<account_id>:bucket_cfg`（accountId/accessKeyId/secretAccessKey/bucketName），
// R2StorageBackend 凭该配置 S3 直连任意跨账户桶；无配置直接报错，不静默回退。
// 选桶规则（BucketSelector）：遍历 KV 桶清单（接入顺序）→ 跳过停用 → 剩余=上限-已用 →
// 选剩余最多；严格大于才替换 → 平局保留先遍历（配置靠前）的桶。

import { R2StorageBackend } from './r2-storage';
import type { StorageBackend } from '../../src/transfer/tus/types';

export interface StorageResolver {
  resolve(accountId: string): Promise<StorageBackend>;
}

interface BucketCfg {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

/** 全 KV 解析：凭 quota:<account_id>:bucket_cfg S3 直连；缺配置抛错。 */
export function createStorageResolver(kv: KVNamespace | undefined): StorageResolver {
  return {
    async resolve(accountId: string): Promise<StorageBackend> {
      if (!kv) throw new Error(`KV 未配置，无法解析存储桶: ${accountId}`);
      const cfg = (await kv.get(`quota:${accountId}:bucket_cfg`, 'json')) as BucketCfg | null;
      if (!cfg?.bucketName || !cfg?.accountId || !cfg?.accessKeyId || !cfg?.secretAccessKey) {
        throw new Error(`存储桶未配置（KV 无 bucket_cfg）: ${accountId}`);
      }
      return new R2StorageBackend(undefined, {
        accountId: cfg.accountId,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        bucketName: cfg.bucketName,
      });
    },
  };
}

/** 选桶策略：创建传输/文件时按「剩余额度最多且启用」择优，写入 transfer_account。 */
export class BucketSelector {
  constructor(
    private readonly db: D1Database,
    private readonly kv: KVNamespace | undefined,
  ) {}

  async accountOfTransfer(transferId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT account_id FROM transfer_account WHERE transfer_id = ?`)
      .bind(transferId)
      .first<{ account_id: string }>();
    return row?.account_id ?? null;
  }

  /** 取/选该传输归属桶；无记录则现场选桶并写 transfer_account。 */
  async select(transferId: string): Promise<string> {
    const existing = await this.accountOfTransfer(transferId);
    if (existing) return existing;
    const accountId = await this.pickBucket();
    await this.db
      .prepare(`INSERT OR IGNORE INTO transfer_account (transfer_id, account_id) VALUES (?, ?)`)
      .bind(transferId, accountId)
      .run();
    return accountId;
  }

  private async pickBucket(): Promise<string> {
    // 纯 KV：清单为空 / 无可用桶时直接抛错，绝不回退 default
    try {
      const listRaw = this.kv ? await this.kv.get('quota:buckets') : null;
      const buckets: string[] = listRaw ? (JSON.parse(listRaw) as string[]) : [];
      let best = '';
      let bestRemain = -1;
      for (const acc of buckets) {
        const enabled = this.kv ? (await this.kv.get(`quota:${acc}:enabled`)) ?? 'true' : 'true';
        if (enabled === 'false') continue;
        const limit = Number(
          this.kv ? (await this.kv.get(`quota:${acc}:limit_bytes`)) ?? '10737418240' : '10737418240',
        );
        const row = await this.db
          .prepare(`SELECT used_bytes FROM quota_account WHERE account_id = ?`)
          .bind(acc)
          .first<{ used_bytes: number }>();
        const used = row?.used_bytes ?? 0;
        const remain = limit - used;
        if (remain > bestRemain) {
          bestRemain = remain;
          best = acc;
        }
      }
      if (!best) throw new Error('未配置存储桶：请先在管理后台接入桶');
      return best;
    } catch {
      throw new Error('未配置存储桶：请先在管理后台接入桶');
    }
  }
}
