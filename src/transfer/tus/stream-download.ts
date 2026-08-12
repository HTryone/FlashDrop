// 中转下载（tus/R2）流式落盘实现。
// 从 ReceiveFileRow.vue 抽离：N 路 part 并发取数 + 顺序重组 + 顺序解密 + 顺序落盘，不再把整文件密文/明文攒进内存。
// 复用：@/composables/filesink（落盘抽象，FSA/StreamSaver/Blob 三级）、@/crypto/tus-crypto（加解密原语）。
//
// 手机「完整性校验失败」根因与修复（2026-08-12 复盘）：
//   旧模型按 16MiB 全局窗口取数，一个窗口会跨 part 边界向【同一个 32MiB part URL 发不同 Range】。
//   iOS/部分手机浏览器「按 URL 缓存、忽略 Range」——把首次响应喂给后续同 URL 的不同 Range 请求 → 字节错位 → HMAC 失配（确定性失败）。
//   串行化无效：串行只是让窗口顺序取，但 window 0 / window 1 仍向同一 part URL 发不同 Range。cache:'no-store' / 服务端 no-store 均被手机忽略。
//   正确修复：每个 part URL 全程只请求【一次】且【不带 Range】（整块取回）。同 URL 永不再以不同 Range 重取 → 缓存错位触发器被根除。
//   看门狗/网络中断时整 part 重取（同 URL 同请求形态 → 同缓存键 → 安全），重试罕见且不触发错位。

import { makeSinks, pickSaveDir } from '@/composables/filesink';
import { importRelayKeys, hmacEqual, decryptFrame, HEADER_LEN, IV_LEN, TAG_LEN } from '@/crypto/tus-crypto';

export interface PartInfo { key: string; offset: number; size: number; url: string }
export interface DownloadManifest { parts: PartInfo[]; total: number; filename: string }

const FETCH_TIMEOUT = 55_000;        // 单 part 取数看门狗：低于 CF 边缘 ~60s GET 硬超时，给慢连接留余量
const MAX_PART_RETRIES = 5;          // 单 part 看门狗/网络中断累计重试上限（防永久卡死/无限等待）
const PART_CONCURRENCY = 4;          // 桌面：4 路 part 并发在飞，吃满 per-IP 带宽
const MOBILE_PART_CONCURRENCY = 2;   // 移动端：降为 2 路仅为约束内存（per-IP 限速下速度不受并发数影响，且与桌面同池）

