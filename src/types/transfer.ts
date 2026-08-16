// 闪云 ArkPulse 核心类型定义

/** 单个待传文件（发送侧） */
export interface QueuedFile {
  /** 浏览器 File 对象 */
  file: File;
  /** 相对路径（文件夹场景下的子路径，单文件则为文件名） */
  relativePath: string;
  /** 上传状态 */
  status: 'pending' | 'uploading' | 'done' | 'error';
  /** 已上传字节数 */
  uploaded: number;
  /** 错误文案 */
  error?: string;
  /** tus 文件 ID（创建/重传复用，避免接收端列表出现重复文件） */
  fileId?: string;
  /** tus 实例（运行时） */
  _upload?: any;
}

/** 接收侧的文件项 */
export interface ReceivedFile {
  id: string;
  name: string;
  size: number;
}

/** 创建传输的服务端返回 */
export interface CreateTransferResp {
  transferId: string;
  code: string;
  loginCode: string;        // 16 位发送者登录码（带空格：XXXX XXXX XXXX XXXX）
  expiresAt: number;         // 过期时间戳
  storage: 'local' | 'r2';
  e2ee: { salt: string; chunkSize: number } | null;
}

/** 端到端加密元数据 */
export interface E2EEMeta {
  salt: string;
  chunkSize: number;
}

/** 按分享码获取的传输详情 */
export interface TransferDetail {
  transferId: string;
  message: string;
  storage: 'local' | 'r2';
  e2ee: E2EEMeta | null;
  expiresAt: number;
  files: ReceivedFile[];
}

/** 登录码查看的完整传输信息（含管理权限） */
export interface LoginTransferDetail {
  transferId: string;
  message: string;
  code: string;
  loginCode: string;
  expired: boolean;
  terminated: boolean;
  expiresAt: number;
  createdAt: number;
  storage: 'local' | 'r2';
  e2ee: E2EEMeta | null;
  files: ReceivedFile[];
  totalSize: number;
}

/** 存储类型（本地磁盘 / 线上 R2） */
export type StorageType = 'local' | 'r2';

/** 端到端加密配置 */
export interface E2EEConfig {
  enabled: boolean;
  /** 口令（分享码 + 口令 派生密钥） */
  passphrase: string;
}
