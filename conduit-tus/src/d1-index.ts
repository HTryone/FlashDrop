// 云端目录本：基于 Cloudflare D1 绑定（Worker 运行时原生 D1Database）。
// 设计原则（用户 2026-08-02「一律线上数据库」）：索引默认落 D1，强一致、可查询、去单点。
// 旧版本地文件实现（FileIndexBackend）作为可插拔备选，不在默认路径，留待后续研究。

import { IndexBackend, TransferRecord, FileRecord, TransferError } from '../../src/transfer/tus/types';

interface TransferRow {
  id: string;
  message: string;
  created_at: number;
  expires_at: number;
  terminated: number;
  code: string | null;
  login_code: string | null;
  e2ee_salt: string | null;
  e2ee_chunk_size: number | null;
}

interface FileRow {
  id: string;
  transfer_id: string;
  filename: string;
  relative_path: string;
  size: number;
  storage: string;
  offset: number;
}

export class D1IndexBackend implements IndexBackend {
  readonly kind = 'd1' as const;

  constructor(private readonly db: D1Database) {}

  async createTransfer(t: TransferRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO transfers
           (id, message, created_at, expires_at, terminated, code, login_code, e2ee_salt, e2ee_chunk_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        t.id,
        t.message,
        t.createdAt,
        t.expiresAt,
        t.terminated ? 1 : 0,
        t.code || null,
        t.loginCode || null,
        t.e2ee?.salt ?? null,
        t.e2ee?.chunkSize ?? null,
      )
      .run();
    if (t.code) await this.setCode(t.id, t.code);
    if (t.loginCode) await this.setLoginCode(t.id, t.loginCode);
  }

  async getTransfer(id: string): Promise<TransferRecord | null> {
    const row = (await this.db
      .prepare(`SELECT * FROM transfers WHERE id = ?`)
      .bind(id)
      .first<TransferRow>()) as TransferRow | null;
    if (!row) return null;
    const files = await this.listFiles(id);
    return this.rowToTransfer(row, files);
  }

  async addFile(id: string, f: FileRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO files (id, transfer_id, filename, relative_path, size, storage, offset)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(f.id, id, f.filename, f.relativePath, f.size, f.storage, f.offset ?? 0)
      .run();
  }

  async getFile(id: string): Promise<FileRecord | null> {
    const f = (await this.db
      .prepare(`SELECT * FROM files WHERE id = ?`)
      .bind(id)
      .first<FileRow>()) as FileRow | null;
    if (!f) return null;
    return {
      id: f.id,
      transferId: f.transfer_id,
      filename: f.filename,
      relativePath: f.relative_path,
      size: f.size,
      storage: f.storage as FileRecord['storage'],
      offset: f.offset,
    };
  }

  async resolveCode(code: string): Promise<string | null> {
    const r = (await this.db
      .prepare(`SELECT transfer_id FROM codes WHERE code = ?`)
      .bind(code)
      .first<{ transfer_id: string }>()) as { transfer_id: string } | null;
    return r?.transfer_id ?? null;
  }

  async resolveLogin(loginCode: string): Promise<string | null> {
    const r = (await this.db
      .prepare(`SELECT transfer_id FROM login_codes WHERE login_code = ?`)
      .bind(loginCode)
      .first<{ transfer_id: string }>()) as { transfer_id: string } | null;
    return r?.transfer_id ?? null;
  }

  async setCode(id: string, code: string): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO codes (code, transfer_id) VALUES (?, ?)`)
      .bind(code, id)
      .run();
  }

  async setLoginCode(id: string, loginCode: string): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO login_codes (login_code, transfer_id) VALUES (?, ?)`)
      .bind(loginCode, id)
      .run();
  }

  async listFiles(id: string): Promise<FileRecord[]> {
    const r = (await this.db
      .prepare(`SELECT * FROM files WHERE transfer_id = ? ORDER BY relative_path`)
      .bind(id)
      .all<FileRow>()) as D1Result<FileRow>;
    return (r.results ?? []).map((f) => ({
      id: f.id,
      filename: f.filename,
      relativePath: f.relative_path,
      size: f.size,
      storage: f.storage as FileRecord['storage'],
      offset: f.offset,
    }));
  }

  async updateOffset(id: string, offset: number): Promise<void> {
    await this.db
      .prepare(`UPDATE files SET offset = ? WHERE id = ?`)
      .bind(offset, id)
      .run();
  }

  async isExpired(id: string): Promise<boolean> {
    const row = (await this.db
      .prepare(`SELECT expires_at, terminated FROM transfers WHERE id = ?`)
      .bind(id)
      .first<{ expires_at: number; terminated: number }>()) as
      | { expires_at: number; terminated: number }
      | null;
    if (!row) return true;
    return row.terminated === 1 || row.expires_at < Date.now();
  }

  async terminate(id: string): Promise<void> {
    await this.db
      .prepare(`UPDATE transfers SET terminated = 1 WHERE id = ?`)
      .bind(id)
      .run();
  }

  async deleteTransfer(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM files WHERE transfer_id = ?`).bind(id).run();
    await this.db.prepare(`DELETE FROM codes WHERE transfer_id = ?`).bind(id).run();
    await this.db.prepare(`DELETE FROM login_codes WHERE transfer_id = ?`).bind(id).run();
    await this.db.prepare(`DELETE FROM transfers WHERE id = ?`).bind(id).run();
  }

  private rowToTransfer(row: TransferRow, files: FileRecord[]): TransferRecord {
    return {
      id: row.id,
      message: row.message,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      terminated: row.terminated === 1,
      code: row.code ?? '',
      loginCode: row.login_code ?? '',
      e2ee:
        row.e2ee_salt && row.e2ee_chunk_size
          ? { salt: row.e2ee_salt, chunkSize: row.e2ee_chunk_size }
          : null,
      files,
    };
  }
}
