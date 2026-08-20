// 站长后台认证：PBKDF2-SHA256 密码哈希 + HttpOnly session cookie 会话。
// KV 键设计：
//   admin:password_hash   = {"salt":"...","hash":"..."}   密码哈希（首次设置写入，之后只验证）
//   admin:session:<token> = {"exp":毫秒时间戳}            登录会话（7 天有效期，KV 自动过期）
// cookie：admin_session=<token>（HttpOnly，JS 不可读；同源 fetch 自动携带，前端零改动）
//
// 流程：首次访问 /admin（无密码哈希）→ 设置页；设置成功即自动建会话直接进。
//       之后访问（有哈希、无有效会话）→ 登录页；登录成功建会话。

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE_NAME = 'admin_session';

/** 从 Cookie 头解析指定 cookie 值。 */
export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** PBKDF2-SHA256 派生 256 位哈希（hex）。100k 迭代，Workers Web Crypto 原生支持。 */
async function pbkdf2(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return [...new Uint8Array(bits)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 是否已设置过管理密码（设置页/登录页二选一的开关）。 */
export async function hasPassword(kv: KVNamespace | undefined): Promise<boolean> {
  if (!kv) return false;
  return (await kv.get('admin:password_hash')) !== null;
}

/** 首次设置密码：写 PBKDF2 哈希。已设置过则拒绝（防覆盖）。 */
export async function setPassword(
  kv: KVNamespace | undefined,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!kv) return { ok: false, error: 'KV 未配置' };
  if (!password || password.length < 6) return { ok: false, error: '密码至少 6 位' };
  const existing = await kv.get('admin:password_hash');
  if (existing) return { ok: false, error: '密码已设置，请直接登录' };
  const salt = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const hash = await pbkdf2(password, salt);
  await kv.put('admin:password_hash', JSON.stringify({ salt, hash }));
  return { ok: true };
}

/** 验证密码（恒定时间比较，防时序攻击）。 */
export async function verifyPassword(
  kv: KVNamespace | undefined,
  password: string,
): Promise<boolean> {
  if (!kv || !password) return false;
  const raw = await kv.get('admin:password_hash');
  if (!raw) return false;
  try {
    const { salt, hash } = JSON.parse(raw) as { salt: string; hash: string };
    const calc = await pbkdf2(password, salt);
    if (calc.length !== hash.length) return false;
    let diff = 0;
    for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ hash.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

/** 创建会话：随机 token 写 KV（7 天自动过期），返回 token。 */
export async function createSession(kv: KVNamespace | undefined): Promise<string | null> {
  if (!kv) return null;
  const token = crypto.randomUUID();
  await kv.put(`admin:session:${token}`, JSON.stringify({ exp: Date.now() + SESSION_TTL_MS }), {
    expirationTtl: Math.ceil(SESSION_TTL_MS / 1000),
  });
  return token;
}

/** 销毁会话（登出）。 */
export async function destroySession(
  kv: KVNamespace | undefined,
  request: Request,
): Promise<void> {
  const token = getCookie(request, COOKIE_NAME);
  if (kv && token) await kv.delete(`admin:session:${token}`).catch(() => {});
}

/** 校验当前请求是否已认证（cookie 会话有效且未过期）。 */
export async function isAuthed(
  kv: KVNamespace | undefined,
  request: Request,
): Promise<boolean> {
  if (!kv) return false;
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return false;
  const raw = await kv.get(`admin:session:${token}`);
  if (!raw) return false;
  try {
    const { exp } = JSON.parse(raw) as { exp: number };
    if (exp < Date.now()) {
      await kv.delete(`admin:session:${token}`).catch(() => {});
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 下发会话 cookie（HttpOnly，7 天）。 */
export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000,
  )}`;
}

/** 清除会话 cookie（登出）。 */
export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
