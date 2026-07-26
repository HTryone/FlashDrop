// 端到端加密（E2EE）：分享码 + 独立口令派生密钥，逐片 AES-GCM 加密。
// 密钥只在两端本地，服务器（含 R2）只存密文，零知识。
// 加密单位格式：[4字节明文长度][12字节IV][密文(明文长度+16 GCM标签)]

const CHUNK = 8 * 1024 * 1024; // 8MiB 一片
export const E2EE_CHUNK_SIZE = CHUNK;
const PBKDF2_ITERS = 150_000;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 4;

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBuf(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 生成随机 salt（base64） */
export function newSalt(): string {
  return bufToB64(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

/** 由口令 + salt 派生 AES-GCM 256 密钥 */
export async function deriveKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
  const salt = b64ToBuf(saltB64);
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 加密一个文件为密文 Blob（流式分片，内存占用约一个分片） */
export async function encryptFile(
  file: File,
  key: CryptoKey,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const parts: Blob[] = [];
  const total = file.size;
  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    const plainLen = end - offset;
    const plain = (await file.slice(offset, end).arrayBuffer()) as BufferSource;
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain);
    const header = new Uint8Array(HEADER_LEN);
    new DataView(header.buffer).setUint32(0, plainLen, false);
    parts.push(new Blob([header, iv, new Uint8Array(ct)]));
    offset = end;
    onProgress?.(offset / total);
  }
  return new Blob(parts);
}

/** 解密密文 Blob 为明文 Blob（与 encryptFile 对称） */
export async function decryptBlob(
  blob: Blob,
  key: CryptoKey,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const parts: Blob[] = [];
  const total = blob.size;
  let offset = 0;
  while (offset < total) {
    const headerBuf = (await blob.slice(offset, offset + HEADER_LEN).arrayBuffer()) as BufferSource;
    const plainLen = new DataView(headerBuf as ArrayBuffer).getUint32(0, false);
    offset += HEADER_LEN;
    const iv = new Uint8Array(await blob.slice(offset, offset + IV_LEN).arrayBuffer());
    offset += IV_LEN;
    const ctLen = plainLen + TAG_LEN;
    const ct = (await blob.slice(offset, offset + ctLen).arrayBuffer()) as BufferSource;
    offset += ctLen;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct);
    parts.push(new Blob([plain]));
    onProgress?.(offset / total);
  }
  return new Blob(parts);
}
