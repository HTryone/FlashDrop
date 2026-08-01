// HTTP 中继专属：按时间切段的段房间码与切段阈值。
// P2P 直连不走分段，本文件与 P2P 无关。段房间码 = 房间码-s{i}，每段独立 DO 实例。

// 自动分房：纯「时间」切段（每段从开始传输起计时，达到 SEGMENT_TIME_MS 即收尾开新段），
// 每段独立房间（独立 DO 实例），规避单 DO 长时间运行（>15min）缓冲堆积劣化。段房间码 = base-s{i}。
// 不按字节预算大小：速度中途变化也不影响，天然躲开 15min 阈值——这是相对旧版「速度×时间」写法的根本改进。
export const SEGMENT_TIME_MS = 300_000; // 单段目标时长 5 分钟（远小于 DO 15min 劣化阈值，留足余量）
export const SEGMENT_MIN_BYTES = 32 * 1024 * 1024; // 最小段字节守卫：本段已发字节未达此值时不切，避免瞬时抖动切出迷你段

/** 段房间码：房间码 + `-s{i}`，发送端/接收端一致 */
export function segRoom(roomCode: string, i: number): string {
  return `${roomCode}-s${i}`;
}
