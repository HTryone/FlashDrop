// 房间码生成、relay 基址解析、按时间切段的段房间码计算。
// 发送端与接收端共用，保证两端用同一套房间/分段规则对齐。

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

// 自动分房：纯「时间」切段（每段从开始传输起计时，达到 SEGMENT_TIME_MS 即收尾开新段），
// 每段独立房间（独立 DO 实例），规避单 DO 长时间运行（>15min）缓冲堆积劣化。段房间码 = base-s{i}。
// 不按字节预算大小：速度中途变化也不影响，天然躲开 15min 阈值——这是相对旧版「速度×时间」写法的根本改进。
export const SEGMENT_TIME_MS = 300_000; // 单段目标时长 5 分钟（远小于 DO 15min 劣化阈值，留足余量）
export const SEGMENT_MIN_BYTES = 32 * 1024 * 1024; // 最小段字节守卫：本段已发字节未达此值时不切，避免瞬时抖动切出迷你段

/** 段房间码：房间码 + `-s{i}`，发送端/接收端一致 */
export function segRoom(roomCode: string, i: number): string {
  return `${roomCode}-s${i}`;
}
