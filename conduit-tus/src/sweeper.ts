// 云清理器：定期清过期，避免文件体与索引无限堆积。
// 设计原则（回应用户关于"过期是否删除"的疑问）：
//   - R2 文件体：交桶生命周期规则自动过期（零常驻负担），本类只负责 D1 过期记录清理。
//   - D1 索引：一条 DELETE 按 expires_at 划掉所有过期传输及其文件指针 / 分享码 / 登录码。
// 注意：R2 生命周期规则需在 wrangler.toml 或 R2 控制台配置（见 deploy 说明），不在代码内。

import { Sweeper, IndexBackend, StorageBackend, TransferError } from '../../src/transfer/tus/types';
import { QuotaGuard } from './quota';
import type { StorageResolver } from './storage-router';

export class CloudSweeper implements Sweeper {
  readonly kind = 'cloud' as const;

  constructor(
    private readonly index: IndexBackend,
    private readonly storage?: StorageBackend,
    private readonly now: () => number = Date.now,
    private readonly quota?: QuotaGuard,
    private readonly resolver?: StorageResolver,
  ) {}

  async sweep(): Promise<{ removedFiles: number; removedTransfers: number }> {
    if (this.index.kind !== 'd1') {
      throw new TransferError('INDEX', 'CloudSweeper 仅支持 D1 索引清理');
    }
    const db = (this.index as unknown as { db: D1Database }).db;
    const cutoff = this.now();

    // 取过期传输 id
    const expired = (await db
      .prepare(
        `SELECT t.id, f.id AS file_id
         FROM transfers t LEFT JOIN files f ON f.transfer_id = t.id
         WHERE t.expires_at < ? OR t.terminated = 1`,
      )
      .bind(cutoff)
      .all<{ id: string; file_id: string | null }>()) as D1Result<{
      id: string;
      file_id: string | null;
    }>;

    const transferIds = new Set<string>();
    let removedFiles = 0;
    for (const row of expired.results ?? []) {
      transferIds.add(row.id);
      if (row.file_id) {
        try {
          // 全 KV 化：按传输归属桶解析后端再删（多桶正确删除，不再固定默认桶）
          let st: StorageBackend | undefined;
          if (this.resolver && this.quota) {
            const acc = await this.quota.accountOfTransfer(row.id);
            if (acc) st = await this.resolver.resolve(acc);
          }
          st = st ?? this.storage;
          if (st) {
            await st.delete(row.file_id);
            removedFiles++;
          }
        } catch {
          // 文件体可能已被 R2 生命周期规则先行删掉，忽略
        }
      }
    }

    if (this.quota) {
      try {
        await this.quota.releaseByTransfers([...transferIds]);
      } catch (e) {
        console.error('[arkpulse-tus] quota release failed', e);
      }
    }

    for (const tid of transferIds) {
      await this.index.deleteTransfer(tid);
    }

    // 配额账本清理（否则 quota_file / transfer_account 无限增长）：
    // - quota_file：清掉已释放（released=1）的明细行；释放逻辑只标记不删除。
    // - transfer_account：清掉已不存在传输的归属行（传输已被上方 deleteTransfer 移除）。
    // - quota_account 按桶一条、数量有限，保留作账本。
    try {
      await db.prepare(`DELETE FROM quota_file WHERE released = 1`).run();
      await db
        .prepare(`DELETE FROM transfer_account WHERE transfer_id NOT IN (SELECT id FROM transfers)`)
        .run();
    } catch (e) {
      console.error('[arkpulse-tus] quota table cleanup failed', e);
    }

    return { removedFiles, removedTransfers: transferIds.size };
  }
}