// 移动端检测：仅用于约束并发内存，与「同 URL 缓存错位」无关（该 bug 已通过 per-part 单次整块取数根除）。
function isMobile(): boolean {
  return typeof navigator !== 'undefined' &&
    (navigator.maxTouchPoints > 0 || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
}

// 拼接两段 Uint8Array（拷贝，避免底层 buffer 复用导致数据损坏）
function concatBytes(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// 取单个 part 的完整字节（不带头 Range、不强制缓存策略）。
// 每个 part URL 全程只请求一次且不带 Range → 彻底避开「同 URL 不同 Range」缓存错位；
// 看门狗/网络中断时整 part 重取（同 URL 同请求形态 → 同缓存键 → 安全），按 Content-Length 预分配避免二次拷贝爆内存。
async function fetchPart(
  part: PartInfo,
  onChunk: (delta: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new Error('下载已取消');
    attempt++;
    if (attempt > MAX_PART_RETRIES) throw new Error('分块下载连续失败，请重试');
    const ctrl = new AbortController();
    let watchdogFired = false;
    const timer = setTimeout(() => { watchdogFired = true; ctrl.abort(); }, FETCH_TIMEOUT);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    try {
      const resp = await fetch(part.url, { signal: ctrl.signal }); // 无 Range：整 part 一次取回
      if (resp.status !== 200) throw new Error('part 下载失败 ' + resp.status); // 403 过期/404 → 致命透传
      const reader = resp.body!.getReader();
      const cl = Number(resp.headers.get('Content-Length') || 0);
      let out = cl > 0 ? new Uint8Array(cl) : new Uint8Array(0);
      let received = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        if (received + value.byteLength > out.length) {
          // 实际长度超过声明（罕见）：增长到 2× 后继续（同步拷贝，下一次 read 前完成）
          const grown = new Uint8Array(Math.max(out.length * 2, received + value.byteLength));
          grown.set(out, 0);
          out = grown;
        }
        out.set(value, received); // 同步写入，流复用底层 buffer 前已拷出
        received += value.byteLength;
        onChunk(value.byteLength);
      }
      return received === out.length ? out : out.slice(0, received);
    } catch (e) {
      if (signal?.aborted) throw new Error('下载已取消');
      if (e instanceof Error && e.message.startsWith('part 下载失败')) throw e; // 致命错误直接透传
      // 看门狗/网络中断：退避后整 part 重取（无 Range → 同 URL 同缓存键 → 安全，不触发错位）
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      clearTimeout(timer);
    }
  }
}

// 增量帧解析器：密文边到边喂入，凑齐一整帧即 HMAC 校验 + 解密 + 回调明文。
// 缓冲天然受控：顺序消费（每次 push 一个完整 part）使 pending 始终 < 1 帧 + 1 part，内存恒定，无需显式背压。
// 帧格式：[4B明文长][4B密文长][16B IV][密文(PKCS7)][32B HMAC]。帧可跨 part 边界：pending 缓冲自动衔接。
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
// 再 part 级并发下载：N 路 part 在飞（吃满带宽）+ 严格按 part offset 序顺序解密 + 顺序落盘。
// 关键约束：FrameDecoder 是状态机、不可并发 push（共享 pending 会竞态损坏），故「取数并发、解密顺序」。
export async function streamDownloadToSink(opts: StreamDownloadOpts): Promise<{ permissionFallback?: boolean }> {
  const { manifest, e2eeKey, onChunk, signal } = opts;
  // 严格按 offset 升序：解码必须喂连续全局密文，part 边界与帧边界无关（帧可跨 part，pending 缓冲自动衔接）
  const parts = [...manifest.parts].sort((a, b) => a.offset - b.offset);
  const dirHandle = await pickSaveDir();
  const { writers, permissionFallback } = await makeSinks([{ name: manifest.filename, size: manifest.total }], dirHandle);
  const sink = writers[0];
  if (!sink) throw new Error('无可用落盘 Sink');

  const partCount = parts.length;
  const effConcurrency = isMobile() ? MOBILE_PART_CONCURRENCY : PART_CONCURRENCY;
  // 有序缓冲：partIndex -> 密文（仅保留超前 part，最多 effConcurrency-1 个，内存受控）
  const buffers: (Uint8Array<ArrayBuffer> | null)[] = new Array(partCount).fill(null);
  let fetchError: Error | null = null;
  let nextToFetch = 0;
  let schedulerDone = false;

  // 调度器：始终维持最多 effConcurrency 路 part 取数在飞（完成一个补一个，非整批等齐）；
  // 每路独立 55s 看门狗 + 整 part 重取，单路卡顿不影响其他路。
  const scheduler = (async () => {
    const active = new Set<Promise<void>>();
    const pump = () => {
      while (active.size < effConcurrency && nextToFetch < partCount) {
        const pi = nextToFetch++;
        const task = fetchPart(parts[pi], onChunk, signal)
          .then((buf) => { buffers[pi] = buf; })
          .catch((e: any) => { if (!fetchError) fetchError = e; })
          .finally(() => { active.delete(task); });
        active.add(task);
      }
    };
    pump();
    while (active.size > 0 || nextToFetch < partCount) {
      if (signal?.aborted || fetchError) break;
      await Promise.race([...active]);
      pump();
    }
    schedulerDone = true;
  })();

  try {
    if (!e2eeKey) {
      // 无加密：密文即明文，按 part 序顺序落盘
      let pi = 0;
      while (pi < partCount) {
        if (signal?.aborted) throw new Error('下载已取消');
        if (fetchError) throw fetchError;
        const buf = buffers[pi];
        if (buf) {
          await sink.write(buf);
          buffers[pi] = null; // 释放，内存受控
          pi++;
        } else if (nextToFetch >= partCount && schedulerDone) {
          throw new Error('下载未完成：分块 ' + pi + ' 缺失');
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
      let pi = 0;
      while (pi < partCount) {
        if (signal?.aborted) throw new Error('下载已取消');
        if (fetchError) throw fetchError;
        const buf = buffers[pi];
        if (buf) {
          await dec.push(buf); // 严格按 part 序喂连续密文（帧跨边界由 pending 自动衔接）
          buffers[pi] = null;
          pi++;
          if (dec.failed) break;
        } else if (nextToFetch >= partCount && schedulerDone) {
          throw new Error('下载未完成：分块 ' + pi + ' 缺失');
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
