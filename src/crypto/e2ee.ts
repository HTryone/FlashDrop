// 端到端加密（E2EE）：分享码 + 独立口令派生密钥，逐片 AES-256-CBC 加密。
// 使用 crypto-js（纯 JS 实现），不依赖 WebCrypto，HTTP/HTTPS 均可用。
// 密钥只在两端本地，服务器（含 R2）只存密文，零知识。
// 加密单位格式：[4字节明文长度][16字节IV][密文(PKCS7填充)][32字节HMAC-SHA256]

import CryptoJS from 'crypto-js';

const CHUNK = 8 * 1024 * 1024; // 8MiB 一片
export const E2EE_CHUNK_SIZE = CHUNK;
const PBKDF2_ITERS = 150_000;
const IV_LEN = 16;
const TAG_LEN = 32; // HMAC-SHA256 输出长度
const HEADER_LEN = 4;

/** WordArray → Uint8Array */
function waToU8(wa: CryptoJS.lib.WordArray): Uint8Array<ArrayBuffer> {
  const words = wa.words;
  const sigBytes = wa.sigBytes;
  const out = new Uint8Array(sigBytes);
  for (let i = 0; i < sigBytes; i++) {
    out[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return out;
}

/** Uint8Array → WordArray */
function u8ToWa(u8: Uint8Array): CryptoJS.lib.WordArray {
  const words: number[] = [];
  for (let i = 0; i < u8.length; i += 4) {
    words.push(
      (u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | (u8[i + 3] || 0),
    );
  }
  return CryptoJS.lib.WordArray.create(words, u8.length);
}

/** 生成随机 salt（base64） */
export function newSalt(): string {
  return CryptoJS.lib.WordArray.random(16).toString(CryptoJS.enc.Base64);
}

/** 生成随机加密口令（12 位，大小写字母+数字，易读易输） */
export function randomPassphrase(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr); // 仅用于随机字符选择，不涉及 subtle
  return Array.from(arr, (b) => alphabet[b % alphabet.length]).join('');
}

/** 由口令 + salt 派生 AES-256 密钥（返回 hex 字符串） */
export async function deriveKey(passphrase: string, saltB64: string): Promise<string> {
  const salt = CryptoJS.enc.Base64.parse(saltB64);
  const key = CryptoJS.PBKDF2(passphrase, salt, {
    keySize: 256 / 32, // 8 个 32-bit word = 256 bit
    iterations: PBKDF2_ITERS,
    hasher: CryptoJS.algo.SHA256,
  });
  return key.toString(CryptoJS.enc.Hex);
}

/** 加密一个文件为密文 Blob（流式分片，内存占用约一个分片） */
export async function encryptFile(
  file: File,
  keyHex: string,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const key = CryptoJS.enc.Hex.parse(keyHex);
  const parts: Blob[] = [];
  const total = file.size;
  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    const plainBuf = await file.slice(offset, end).arrayBuffer();
    const plainWA = u8ToWa(new Uint8Array(plainBuf));
    const iv = CryptoJS.lib.WordArray.random(IV_LEN);

    // AES-256-CBC 加密（自动 PKCS7 填充）
    const encrypted = CryptoJS.AES.encrypt(plainWA, key, { iv });

    // HMAC-SHA256 对密文做完整性校验（只对原始密文，与解密端一致）
    const hmac = CryptoJS.HmacSHA256(encrypted.ciphertext, key);

    // 组装：[4B 明文长度][16B IV][密文][32B HMAC]
    const plainLen = end - offset;
    const header = new Uint8Array(HEADER_LEN);
    new DataView(header.buffer).setUint32(0, plainLen, false);
    parts.push(new Blob([
      header,
      waToU8(iv),
      waToU8(encrypted.ciphertext),
      waToU8(hmac),
    ]));
    offset = end;
    onProgress?.(offset / total);
  }
  return new Blob(parts);
}

/** 解密密文 Blob 为明文 Blob（与 encryptFile 对称） */
export async function decryptBlob(
  blob: Blob,
  keyHex: string,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const key = CryptoJS.enc.Hex.parse(keyHex);
  const parts: Blob[] = [];
  const total = blob.size;
  let offset = 0;
  while (offset < total) {
    // 读 4B 头
    const headerBuf = await blob.slice(offset, offset + HEADER_LEN).arrayBuffer();
    const plainLen = new DataView(headerBuf).getUint32(0, false);
    offset += HEADER_LEN;

    // 读 16B IV
    const ivBuf = await blob.slice(offset, offset + IV_LEN).arrayBuffer();
    const iv = u8ToWa(new Uint8Array(ivBuf));
    offset += IV_LEN;

    // 计算密文长度 = plainLen + PKCS7填充(1~16字节)
    // 总剩余 = total - offset，其中最后 32B 是 HMAC
    const remaining = total - offset;
    const ctLen = remaining - TAG_LEN;

    // 读密文
    const ctBuf = await blob.slice(offset, offset + ctLen).arrayBuffer();
    const ctWA = u8ToWa(new Uint8Array(ctBuf));
    offset += ctLen;

    // 读 HMAC 并验证
    const macBuf = await blob.slice(offset, offset + TAG_LEN).arrayBuffer();
    const macReceived = u8ToWa(new Uint8Array(macBuf));
    offset += TAG_LEN;

    const macComputed = CryptoJS.HmacSHA256(CryptoJS.lib.WordArray.create(ctWA.words, ctLen), key);
    if (macReceived.toString() !== macComputed.toString()) {
      throw new Error('完整性校验失败：数据可能被篡改');
    }

    // 解密
    const cipherParams = CryptoJS.lib.CipherParams.create({
      ciphertext: ctWA,
      iv: iv,
    });
    const decrypted = CryptoJS.AES.decrypt(cipherParams, key);

    // 去除 PKCS7 填充
    const plainWA = decrypted as CryptoJS.lib.WordArray; // decrypt 返回 WordArray
    const plain = waToU8(plainWA).slice(0, plainLen); // 截断到原始明文长度
    parts.push(new Blob([plain]));
    onProgress?.(offset / total);
  }
  return new Blob(parts);
}

// ---------- 本地磁盘模式：单块加解密（WebSocket 逐块流转，不落盘）----------
// 与中转模式不同，这里是"边读边加密边发"，每块独立 IV，解密端逐块还原。
export const LOCAL_CHUNK_SIZE = 512 * 1024; // 512KB 一块
// 加密后单帧 ≈ 512KB + 16(IV) + ≤16(PKCS7填充) + 32(HMAC) + 6(帧头) ≈ 524.4KB
// 远低于 Cloudflare Durable Object 的 1MB WebSocket 消息上限（≈1,000,000 字节）
// 若改回 1MiB，加密后 ≈1.05MB 会超标导致线上 Worker 静默丢弃二进制帧
// 本地磁盘口令随机且单次会话使用，固定 salt 足够（避免把 salt 塞进链接）
export const LOCAL_SALT = 'flashdrop-local-v1';

/** 加密单个明文块 → 帧：[16B IV][ciphertext][32B HMAC] */
export function encryptChunk(plain: Uint8Array, keyHex: string): Uint8Array<ArrayBuffer> {
  const key = CryptoJS.enc.Hex.parse(keyHex);
  const iv = CryptoJS.lib.WordArray.random(16);
  const enc = CryptoJS.AES.encrypt(u8ToWa(plain), key, { iv });
  const hmac = CryptoJS.HmacSHA256(enc.ciphertext, key);
  const ivU8 = waToU8(iv);
  const ctU8 = waToU8(enc.ciphertext);
  const macU8 = waToU8(hmac);
  const out = new Uint8Array(ivU8.length + ctU8.length + macU8.length);
  out.set(ivU8, 0);
  out.set(ctU8, ivU8.length);
  out.set(macU8, ivU8.length + ctU8.length);
  return out;
}

/** 解密单块帧（含 HMAC 校验）→ 明文 Uint8Array（自动去除 PKCS7 填充） */
export function decryptChunk(frame: Uint8Array, keyHex: string): Uint8Array<ArrayBuffer> {
  const key = CryptoJS.enc.Hex.parse(keyHex);
  const ctLen = frame.length - 16 - 32;
  if (ctLen <= 0) throw new Error('数据帧格式错误');
  const iv = u8ToWa(frame.slice(0, 16));
  const ct = u8ToWa(frame.slice(16, 16 + ctLen));
  const macReceived = u8ToWa(frame.slice(16 + ctLen));
  const macComputed = CryptoJS.HmacSHA256(CryptoJS.lib.WordArray.create(ct.words, ctLen), key);
  if (macReceived.toString() !== macComputed.toString()) {
    throw new Error('完整性校验失败：数据可能被篡改');
  }
  const cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext: ct, iv });
  const dec = CryptoJS.AES.decrypt(cipherParams, key);
  return waToU8(dec as CryptoJS.lib.WordArray);
}
