// 传输相关 API：创建传输 / 刷新码 / 留言 / 列表 / 清空 / 登录 / 终止
import { apiGet, apiPost, apiPatch, apiDelete } from './client';
import type { CreateTransferResp, TransferDetail, LoginTransferDetail } from '@/types/transfer';
import { resolveTusBase } from '@/transfer/room';

// 中转模式所有请求打到 tus Worker 绝对地址。纯静态 Pages 不会把 /api、/download
// 路由到 Worker，相对路径请求会被 Pages 静态托管拦截（POST 返回 405）。
// 沿用 relay 的覆盖模式，可用 VITE_TUS_URL 指定本地联调地址。
const tusApi = (path: string) => `${resolveTusBase()}${path}`;

/** 创建传输并分配分享码 + 登录码（可带初始留言 / E2EE 元数据） */
export function createTransfer(
  transferId: string,
  message = '',
  e2ee: { salt: string; chunkSize: number } | null = null,
  ttlHours = 0,
): Promise<CreateTransferResp> {
  return apiPost<CreateTransferResp>(tusApi('/api/transfers'), { transferId, message, e2ee, ttlHours });
}

/** 刷新分享码（旧码作废） */
export function refreshCode(transferId: string): Promise<{ code: string }> {
  return apiPost<{ code: string }>(tusApi(`/api/transfers/${encodeURIComponent(transferId)}/refresh`));
}

/** 更新留言 */
export function setMessage(transferId: string, message: string): Promise<{ message: string }> {
  return apiPatch<{ message: string }>(tusApi(`/api/transfers/${encodeURIComponent(transferId)}`), { message });
}

/** 按分享码获取传输详情 */
export function getTransfer(code: string): Promise<TransferDetail> {
  return apiGet<TransferDetail>(tusApi(`/api/transfer/${encodeURIComponent(code)}`));
}

/** 用登录码查看自己的传输（含管理权限） */
export function getLoginTransfer(loginCode: string): Promise<LoginTransferDetail> {
  return apiGet<LoginTransferDetail>(tusApi(`/api/login/${encodeURIComponent(loginCode)}`));
}

/** 提前终止传输（作废分享码 + 登录码） */
export function terminateTransfer(transferId: string): Promise<{ ok: boolean; message: string }> {
  return apiPost<{ ok: boolean; message: string }>(tusApi(`/api/transfers/${encodeURIComponent(transferId)}/terminate`));
}

/** 清空某个传输（删除文件 + 索引 + 分享码 + 登录码） */
export function clearTransfer(transferId: string): Promise<void> {
  return apiDelete(tusApi(`/api/transfers/${encodeURIComponent(transferId)}`));
}

/** 仅清空传输下的文件（删除 D1 文件行 + R2 分片，保留分享码/登录码/传输记录），用于重传前清掉失效旧文件 */
export function clearTransferFiles(transferId: string): Promise<void> {
  return apiDelete(tusApi(`/api/transfers/${encodeURIComponent(transferId)}/files`));
}

/** 单文件下载地址（绝对地址，指向 tus Worker） */
export function fileUrl(code: string, fileId: string): string {
  return tusApi(`/download/${encodeURIComponent(code)}/${encodeURIComponent(fileId)}`);
}

/** 打包 zip 下载地址（绝对地址，指向 tus Worker） */
export function zipUrl(code: string): string {
  return tusApi(`/download/${encodeURIComponent(code)}/zip`);
}
