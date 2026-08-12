// 中转下载（tus/R2）流式落盘实现。
// 从 ReceiveFileRow.vue 抽离：N 路 part 并发取数 + 顺序重组 + 顺序解密 + 顺序落盘，不再把整文件密文/明文攒进内存。
// 复用：@/composables/filesink（落盘抽象，FSA/StreamSaver/Blob 三级）、@/crypto/tus-crypto（加解密原语）。
//
// 手机「完整性校验失败」根因仍在定位（2026-08-13，用户实测安卓 Edge/Chrome 双浏览器均复现，均属 Blink 引擎→非浏览器引擎差异）。
// 已坐实：①中段(60~70%)错位＝旧 V2-A 同 URL 不同 Range 缓存错位，已被 per-part 整块取数根除；②结尾(100%)失配在 reader/arrayBuffer/reader+part.size校验/no-store/nonce唯一URL 五种组合下均确定性复现，
//   且 part.size 权威长度校验通过（每个 part 实收字节数==声明值）却仍 HMAC 失配 → 字节【内容】被确定性改动，非长度/取数层问题。
//   最可能是手机本地 MITM 代理(安卓网络加速/VPN 装 CA 证书)对 *.r2.cloudflarestorage.com 响应做确定性字节变换，破坏密文完整性；桌面走干净网络不受影响。
//   本版（基于 816287f 回滚基线）在 per-part 整块取数之上统一加固：cache:'no-store' 绕浏览器缓存 + part.size 权威长度校验 + 删静默截断 + 详尽诊断日志（失败 part 二次重取对比字节），
//   目标是用一次手机实测的 console 日志坐死根因，再决定走 Worker 中继(根治 MITM) 还是客户端修正。

import { makeSinks, pickSaveDir } from '@/composables/filesink';
import { importRelayKeys, hmacEqual, decryptFrame, HEADER_LEN, IV_LEN, TAG_LEN } from '@/crypto/tus-crypto';

export interface PartInfo { key: string; offset: number; size: number; url: string }
export interface DownloadManifest { parts: PartInfo[]; total: number; filename: string }

const FETCH_TIMEOUT = 55_000;        // 单 part 取数看门狗：低于 CF 边缘 ~60s GET 硬超时，给慢连接留余量
const MAX_PART_RETRIES = 5;          // 单 part 看门狗/网络中断累计重试上限（防永久卡死/无限等待）
const PART_CONCURRENCY = 4;          // 桌面：4 路 part 并发在飞，吃满 per-IP 带宽
const MOBILE_PART_CONCURRENCY = 2;   // 移动端：降为 2 路仅为约束内存（per-IP 限速下速度不受并发数影响，且与桌面同池）

// hex 打印（截断到前 max 字节，便于日志比对）
function toHex(u: Uint8Array<ArrayBuffer>, max = 64): string {
  const n = Math.min(u.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += u[i].toString(16).padStart(2, '0');
  return s + (u.length > n ? `...(${u.length}字节)` : '');
}

// 两段字节逐字节对比：返回是否完全一致、首个差异偏移、差异字节数
function xorDiff(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): { equal: boolean; firstDiff: number; diffCount: number } {
  const len = Math.min(a.length, b.length);
  let firstDiff = -1;
  let diffCount = 0;
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      if (firstDiff < 0) firstDiff = i;
      diffCount++;
    }
  }
  const equal = firstDiff < 0 && a.length === b.length;
  return { equal, firstDiff, diffCount };
}

