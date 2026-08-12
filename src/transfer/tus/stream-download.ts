// 中转下载（tus/R2）流式落盘实现（V1 简单方案）。
// 从 ReceiveFileRow.vue 抽离：边下载边解密边落盘，不再把整文件密文/明文攒进内存。
// 复用：@/composables/filesink（落盘抽象，FSA/StreamSaver/Blob 三级）、@/crypto/tus-crypto（加解密原语）。

import { makeSinks, pickSaveDir } from '@/composables/filesink';
import { importRelayKeys, hmacEqual, decryptFrame, HEADER_LEN, IV_LEN, TAG_LEN } from '@/crypto/tus-crypto';

export interface PartInfo { key: string; offset: number; size: number; url: string }
export interface DownloadManifest { parts: PartInfo[]; total: number; filename: string }

const SUB_CHUNK = 16 * 1024 * 1024; // 单路取数粒度：16MiB/段（浏览器直传 R2 后大对象流损坏已消除）
const FETCH_TIMEOUT = 55_000;       // 单路取数看门狗：低于 CF 边缘 ~60s GET 硬超时，给慢连接留余量

// 拼接两段 Uint8Array（拷贝，避免底层 buffer 复用导致数据损坏）
function concatBytes(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// 流式读取单个 Range：每段到达即回调 onChunk 刷新进度；
// 看门狗 abort / 网络中断时已收字节通过 partialBuf 抛给调用方，从断点续传（零流量浪费）。
async function fetchRange(
  url: string,
  start: number,
  end: number,
  onChunk: (delta: number) => void,
  signal?: AbortSignal,
): Promise<{ buf: ArrayBuffer; received: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  const chunks: Uint8Array[] = [];
  let received = 0;
  const assemble = () => {
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out.buffer;
  };
  try {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: ctrl.signal });
    if (resp.status !== 206 && resp.status !== 200) throw new Error('分片下载失败 ' + resp.status);
    const reader = resp.body!.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(new Uint8Array(value)); // 拷贝，避免流复用底层 buffer
      received += value.byteLength;
      onChunk(value.byteLength);
    }
    return { buf: assemble(), received };
  } catch (e) {
    if (received > 0) {
      const err = new Error('partial') as Error & { partialBytes: number; partialBuf: ArrayBuffer };
      err.partialBytes = received;
      err.partialBuf = assemble();
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 单个分片：按 ≤16MB 子范围多次取；看门狗 abort 后保留已收字节、从断点续传（零流量浪费）。
// 块内流水线：取当前段的同时后台预取下一段，使相邻段传输重叠，吃掉段间延迟空挡。
// onCipher：每段密文即时回调（喂 FrameDecoder，边下边解密，不再攒 ArrayBuffer[]）。
// 注意：必须 await onCipher —— FrameDecoder.push 是异步的，并发 push 会竞态损坏共享 pending 缓冲。
async function downloadPart(
  url: string,
  size: number,
  onCipher: (chunk: Uint8Array<ArrayBuffer>) => void | Promise<void>,
  onChunk: (delta: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  let pos = 0;
  let ahead: Promise<{ buf: ArrayBuffer; received: number }> | null = null;
  let aheadStart = -1;
  while (pos < size) {
    if (signal?.aborted) throw new Error('下载已取消');
    const startPos = pos;
    const end = Math.min(pos + SUB_CHUNK, size) - 1;
    let next: Promise<{ buf: ArrayBuffer; received: number }> | null = null;
    if (end + 1 < size) {
      const aStart = end + 1;
      next = fetchRange(url, aStart, Math.min(aStart + SUB_CHUNK, size) - 1, onChunk, signal);
      next.catch(() => {}); // 预取可能被主路径越过而永不 await（如 aheadStart 不匹配）→ 其 55s 看门狗超时拒绝会成 unhandledrejection；挂空 handler 吞掉（预取数据为投机，主路径会重取，不影响落盘）
    }
    let result: { buf: ArrayBuffer; received: number } | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (signal?.aborted) throw new Error('下载已取消');
      try {
        if (attempt === 1 && ahead && aheadStart === pos) {
          result = await ahead; // 命中上轮预取：下一段已在后台传输，重叠请求延迟
        } else {
          result = await fetchRange(url, pos, end, onChunk, signal);
        }
        await onCipher(new Uint8Array(result.buf));
        pos += result.received;
        break;
      } catch (e: any) {
        ahead = null;
        if (signal?.aborted) throw new Error('下载已取消');
        // 落盘授权失败（SAVE_DIR_DENIED 来自 FSAccessSink）：非网络故障，不再重试，直接透传
        if (e?.message === 'SAVE_DIR_DENIED') throw e;
        if (e?.partialBuf) {
          await onCipher(new Uint8Array(e.partialBuf));
          pos += e.partialBytes;
          break;
        }
        if (attempt < 5) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    if (pos <= startPos) throw new Error('网络不稳定，下载中断，请重试');
    if (pos < end + 1) next = null; // 部分完成：预取范围已偏移，作废
    ahead = next;
    aheadStart = end + 1;
  }
}

// 增量帧解析器：密文边到边喂入，凑齐一整帧即 HMAC 校验 + 解密 + 回调明文。
// 缓冲天然受控：顺序消费（downloadPart await 每段 push）使 pending 始终 < 1 帧，内存恒定，无需显式背压。
// 帧格式：[4B明文长][4B密文长][16B IV][密文(PKCS7)][32B HMAC]。
class FrameDecoder {
  private pending: Uint8Array<ArrayBuffer> = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
  private _failed = false;
  constructor(
    private key: { aesKey: CryptoKey; hmacKey: CryptoKey },
    private onPlain: (plain: Uint8Array<ArrayBuffer>) => void | Promise<void>,
    private onFail: (msg: string) => void,
  ) {}

  get failed() { return this._failed; }

  async push(chunk: Uint8Array<ArrayBuffer>) {
    if (this._failed) return;
    this.pending = concatBytes(this.pending, chunk);
    const minFrame = HEADER_LEN + IV_LEN + TAG_LEN;
    while (this.pending.length >= minFrame) {
      const hdv = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength);
      const plainLen = hdv.getUint32(0, false);
      const ctLen = hdv.getUint32(4, false);
      const frameLen = HEADER_LEN + IV_LEN + ctLen + TAG_LEN;
      if (this.pending.length < frameLen) break;
      const iv = this.pending.slice(HEADER_LEN, HEADER_LEN + IV_LEN);
      const ct = this.pending.slice(HEADER_LEN + IV_LEN, HEADER_LEN + IV_LEN + ctLen);
      const mac = this.pending.slice(HEADER_LEN + IV_LEN + ctLen, frameLen);
      const macComputed = new Uint8Array(await crypto.subtle.sign('HMAC', this.key.hmacKey, ct));
      if (!hmacEqual(mac, macComputed)) {
        this._failed = true;
        this.onFail('完整性校验失败：数据可能被篡改');
        return;
      }
      const plain = await decryptFrame(this.key.aesKey, iv, ct, plainLen);
      this.pending = this.pending.slice(frameLen);
      await this.onPlain(plain);
    }
  }

  async flush() {
    if (this.pending.length > 0) {
      this._failed = true;
      this.onFail('数据不完整：末尾剩余 ' + this.pending.length + ' 字节');
    }
  }
}

export interface StreamDownloadOpts {
  manifest: DownloadManifest;
  e2eeKey: string | null;
  onChunk: (delta: number) => void;
  signal?: AbortSignal;
}

// 主流程：用户手势内调用。先选保存目录（FSA 直写需用户授权，非 Chromium 返回 null 走 StreamSaver/Blob 兜底），
// 再按 part 顺序流式下载 + 解密 + 落盘。V1：part 顺序处理，段内预取保留（取数↔解密重叠，吞吐不降、顺序正确）。
export async function streamDownloadToSink(opts: StreamDownloadOpts): Promise<{ permissionFallback?: boolean }> {
  const { manifest, e2eeKey, onChunk, signal } = opts;
  const dirHandle = await pickSaveDir();
  const { writers, permissionFallback } = await makeSinks([{ name: manifest.filename, size: manifest.total }], dirHandle);
  const sink = writers[0];
  if (!sink) throw new Error('无可用落盘 Sink');
  try {
    if (!e2eeKey) {
      // 无加密：密文即明文，直接落盘
      for (const part of manifest.parts) {
        await downloadPart(part.url, part.size, (c) => sink.write(c), onChunk, signal);
      }
    } else {
      const key = await importRelayKeys(e2eeKey);
      const dec = new FrameDecoder(
        key,
        (p) => sink.write(p),
        (msg) => console.warn('[tus-download]', msg),
      );
      for (const part of manifest.parts) {
        if (dec.failed) break;
        await downloadPart(part.url, part.size, (c) => dec.push(c), onChunk, signal);
      }
      await dec.flush();
      if (dec.failed) throw new Error('完整性校验失败：数据可能被篡改');
    }
  } finally {
    await sink.close();
  }
  return { permissionFallback };
}
