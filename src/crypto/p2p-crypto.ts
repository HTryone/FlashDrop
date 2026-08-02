// P2P 专用加密：WebCrypto（subtle）实现，与 HTTP 链路（crypto-js）完全隔离。
//
// 背景：
//   上一轮 microbench（2026-08-02）证明 P2P 加解密不是吞吐瓶颈（crypto-js 单核 32MB/s、
//   4 Worker 上限 129MB/s，而端到端仅 26MB/s），但纯 JS 的 crypto-js 吃掉了约 1.6 个核
//   （发送 0.8 + 接收 0.8），正是用户抱怨的「增加了算力成本」。WebCrypto 硬件加速下
//   AES-CBC+HMAC 达 480/850 MB/s（快 15~27 倍），可把加解密 CPU 降到约 0.08 核。
//
// 设计约束：
//   ① 区块格式与 HTTP 链路**完全一致**：[16B IV][ciphertext][32B HMAC-SHA256]，
//      故 receiver/sender 的帧解析逻辑（FRAME_HDR 之上）零改动，仅替换底层原语。
//   ② 加解密原语用浏览器 subtle，异步非阻塞、底层硬件加速，主线程直接 await 即可，
//      不再需要 useLocalCrypto 的 Worker 池（crypto-js 同步计算才需要挪后台）。
//   ③ 密钥派生独立实现（WebCrypto PBKDF2 150000 次 SHA-256），不 import crypto-js。
//   ④ 仅本地磁盘模式使用：口令随机、单次会话，固定 salt 足够（与 HTTP 的 LOCAL_SALT 同源常量名，
//      但此处为 P2P 独立实现，UTF-8 编码作 salt，P2P 两端同版本自洽）。

const P2P_SALT = 'flashdrop-local-v1';

export interface P2PCryptoCtx {
  aesKey: CryptoKey;   // AES-256-CBC 密钥（与 HMAC 同源 32 字节）
  hmacKey: CryptoKey; // HMAC-SHA256 密钥（与 AES 同源 32 字节，与 crypto-js encryptChunk 一致）
}

/** 由口令派生 P2P 加解密密钥（WebCrypto PBKDF2 150000 次 SHA-256 出 256-bit）。 */
export async function deriveP2PKey(pass: string): Promise<P2PCryptoCtx> {
  const enc = new TextEncoder();
  const salt = enc.encode(P2P_SALT);
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  // 派生 256-bit，同一字节既作 AES key 又作 HMAC key（与 crypto-js 单 key 双用一致）
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 150_000, hash: 'SHA-256' },
    baseKey,
    256,
  );
  const keyBytes = new Uint8Array(bits);
  const aesKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
  const hmacKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return { aesKey, hmacKey };
}

/**
 * 加密单个明文块 → 帧：[16B IV][ciphertext][32B HMAC]。
 * 区块格式与 src/crypto/e2ee.ts 的 encryptChunk 完全一致（故 receiver/sender 帧解析逻辑零改动），
 * 但密钥派生为 P2P 独立实现（见 deriveP2PKey），P2P 与 HTTP 链路互不可解，符合「P2P 单独加密」。
 */
export async function encryptP2PChunk(plain: Uint8Array<ArrayBuffer>, ctx: P2PCryptoCtx): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ctx.aesKey, plain));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', ctx.hmacKey, ct));
  const out = new Uint8Array(16 + ct.length + 32);
  out.set(iv, 0);
  out.set(ct, 16);
  out.set(mac, 16 + ct.length);
  return out;
}

/**
 * 解密单块帧（含 HMAC 校验）→ 明文（自动去除 PKCS7 填充）。
 * @param plainLen 传入则按真实明文长度裁剪，避免文件末尾多出填充字节。
 */
export async function decryptP2PChunk(
  frame: Uint8Array<ArrayBuffer>,
  ctx: P2PCryptoCtx,
  plainLen?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (frame.length < 16 + 32 + 1) throw new Error('数据帧格式错误');
  const iv = frame.subarray(0, 16);
  const ctLen = frame.length - 16 - 32;
  const ct = frame.subarray(16, 16 + ctLen);
  const macReceived = frame.subarray(16 + ctLen);

  // 恒定时间比较 HMAC，防时序侧信道
  const macComputed = new Uint8Array(await crypto.subtle.sign('HMAC', ctx.hmacKey, ct));
  if (macReceived.length !== macComputed.length) throw new Error('完整性校验失败：数据可能被篡改');
  let diff = 0;
  for (let i = 0; i < macComputed.length; i++) diff |= macComputed[i] ^ macReceived[i];
  if (diff !== 0) throw new Error('完整性校验失败：数据可能被篡改');

  const full = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ctx.aesKey, ct));
  return plainLen == null ? full : full.subarray(0, plainLen);
}
