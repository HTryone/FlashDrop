// 配额守卫：按「未过期文件实时占用」结算的后端硬限制。
// 每存储桶(account_id)独立额度；文件级过期标记(released)驱动回收；并发靠 D1 原子 UPDATE 保证不丢账。
//
// 锚点修正（基于真实代码）：quota_file 以 fileId 为主键，而 fileId 由共享的 tus-handler.createUpload
// 内部生成，门卫①在 POST /files 时尚不可知 → 真正「原子预扣 + 写锚点」发生在首个 presign
// （此时 fileId 已知）；POST /files 仅做即时预检（precheck）。两者配合即文档中的「门卫① + 门卫②」。

import { BucketSelector } from './storage-router';

const DEFAULT_LIMIT = 10 * 1024 * 1024 * 1024; // 10GB

export interface ReserveInput {
  fileId: string;
  transferId: string;
  size: number;
  expiresAt: number;
}

export interface BucketHealth {
  status: 'normal' | 'unconfigured' | 'error';
  last_write_ts: number;
  last_check_ts: number;
  creds_valid: boolean;
  lifecycle_ok: boolean;
}

export interface BucketStatus {
  account_id: string;
  enabled: boolean;
  limit_bytes: number;
  used_bytes: number;
  remaining: number;
  file_count: number;
  bucket_name: string;
  health: BucketHealth;
}

export class QuotaGuard {
  constructor(
    private readonly kv: KVNamespace | undefined,
    private readonly db: D1Database,
    private readonly selector: BucketSelector,
  ) {}

  /** 传输已记录的归属桶；无记录返回 default。 */
  async accountOfTransfer(transferId: string): Promise<string> {
    return (await this.selector.accountOfTransfer(transferId)) ?? 'default';
  }

  // ---- 门卫①预检：POST /files 即时判断（此时无 fileId，只比较，不扣账）----
  async precheck(transferId: string, size: number): Promise<boolean> {
    try {
      const accountId = await this.selector.select(transferId);
      const limit = await this.limitOf(accountId);
      const used = await this.usedOf(accountId);
      return used + size <= limit;
    } catch {
      return true; // KV/DB 异常放行，不阻断正常上传
    }
  }

