// 轻量 fetch 封装：统一错误与 JSON 处理

export async function apiGet<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败 (${r.status})`);
  return data as T;
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败 (${r.status})`);
  return data as T;
}

export async function apiPatch<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败 (${r.status})`);
  return data as T;
}

export async function apiDelete(url: string): Promise<void> {
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `请求失败 (${r.status})`);
  }
}
