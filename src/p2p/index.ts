// P2P 直连模块入口。纯独立模块，不污染 HTTP 路径。
export { createP2PSender, type P2PSender } from './sender';
export { createP2PReceiver, type P2PReceiver } from './receiver';
export { createSink, type Sink } from './sinks';
export * from './types';
