// tus 协议常量与工具函数（自写最小端点，匹配 tus-js-client v4）。
// 只依赖 Web 标准 API（atob/btoa/Headers），可在 Worker / Node / 浏览器复用。

export const TUS_VERSION = '1.0.0';
export const TUS_RESUMABLE = '1.0.0';

/** 与 server.mjs 对齐：默认 30GB。 */
export const MAX_SIZE = 30 * 1024 * 1024 * 1024;

/** tus 端点暴露的能力。 */
export const TUS_EXTENSIONS = 'creation,termination';

/** 标准 CORS 头。 */
export function corsHeaders(origin?: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, PATCH, HEAD, DELETE, GET, OPTIONS',
    'Access-Control-Allow-Headers':
      'Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata, Content-Type, Authorization, X-Requested-With',
    'Access-Control-Expose-Headers':
      'Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata, Location, Content-Disposition',
    'Access-Control-Max-Age': '86400',
  };
}

/** 标准 tus 响应头。 */
export function tusHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Tus-Resumable': TUS_RESUMABLE,
    'Tus-Version': TUS_VERSION,
    'Tus-Extension': TUS_EXTENSIONS,
    'Tus-Max-Size': String(MAX_SIZE),
    ...extra,
  };
}

/** 把 Upload-Metadata 头解析为普通键值对。 */
export function parseMetadata(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    const space = trimmed.indexOf(' ');
    const key = space >= 0 ? trimmed.slice(0, space) : trimmed;
    const b64 = space >= 0 ? trimmed.slice(space + 1) : '';
    if (!key) continue;
    try {
      out[key] = b64 ? atob(b64) : '';
    } catch {
      out[key] = '';
    }
  }
  return out;
}

/** 把普通键值对编码为 Upload-Metadata 头。 */
export function encodeMetadata(meta: Record<string, string>): string {
  return Object.entries(meta)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => `${k} ${btoa(v)}`)
    .join(',');
}
