// D1（线上数据库）建表语句。中转索引本的结构化定义，强一致 SQL。
// 与旧版本地 index.json 一一对应：transfers（传输元数据）/ files（文件指针）/ codes（分享码反查）/ login_codes（登录码反查）。

export const D1_SCHEMA = `
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
  storage      TEXT NOT NULL
);
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
`;
