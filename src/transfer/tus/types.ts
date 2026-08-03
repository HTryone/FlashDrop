// 中转核心：存储与索引的可插拔抽象（与具体云厂商解耦）
// 设计原则（用户 2026-08-02）：VUE 只做 UI 壳，核心逻辑用 TS；
// 文件柜 / 目录本都抽象为接口，主逻辑只认接口不认实现，方便后续接 R2 / 本地 / 腾讯云 / D1。

/** 文件柜后端：负责文件体（密文）的持久化与范围读取（断点续传）。 */
export interface StorageBackend {
  readonly kind: 'r2' | 'local' | 's3';
  /** 存：把可读字节流写入指定 key。实现不得把整个文件缓冲进内存。 */
  put(key: string, body: ReadableStream<Uint8Array>, size: number): Promise<void>;
  /** 取：按 key 取范围数据；range 省略表示全量。返回流式，调用方负责 pipe。 */
  get(
    key: string,
    range?: { start: number; end?: number }
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; contentRange?: string }>;
  /** 删 */
  delete(key: string): Promise<void>;
  /** 是否存在 */
  exists(key: string): Promise<boolean>;
  /** 列：按前缀列出对象。用于 tus 分片下载前拼接所有 part。 */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** 预签名直传：返回浏览器可直传 R2 的临时 URL（仅 R2 后端实现，绕过 Worker 大流 pipe）。 */
  createPresignedUrl(
    key: string,
    opts?: { method?: string; expiresIn?: number },
  ): Promise<string>;
}

/** 单文件记录（挂在某个 transfer 下）。 */
export interface FileRecord {
  id: string;
  transferId?: string;
  filename: string;
  relativePath: string;
  size: number;
  storage: StorageBackend['kind'];
  /** 已上传偏移量（D1 记录，替代 R2 list 汇总）。新建文件时默认 0。 */
  offset?: number;
}

/** 一次传输（一个分享码对应的一批文件）。 */
export interface TransferRecord {
  id: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  terminated: boolean;
  code: string;
  loginCode: string;
  e2ee: { salt: string; chunkSize: number } | null;
  files: FileRecord[];
}

/** 目录本后端：负责传输元数据 / 分享码 / 登录码的读写与查询。 */
export interface IndexBackend {
  readonly kind: 'file' | 'd1' | 'kv' | 'redis';
  createTransfer(t: TransferRecord): Promise<void>;
  getTransfer(id: string): Promise<TransferRecord | null>;
  addFile(id: string, f: FileRecord): Promise<void>;
  getFile(id: string): Promise<FileRecord | null>;
  /** 分享码 -> transferId */
  resolveCode(code: string): Promise<string | null>;
  /** 登录码 -> transferId */
  resolveLogin(loginCode: string): Promise<string | null>;
  setCode(id: string, code: string): Promise<void>;
  setLoginCode(id: string, loginCode: string): Promise<void>;
  listFiles(id: string): Promise<FileRecord[]>;
  /** 更新文件已上传偏移量（PATCH 成功写 R2 后调用）。 */
  updateOffset(id: string, offset: number): Promise<void>;
  isExpired(id: string): Promise<boolean>;
  terminate(id: string): Promise<void>;
  deleteTransfer(id: string): Promise<void>;
}

/** 清理器：定期删除过期文件体与索引，避免无限堆积。 */
export interface Sweeper {
  readonly kind: string;
  sweep(): Promise<{ removedFiles: number; removedTransfers: number }>;
}

/** 中转核心错误：统一错误类型，便于上层（Vue / Worker / Node）区分处理。 */
export class TransferError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'EXPIRED' | 'TERMINATED' | 'STORAGE' | 'INDEX',
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TransferError';
  }
}
