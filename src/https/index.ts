// 本地直传（HTTP 流式中继）核心模块统一出口。
// Vue 组件只从此处引入 LocalSender / LocalReceiver，不直接耦合传输细节。
export { LocalSender } from './sender';
export type { SenderCallbacks } from './sender';
export { LocalReceiver } from './receiver';
export type { ReceiverCallbacks } from './receiver';
export { FRAME_HDR, encodeMsg, decodeFrame, FrameReader } from './frame';
export { resolveRelayBase, segRoom, genRoomCode, SEGMENT_TIME_MS, SEGMENT_MIN_BYTES } from './room';
export { RelayControl, wsUrl } from './control';
export { makeSinks, pickSaveDir } from './sink';
export type { Sink, FileMeta, ChunkInfo } from './types';