  // ---- 门卫①+②原子预扣：首个 presign 调用，幂等；false = 超限拒绝 ----
  async reserve(input: ReserveInput): Promise<boolean> {
    const { fileId, transferId, size, expiresAt } = input;
    const accountId = await this.selector.select(transferId);
    const enabled = this.kv ? (await this.kv.get(`quota:${accountId}:enabled`)) ?? 'true' : 'true';
    if (enabled === 'false') return true; // 紧急放行：不记账、不扣额

    const limit = await this.limitOf(accountId);

    // 幂等锚点：同 fileId 只插一次（并发同文件：一插一忽略，恰好一次扣账）
    const ins = await this.db
      .prepare(
        `INSERT OR IGNORE INTO quota_file (file_id, account_id, transfer_id, size, expires_at, released)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .bind(fileId, accountId, transferId, size, expiresAt)
      .run();
    if (((ins.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) return true;

    // 确保计数器行存在
    await this.db
      .prepare(`INSERT OR IGNORE INTO quota_account (account_id, used_bytes, updated_at) VALUES (?, 0, ?)`)
      .bind(accountId, Date.now())
      .run();

    // 原子预扣：超则返回空行
    const upd = await this.db
      .prepare(
        `UPDATE quota_account SET used_bytes = used_bytes + ?, updated_at = ?
         WHERE account_id = ? AND used_bytes + ? <= ? RETURNING used_bytes`,
      )
      .bind(size, Date.now(), accountId, size, limit)
      .first<{ used_bytes: number }>();

    if (!upd) {
      // 超限：撤回刚插入的锚点（避免悬空 released=0 行干扰回收）
      await this.db.prepare(`DELETE FROM quota_file WHERE file_id = ? AND released = 0`).bind(fileId).run();
      return false;
    }

    if (this.kv) {
      await this.kv.put(`quota:${accountId}:last_write_ts`, String(Date.now())).catch(() => {});
    }
    return true;
  }

  // ---- 门卫②复查：签名前比较（不扣账）----
  async checkAllowed(accountId: string): Promise<boolean> {
    try {
      const limit = await this.limitOf(accountId);
      const used = await this.usedOf(accountId);
      return used <= limit;
    } catch {
      return true;
    }
  }

  // ---- 主动终止/清空：释放某传输全部文件的额度 ----
  async releaseByTransfer(transferId: string): Promise<void> {
    const accountId = await this.selector.accountOfTransfer(transferId);
    if (!accountId) return;
    const rows = await this.db
      .prepare(`UPDATE quota_file SET released = 1 WHERE released = 0 AND transfer_id = ? RETURNING size`)
      .bind(transferId)
      .all<{ size: number }>();
    let delta = 0;
    for (const r of rows.results ?? []) delta += r.size;
    if (delta > 0) {
      await this.db
        .prepare(`UPDATE quota_account SET used_bytes = MAX(0, used_bytes - ?) WHERE account_id = ?`)
        .bind(delta, accountId)
        .run();
    }
  }

  // ---- 过期清扫回收：标记 released=1 并按桶减计数器（幂等）----
  async releaseExpired(now: number): Promise<number> {
    const rows = await this.db
      .prepare(`UPDATE quota_file SET released = 1 WHERE released = 0 AND expires_at < ? RETURNING account_id, size`)
      .bind(now)
      .all<{ account_id: string; size: number }>();
    const byAcc = new Map<string, number>();
    for (const r of rows.results ?? []) byAcc.set(r.account_id, (byAcc.get(r.account_id) ?? 0) + r.size);
    for (const [acc, delta] of byAcc) {
      await this.db
        .prepare(`UPDATE quota_account SET used_bytes = MAX(0, used_bytes - ?) WHERE account_id = ?`)
        .bind(delta, acc)
        .run();
    }
    return byAcc.size;
  }

  async releaseByTransfers(transferIds: string[]): Promise<void> {
    for (const id of transferIds) await this.releaseByTransfer(id);
  }

  // ---- 守恒自修复：按 quota_file 重新聚合某桶 used_bytes ----
  async recompute(accountId: string): Promise<number> {
    const sum = await this.db
      .prepare(`SELECT COALESCE(SUM(size), 0) AS s FROM quota_file WHERE account_id = ? AND released = 0`)
      .bind(accountId)
      .first<{ s: number }>();
    const total = sum?.s ?? 0;
    await this.db
      .prepare(`INSERT OR IGNORE INTO quota_account (account_id, used_bytes, updated_at) VALUES (?, 0, ?)`)
      .bind(accountId, Date.now())
      .run();
    await this.db
      .prepare(`UPDATE quota_account SET used_bytes = ?, updated_at = ? WHERE account_id = ?`)
      .bind(total, Date.now(), accountId)
      .run();
    return total;
  }

  // ---- 清零某桶账本（保留账号记录）----
  async resetBucket(accountId: string): Promise<void> {
    await this.db.prepare(`UPDATE quota_file SET released = 1 WHERE account_id = ?`).bind(accountId).run();
    await this.db
      .prepare(`INSERT OR IGNORE INTO quota_account (account_id, used_bytes, updated_at) VALUES (?, 0, ?)`)
      .bind(accountId, Date.now())
      .run();
    await this.db.prepare(`UPDATE quota_account SET used_bytes = 0, updated_at = ? WHERE account_id = ?`).bind(Date.now(), accountId).run();
  }

  // ---- 控制页状态：每桶占用/健康度 ----
  async status(): Promise<BucketStatus[]> {
    const listRaw = this.kv ? await this.kv.get('quota:buckets') : null;
    const buckets: string[] = listRaw ? (JSON.parse(listRaw) as string[]) : ['default'];
    const out: BucketStatus[] = [];
    for (const acc of buckets) {
      const enabledRaw = this.kv ? (await this.kv.get(`quota:${acc}:enabled`)) ?? 'true' : 'true';
      const enabled = enabledRaw !== 'false';
      const limit = await this.limitOf(acc);
      const used = await this.usedOf(acc);
      const cnt = await this.db
        .prepare(`SELECT COUNT(*) AS c FROM quota_file WHERE account_id = ? AND released = 0`)
        .bind(acc)
        .first<{ c: number }>();
      const cfgRaw = this.kv ? await this.kv.get(`quota:${acc}:bucket_cfg`) : null;
      const lastWriteRaw = this.kv ? await this.kv.get(`quota:${acc}:last_write_ts`) : null;
      const healthRaw = this.kv ? await this.kv.get(`quota:${acc}:health`) : null;
      const h: {
        status?: 'normal' | 'unconfigured' | 'error';
        last_check_ts?: number;
        creds_valid?: boolean;
        lifecycle_ok?: boolean;
      } | null = healthRaw ? JSON.parse(healthRaw) : null;
      const row = await this.db
        .prepare(`SELECT used_bytes FROM quota_account WHERE account_id = ?`)
        .bind(acc)
        .first<{ used_bytes: number }>();
      out.push({
        account_id: acc,
        enabled,
        limit_bytes: limit,
        used_bytes: used,
        remaining: Math.max(0, limit - used),
        file_count: cnt?.c ?? 0,
        bucket_name:
          acc === 'default'
            ? 'flashdrop-transfers'
            : (cfgRaw ? '（KV 配置）' : 'flashdrop-transfers-b'),
        health: {
          status: h?.status ?? (row ? 'normal' : 'unconfigured'),
          last_write_ts: lastWriteRaw ? Number(lastWriteRaw) : 0,
          last_check_ts: h?.last_check_ts ?? 0,
          creds_valid: h?.creds_valid ?? enabled,
          lifecycle_ok: h?.lifecycle_ok ?? true,
        },
      });
    }
    return out;
  }

  private async limitOf(accountId: string): Promise<number> {
    if (!this.kv) return DEFAULT_LIMIT;
    const v = await this.kv.get(`quota:${accountId}:limit_bytes`);
    return v ? Number(v) : DEFAULT_LIMIT;
  }

  private async usedOf(accountId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT used_bytes FROM quota_account WHERE account_id = ?`)
      .bind(accountId)
      .first<{ used_bytes: number }>();
    return row?.used_bytes ?? 0;
  }
}