// 拼接两段 Uint8Array（拷贝，避免底层 buffer 复用导致数据损坏）
function concatBytes(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// 移动端检测：仅用于约束并发内存，与「同 URL 缓存错位」无关（该 bug 已通过 per-part 单次整块取数根除）。
function isMobile(): boolean {
  return typeof navigator !== 'undefined' &&
    (navigator.maxTouchPoints > 0 || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
}

// 取单个 part 的完整字节（不带头 Range、cache:'no-store' 绕过浏览器缓存）。
// 每个 part URL 全程只请求一次且不带 Range → 彻底避开「同 URL 不同 Range」缓存错位（中段根因，816287f 修复）；
// 看门狗/网络中断/长度不符时整 part 重取（cache:'no-store' 确保不走浏览器缓存，且不加 query 以免破坏 R2 预签名）。
// 取数用手动 reader.read() 流式累积（非 resp.arrayBuffer()）：arrayBuffer 在移动端对 32MiB 大响应取回空/坏字节（进度 0% + 末尾 HMAC 失配，cb06570 教训）；
// 逐块 reader 在移动端可靠，且逐块 onChunk 让进度条正常增长。
// 长度校验以 manifest 权威 part.size 为准（不依赖 Content-Length，移动网络代理可能不给/篡改）：实收 ≠ 声明即本次取数失败重试，
// 不再静默截断（旧代码 out.slice(0,received) 砍掉末块丢失的字节 → 末帧 HMAC 失配，正是「仅结尾失败」元凶）。
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
    const timer = setTimeout(() => { ctrl.abort(); }, FETCH_TIMEOUT); // 55s 看门狗：低于 CF 边缘 ~60s GET 硬超时
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    try {
      // 整 part 一次取回（无 Range）；cache:'no-store' 确保重取时不走浏览器缓存（不加 query 以免破坏 R2 预签名）
      const resp = await fetch(part.url, { signal: ctrl.signal, cache: 'no-store' });
      if (resp.status !== 200) throw new Error('part 下载失败 ' + resp.status); // 403 过期/404 → 致命透传
      const reader = resp.body!.getReader();
      // 以 manifest 权威 part.size 预分配（不依赖 Content-Length，移动网络代理可能不给/篡改）
      let out = new Uint8Array(part.size);
      let received = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (received + value.byteLength > out.length) {
          // 实收超出声明 size（移动代理多吐字节等罕见情况）：增长容错，不截断
          const grown = new Uint8Array(out.length + value.byteLength);
          grown.set(out, 0);
          out = grown;
        }
        out.set(value, received); // 同步写入，流复用底层 buffer 前已拷出
        received += value.byteLength;
        onChunk(value.byteLength); // 逐块回报进度（恢复进度条正常增长）
      }
      // 权威长度校验：以 manifest part.size 为准，不靠 Content-Length（代理可能缺失/篡改）
      // 实收 ≠ 声明 → 本次取数失败，退避后整 part 重取（带 cache-bust 防缓存错响应）
      if (received !== part.size) {
        console.warn('[tus-download] part', part.offset, '长度不符 声明', part.size, '实收', received);
        throw new Error('part 长度不符(声明 ' + part.size + ' 实收 ' + received + ')');
      }
      console.log('[tus-download] part', part.offset, '取数 OK 字节', received, '/', part.size);
      return received === out.length ? out : out.slice(0, received);
    } catch (e) {
      if (signal?.aborted) throw new Error('下载已取消');
      if (e instanceof Error && e.message.startsWith('part 下载失败')) throw e; // 致命错误直接透传
      // 看门狗/网络中断/长度不符：退避后整 part 重取（无 Range → 同 URL 同缓存键 → 安全，不触发错位）
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
  get pendingLen() { return this.pending.length; }

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
  console.log('[tus-download] 开始下载 文件', manifest.filename, '总大小', manifest.total, '分块数', parts.length, '移动端', isMobile(), 'e2ee', !!e2eeKey);
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
      let lastPushedPi = -1;
      let lastPushedBuf: Uint8Array<ArrayBuffer> | null = null;
      const dec = new FrameDecoder(
        key,
        (p) => sink.write(p),
        (msg) => console.warn('[tus-download]', msg, '| 失败发生在 part 序号', lastPushedPi, '/', partCount - 1, 'offset', parts[lastPushedPi]?.offset, 'pending字节', dec.pendingLen),
      );
      let pi = 0;
      while (pi < partCount) {
        if (signal?.aborted) throw new Error('下载已取消');
        if (fetchError) throw fetchError;
        const buf = buffers[pi];
        if (buf) {
          lastPushedPi = pi;
          lastPushedBuf = buf;
          await dec.push(buf); // 严格按 part 序喂连续密文（帧跨边界由 pending 自动衔接）
          buffers[pi] = null;
          pi++;
          if (dec.failed) {
            // 失败诊断：二次重取该 part，对比字节是否一致 → 区分「确定性源问题(手机MITM/服务器)」vs「偶发网络」vs「客户端bug」
            try {
              const retry = await fetchPart(parts[lastPushedPi], () => {}, signal);
              const d = xorDiff(lastPushedBuf!, retry);
              console.error('[tus-download] 失败part二次重取对比', {
                pi: lastPushedPi, offset: parts[lastPushedPi].offset, size: parts[lastPushedPi].size,
                retryLen: retry.length,
                firstHex: toHex(lastPushedBuf!), retryHex: toHex(retry),
                equal: d.equal, firstDiff: d.firstDiff, diffCount: d.diffCount,
              });
            } catch (e2) {
              console.error('[tus-download] 失败part二次重取异常', e2);
            }
            break;
          }
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
