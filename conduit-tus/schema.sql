CREATE TABLE IF NOT EXISTS transfers (
  id             TEXT PRIMARY KEY,
  message        TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  terminated     INTEGER NOT NULL DEFAULT 0,
  code           TEXT,
  login_code     TEXT,
  e2ee_salt      TEXT,
  e2ee_chunk_size INTEGER
);
CREATE TABLE IF NOT EXISTS files (
  id           TEXT PRIMARY KEY,
  transfer_id  TEXT NOT NULL,
  filename     TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size         INTEGER NOT NULL,
  storage      TEXT NOT NULL,
  offset       INTEGER NOT NULL DEFAULT 0
);
-- 迁移：已有 files 表加 offset 列（首次执行会成功，重复执行报错可忽略）
-- ALTER TABLE files ADD COLUMN offset INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS codes (
  code        TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_codes (
  login_code   TEXT PRIMARY KEY,
  transfer_id  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_transfer   ON files(transfer_id);
CREATE INDEX IF NOT EXISTS idx_codes_transfer    ON codes(transfer_id);
CREATE INDEX IF NOT EXISTS idx_login_transfer    ON login_codes(transfer_id);

-- ===== 配额控制（按未过期文件实时占用，多存储桶隔离）=====
-- 每存储桶实时占用计数器：门卫判断与原子预扣的唯一入口（account_id = 后端 R2 桶/Cloudflare 账户标识）
CREATE TABLE IF NOT EXISTS quota_account (
  account_id  TEXT PRIMARY KEY,
  used_bytes  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
-- 传输→存储桶归属映射：创建传输时由 BucketSelector 选定后写入
CREATE TABLE IF NOT EXISTS transfer_account (
  transfer_id TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL
);
-- 文件级占用明细 + 文件级过期标记（清理任务据此回收额度与空间）
CREATE TABLE IF NOT EXISTS quota_file (
  file_id     TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  size        INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  released    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_qf_acct ON quota_file(account_id, released, expires_at);
