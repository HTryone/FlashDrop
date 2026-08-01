// 本地直传（HTTP 流式中继）共享类型定义。
// 本目录为纯 TS 核心逻辑，不依赖 Vue；Vue 组件只作为 UI 壳调用这里的类。

export interface FileMeta {
  name: string;
  size: number;
}

/** 有序 chunk 清单里的单个 chunk 描述 */
export interface ChunkInfo {
  fi: number; // 文件索引
  ci: number; // 文件内 chunk 索引
  plainLen: number; // 明文长度
}

/** 落盘 Sink：接收端写入抽象（FSA / StreamSaver / Blob 兜底） */
export interface Sink {
  write(p: Uint8Array): Promise<void> | void;
  close(): Promise<void>;
  abort(): void;
}
