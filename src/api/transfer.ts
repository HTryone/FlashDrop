// 传输相关 API：创建传输 / 刷新码 / 留言 / 列表 / 清空 / 登录 / 终止
import { apiGet, apiPost, apiPatch, apiDelete } from './client';
import type { CreateTransferResp, TransferDetail, LoginTransferDetail } from '@/types/transfer';

/** 创建传输并分配分享码 + 登录码（可带初始留言 / E2EE 元数据） */
export function createTransfer(
  transferId: string,
  message = '',
  e2ee: { salt: string; chunkSize: number } | null = null,
  ttlHours = 0,
): Promise<CreateTransferResp> {
  return apiPost<CreateTransferResp>('/api/transfers', { transferId, message, e2ee, ttlHours });
}

/** 刷新分享码（旧码作废） */
export function refreshCode(transferId: string): Promise<{ code: string }> {
  return apiPost<{ code: string }>(`/api/transfers/${encodeURIComponent(transferId)}/refresh`);
}

/** 更新留言 */
export function setMessage(transferId: string, message: string): Promise<{ message: string }> {
  return apiPatch<{ message: string }>(`/api/transfers/${encodeURIComponent(transferId)}`, { message });
}

/** 按分享码获取传输详情 */
export function getTransfer(code: string): Promise<TransferDetail> {
  return apiGet<TransferDetail>(`/api/transfer/${encodeURIComponent(code)}`);
}

/** 用登录码查看自己的传输（含管理权限） */
export function getLoginTransfer(loginCode: string): Promise<LoginTransferDetail> {
  return apiGet<LoginTransferDetail>(`/api/login/${encodeURIComponent(loginCode)}`);
}

/** 提前终止传输（作废分享码 + 登录码） */
export function terminateTransfer(transferId: string): Promise<{ ok: boolean; message: string }> {
  return apiPost<{ ok: boolean; message: string }>(`/api/transfers/${encodeURIComponent(transferId)}/terminate`);
}

/** 清空某个传输（删除文件 + 索引 + 分享码 + 登录码） */
export function clearTransfer(transferId: string): Promise<void> {
  return apiDelete(`/api/transfers/${encodeURIComponent(transferId)}`);
}

/** 单文件下载地址 */
export function fileUrl(code: string, fileId: string): string {
  return `/download/${encodeURIComponent(code)}/${encodeURIComponent(fileId)}`;
}

/** 打包 zip 下载地址 */
export function zipUrl(code: string): string {
  return `/download/${encodeURIComponent(code)}/zip`;
}
