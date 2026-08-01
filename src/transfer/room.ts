// P2P / HTTP 公共库：房间码生成与 relay 基址解析。
// 发送端与接收端、两种直传方式（HTTP 中继 / P2P 直连）共用同一套房间码与口令体系，
// 保证用户复制的同一个房间码在两种通道下都能对齐（P2P 走 `${room}::p2p` 命名空间，与 HTTP 互不冲突）。

export const RELAY_DEFAULT = 'flashdrop-relay.315461.xyz';

/** 解析 relay 基址：默认线上 relay，可用 VITE_RELAY_URL 覆盖（本地联调） */
export function resolveRelayBase(): string {
  const host = (import.meta as any).env?.VITE_RELAY_URL || RELAY_DEFAULT;
  return `https://${host}`;
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
