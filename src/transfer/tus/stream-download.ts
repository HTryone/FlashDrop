// 中转下载（tus/R2）流式落盘实现（V2-A 并发方案）。
// 从 ReceiveFileRow.vue 抽离：N 路滑窗并行取数 + 有序重组 + 顺序解密 + 顺序落盘，不再把整文件密文/明文攒进内存。
// 复用：@/composables/filesink（落盘抽象，FSA/StreamSaver/Blob 三级）、@/crypto/tus-crypto（加解密原语）。

import { makeSinks, pickSaveDir } from '@/composables/filesink';
import { importRelayKeys, hmacEqual, decryptFrame, HEADER_LEN, IV_LEN, TAG_LEN } from '@/crypto/tus-crypto';

export interface PartInfo { key: string; offset: number; size: number; url: string }
export interface DownloadManifest { parts: PartInfo[]; total: number; filename: string }

const SUB_CHUNK = 16 * 1024 * 1024; // 滑窗粒度：16MiB/窗口（与取数 Range 对齐，单窗口取完耗时 < 看门狗）
const FETCH_TIMEOUT = 55_000;       // 单路取数看门狗：低于 CF 边缘 ~60s GET 硬超时，给慢连接留余量
const CONCURRENCY = 4;              // V2-A 并行取数路数：始终维持 N 路滑窗在飞，吃满可用带宽（弱网按每连接限速才提速）

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

// V2-A 全局滑窗：把 [gStart, gEnd) 解析为若干 (url, start, end) 取数规格。
// manifest.parts 按 offset 升序；一个窗口可能跨 part 边界，需拆成多段分别取（每段独立 Range）。
function resolveRanges(manifest: DownloadManifest, gStart: number, gEnd: number): { url: string; start: number; end: number }[] {
  const parts = [...manifest.parts].sort((a, b) => a.offset - b.offset);
  const specs: { url: string; start: number; end: number }[] = [];
  let p = parts.length - 1;
  while (p > 0 && parts[p].offset > gStart) p--;
  let pos = gStart;
  while (pos < gEnd && p < parts.length) {
    const part = parts[p];
    const partEnd = part.offset + part.size; // 不含
    const localStart = pos - part.offset;
    const localEnd = Math.min(gEnd, partEnd) - part.offset - 1; // Range 含尾
    specs.push({ url: part.url, start: localStart, end: localEnd });
    pos = Math.min(gEnd, partEnd);
    p++;
  }
  return specs;
}

