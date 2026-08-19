// 存储桶路由：把传输/文件路由到正确的后端 R2 存储桶（多 Cloudflare 账户 / 多桶）。
// 设计：共享的 tus-handler / download-handler / transfer-handler 不在内部感知桶，
// 而是在 index.ts 按 传输→account_id 解析出对应 R2StorageBackend 再构造，从而零改动共享代码。
//
// 凭据策略（用户 2026-08-19 决定）：默认走仓库写法——桶绑定 + 凭证写在 wrangler.toml
// （R2_TRANSFERS 为默认桶；接第二桶加 R2_TRANSFERS_B 绑定与 *_B 变量）。KV 仅作
// 规则卡(limit/enabled)与可选 bucket_cfg 覆盖层（保留自服务接口，纯跨账户无绑定场景待后续 S3 后端）。

import { R2StorageBackend } from './r2-storage';
import type { StorageBackend } from '../../src/transfer/tus/types';

export interface ResolverEnv {
  R2_TRANSFERS?: R2Bucket;
  R2_TRANSFERS_B?: R2Bucket;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID_B?: string;
  R2_ACCESS_KEY_ID_B?: string;
  R2_SECRET_ACCESS_KEY_B?: string;
}

export interface StorageResolver {
  resolve(accountId: string): Promise<StorageBackend>;
}

interface BucketCfg {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  binding?: string;
}

/** 仓库绑定解析：default 始终可用；secondary 在配置了 R2_TRANSFERS_B + 凭证时可用。 */
export class RepoStorageResolver implements StorageResolver {
  private readonly repo = new Map<string, () => R2StorageBackend>();

  constructor(env: ResolverEnv) {
    if (env.R2_TRANSFERS && env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
      const e = env;
      this.repo.set('default', () =>
        new R2StorageBackend(e.R2_TRANSFERS!, {
          accountId: e.R2_ACCOUNT_ID!,
          accessKeyId: e.R2_ACCESS_KEY_ID!,
          secretAccessKey: e.R2_SECRET_ACCESS_KEY!,
          bucketName: 'flashdrop-transfers',
        }),
      );
    }
    if (env.R2_TRANSFERS_B && env.R2_ACCOUNT_ID_B && env.R2_ACCESS_KEY_ID_B && env.R2_SECRET_ACCESS_KEY_B) {
      const e = env;
      this.repo.set('secondary', () =>
        new R2StorageBackend(e.R2_TRANSFERS_B!, {
          accountId: e.R2_ACCOUNT_ID_B!,
          accessKeyId: e.R2_ACCESS_KEY_ID_B!,
          secretAccessKey: e.R2_SECRET_ACCESS_KEY_B!,
          bucketName: 'flashdrop-transfers-b',
        }),
      );
    }
  }

  async resolve(accountId: string): Promise<StorageBackend> {
    const factory = this.repo.get(accountId);
    if (factory) return factory();
    const def = this.repo.get('default');
    if (def) return def();
    throw new Error(`未配置存储桶: ${accountId}`);
  }
}

/** 组合解析：优先 KV bucket_cfg 覆盖（保留自服务接口），否则回退仓库绑定。 */
export function createStorageResolver(env: ResolverEnv, kv?: KVNamespace): StorageResolver {
  const repo = new RepoStorageResolver(env);
  return {
    async resolve(accountId: string): Promise<StorageBackend> {
      if (kv) {
        const cfg = (await kv.get(`quota:${accountId}:bucket_cfg`, 'json')) as BucketCfg | null;
        if (cfg?.bucketName && cfg?.accountId && cfg?.accessKeyId && cfg?.secretAccessKey) {
          const bucket = (
            cfg.binding ? (env as Record<string, unknown>)[cfg.binding] : env.R2_TRANSFERS
          ) as R2Bucket | undefined;
          if (bucket) return new R2StorageBackend(bucket, cfg);
        }
      }
      return repo.resolve(accountId);
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
    try {
      const listRaw = this.kv ? await this.kv.get('quota:buckets') : null;
      const buckets: string[] = listRaw ? (JSON.parse(listRaw) as string[]) : ['default'];
      let best = 'default';
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
      return best;
    } catch {
      return 'default';
    }
  }
}
