// P2P / HTTP 公共库：房间码生成与 relay 基址解析。
// 发送端与接收端、两种直传方式（HTTP 中继 / P2P 直连）共用同一套房间码与口令体系，
// 保证用户复制的同一个房间码在两种通道下都能对齐（P2P 走 `${room}::p2p` 命名空间，与 HTTP 互不冲突）。

export const RELAY_DEFAULT = 'arkpulse-relay.315461.xyz';

/** 解析 relay 基址：默认线上 relay，可用 VITE_RELAY_URL 覆盖（本地联调） */
export function resolveRelayBase(): string {
  const host = (import.meta as any).env?.VITE_RELAY_URL || RELAY_DEFAULT;
  return `https://${host}`;
}

export const TUS_DEFAULT = 'arkpulse-tus.315461.xyz';

/** 解析 tus 中转 Worker 基址：默认线上 tus Worker，
 *  可用 VITE_TUS_URL 覆盖（如本地联调设为 http://localhost:3000）。
 *  注意：前端“中转模式”必须指向 tus Worker 绝对地址，不能写相对 /files ——
 *  纯静态 Pages 不会把 /files 路由到 Worker，相对路径上传会永远到不了后端。 */
export function resolveTusBase(): string {
  const host = (import.meta as any).env?.VITE_TUS_URL || TUS_DEFAULT;
  return host.startsWith('http') ? host.replace(/\/+$/, '') : `https://${host}`;
}

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 生成 6 位房间码（去掉易混淆字符） */
export function genRoomCode(): string {
  let s = '';
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  for (let i = 0; i < 6; i++) s += ROOM_CHARS[a[i] % ROOM_CHARS.length];
  return s;
}
