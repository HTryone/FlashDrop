// 中转(relay/tus)链路 E2EE —— 纯 WebCrypto 实现（AES-NI 硬件加速）。
// 与本地直传(crypto-js, 见 e2ee.ts) 完全分离：本文件只服务中转，不引入 crypto-js。
// 加密原语：AES-256-CBC + HMAC-SHA256，由 crypto.subtle 调用，约 GB/s（比 crypto-js 纯 JS 快两个数量级）。
// 帧格式（每块，与 e2ee.ts crypto-js 字节级一致，可互相解密）：
//   [4字节明文长度][4字节密文长度][16字节IV][密文(PKCS7填充)][32字节HMAC-SHA256]
// 密钥派生 deriveKey 用 WebCrypto PBKDF2(SHA-256, 150000 迭代)，与 crypto-js PBKDF2 字节级一致
// （口令均按 UTF-8 编码、salt 均为 base64 的 16 字节），故 crypto-js 加密的数据可由本文件解密，反之亦然。

const PBKDF2_ITERS = 150_000;
export const IV_LEN = 16;
export const TAG_LEN = 32;
export const HEADER_LEN = 8; // 4B 明文长度 + 4B 密文长度
export const E2EE_CHUNK_SIZE = 8 * 1024 * 1024; // 8MiB 一片（与 e2ee.ts 一致）

/** 生成随机 salt（base64，16 字节） */
export function newSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 生成随机加密口令（12 位，大小写字母+数字，易读易输） */
export function randomPassphrase(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => alphabet[b % alphabet.length]).join('');
}

/** hex 字符串 → Uint8Array */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** 由派生出的 32 字节密钥导入 AES-CBC 与 HMAC 两把 CryptoKey（与 crypto-js 单 key 双用同源） */
export async function importRelayKeys(keyHex: string): Promise<{ aesKey: CryptoKey; hmacKey: CryptoKey }> {
  const keyBytes = hexToBytes(keyHex);
  const aesKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
  const hmacKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return { aesKey, hmacKey };
}

/** 由口令 + salt 派生 AES-256 密钥（返回 hex 字符串，与旧 crypto-js PBKDF2 字节级一致） */
export async function deriveKey(passphrase: string, saltB64: string): Promise<string> {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERS, salt },
    baseKey,
    256,
  );
  const bytes = new Uint8Array(bits);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** 恒定时间比较两段 HMAC，防时序侧信道 */
export function hmacEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 解密单个 E2EE 帧密文为明文（去 PKCS7 填充），供流式 FrameDecoder 复用，与 decryptBlob 同源 */
export async function decryptFrame(aesKey: CryptoKey, iv: Uint8Array<ArrayBuffer> | ArrayBuffer, ct: Uint8Array<ArrayBuffer> | ArrayBuffer, plainLen: number): Promise<Uint8Array<ArrayBuffer>> {
  const plainAll = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, ct);
  return new Uint8Array(plainAll).slice(0, plainLen);
}

/** 加密一个文件为密文 Blob（WebCrypto，逐 8MiB 分块；帧格式与 e2ee.ts 一致）
 * 【安卓 WebView 修复】部分安卓 WebView 的 File.size 返回错误值（偏小），
 * 直接用 file.size 控制循环会截断文件末尾。先 readArrayBuffer 拿到真实长度，
 * 再按真实长度分块加密，确保任何平台都完整。 */
export async function encryptFile(
  file: File,
  keyHex: string,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const { aesKey, hmacKey } = await importRelayKeys(keyHex);
  const parts: Blob[] = [];
  // 权威读取：以实际内容为准，不信任 file.size（安卓 WebView 可能返回错误小值）
  const rawBuf = await file.arrayBuffer();
  const total = rawBuf.byteLength;
  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + E2EE_CHUNK_SIZE, total);
    const plainBuf = rawBuf.slice(offset, end);

    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ctBuf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, aesKey, plainBuf);
    const macBuf = await crypto.subtle.sign('HMAC', hmacKey, ctBuf);

    const plainLen = end - offset;
    const ctLen = ctBuf.byteLength;
    const header = new Uint8Array(HEADER_LEN);
    const hdv = new DataView(header.buffer);
    hdv.setUint32(0, plainLen, false);
    hdv.setUint32(4, ctLen, false);
    parts.push(new Blob([header, iv, ctBuf, macBuf]));
    offset = end;
    onProgress?.(offset / total);
  }
  return new Blob(parts);
}

/** 解密密文 Blob 为明文 Blob（与 encryptFile 对称；帧格式与 e2ee.ts 一致） */
export async function decryptBlob(
  blob: Blob,
  keyHex: string,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const { aesKey, hmacKey } = await importRelayKeys(keyHex);
  const parts: Blob[] = [];
  const total = blob.size;
  let offset = 0;
  while (offset < total) {
    const headerBuf = await blob.slice(offset, offset + HEADER_LEN).arrayBuffer();
    const hdv = new DataView(headerBuf);
    const plainLen = hdv.getUint32(0, false);
    const ctLen = hdv.getUint32(4, false);
    offset += HEADER_LEN;

    const ivBuf = await blob.slice(offset, offset + IV_LEN).arrayBuffer();
    offset += IV_LEN;

    const ctBuf = await blob.slice(offset, offset + ctLen).arrayBuffer();
    offset += ctLen;

    const macBuf = await blob.slice(offset, offset + TAG_LEN).arrayBuffer();
    offset += TAG_LEN;

    const macComputed = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, ctBuf));
    if (!hmacEqual(new Uint8Array(macBuf), macComputed)) {
      throw new Error('完整性校验失败：数据可能被篡改');
    }

    parts.push(new Blob([await decryptFrame(aesKey, ivBuf, ctBuf, plainLen)])); // 去掉 PKCS7 填充
    onProgress?.(offset / total);
  }
  return new Blob(parts);
}