// 取单个全局窗口 [gStart, gEnd) 的密文：解析为若干 part 子段，逐段取数 + 断点续传，最后拼接为连续密文。
// 每段复用 fetchRange 的 55s 看门狗 + partial 续传（零流量浪费）；窗口级并发由调度器维持，本函数只保证单窗口正确性。
// 注意：本函数返回的密文必须按窗口序交给 FrameDecoder.push（状态机不可并发 push）。
async function fetchWindow(
  manifest: DownloadManifest,
  gStart: number,
  gEnd: number,
  onChunk: (delta: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const specs = resolveRanges(manifest, gStart, gEnd);
  const bufs: Uint8Array<ArrayBuffer>[] = [];
  for (const spec of specs) {
    let pos = spec.start;
    const end = spec.end;
    while (pos <= end) {
      if (signal?.aborted) throw new Error('下载已取消');
      try {
        const r = await fetchRange(spec.url, pos, end, onChunk, signal);
        bufs.push(new Uint8Array(r.buf));
        pos = end + 1; // 整段成功
      } catch (e: any) {
        if (signal?.aborted) throw new Error('下载已取消');
        if (e?.message === 'SAVE_DIR_DENIED') throw e; // 落盘授权失败：非网络故障，直接透传
        if (e?.partialBuf) {
          bufs.push(new Uint8Array(e.partialBuf));
          pos += e.partialBytes; // 从断点续传（已收字节计入进度，不重取）
        } else {
          await new Promise((r) => setTimeout(r, 400)); // 非部分失败（无字节的连接重置等）：退避后整段重取
        }
      }
    }
  }
  let total = 0;
  for (const b of bufs) total += b.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) { out.set(b, off); off += b.byteLength; }
  return out.buffer;
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
// 再 V2-A 并发下载：N 路滑窗并行取数（吃满可用带宽）+ 有序重组 + 顺序解密 + 顺序落盘。
// 关键约束：FrameDecoder 是状态机、不可并发 push（共享 pending 会竞态损坏），故「取数并发、解密顺序」。
export async function streamDownloadToSink(opts: StreamDownloadOpts): Promise<{ permissionFallback?: boolean }> {
  const { manifest, e2eeKey, onChunk, signal } = opts;
  const dirHandle = await pickSaveDir();
  const { writers, permissionFallback } = await makeSinks([{ name: manifest.filename, size: manifest.total }], dirHandle);
  const sink = writers[0];
  if (!sink) throw new Error('无可用落盘 Sink');

  const total = manifest.total;
  const winCount = Math.ceil(total / SUB_CHUNK);
  // 有序缓冲：windowIndex -> 密文 Buffer（仅保留超前窗口，最多 CONCURRENCY-1 个，内存受控）
  const windows: (ArrayBuffer | null)[] = new Array(winCount).fill(null);
  let fetchError: Error | null = null;
  let nextToFetch = 0;
  let schedulerDone = false;

  // 调度器：始终维持最多 CONCURRENCY 路取数在飞（完成一个补一个，非整批等齐）；
  // 每路独立 55s 看门狗 + partial 续传，单路卡顿不影响其他路（比 V1 段内预取更稳）。
  const scheduler = (async () => {
    const active = new Set<Promise<void>>();
    const pump = () => {
      while (active.size < CONCURRENCY && nextToFetch < winCount) {
        const wi = nextToFetch++;
        const gStart = wi * SUB_CHUNK;
        const gEnd = Math.min(gStart + SUB_CHUNK, total);
        const task = fetchWindow(manifest, gStart, gEnd, onChunk, signal)
          .then((buf) => { windows[wi] = buf; })
          .catch((e: any) => { if (!fetchError) fetchError = e; })
          .finally(() => { active.delete(task); });
        active.add(task);
      }
    };
    pump();
    while (active.size > 0 || nextToFetch < winCount) {
      if (signal?.aborted || fetchError) break;
      await Promise.race([...active]);
      pump();
    }
    schedulerDone = true;
  })();

  try {
    if (!e2eeKey) {
      // 无加密：密文即明文，按窗口序顺序落盘
      let wi = 0;
      while (wi < winCount) {
        if (signal?.aborted) throw new Error('下载已取消');
        if (fetchError) throw fetchError;
        const buf = windows[wi];
        if (buf) {
          await sink.write(new Uint8Array(buf));
          windows[wi] = null;
          wi++;
        } else if (nextToFetch >= winCount && schedulerDone) {
          throw new Error('下载未完成：窗口 ' + wi + ' 缺失');
        } else {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    } else {
      const key = await importRelayKeys(e2eeKey);
      const dec = new FrameDecoder(
        key,
        (p) => sink.write(p),
        (msg) => console.warn('[tus-download]', msg),
      );
      let wi = 0;
      while (wi < winCount) {
        if (signal?.aborted) throw new Error('下载已取消');
        if (fetchError) throw fetchError;
        const buf = windows[wi];
        if (buf) {
          await dec.push(new Uint8Array(buf));
          windows[wi] = null;
          wi++;
          if (dec.failed) break;
        } else if (nextToFetch >= winCount && schedulerDone) {
          throw new Error('下载未完成：窗口 ' + wi + ' 缺失');
        } else {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      await dec.flush();
      if (dec.failed) throw new Error('完整性校验失败：数据可能被篡改');
    }
  } finally {
    await sink.close();
  }
  await scheduler; // 等调度器收尾（捕获潜在未决错误）
  return { permissionFallback };
}
