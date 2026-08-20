// 云端文件柜：基于 Cloudflare R2。
// 两种模式（2026-08-20 全 KV 化改造）：
//   1) 绑定模式：bucket 传入 Worker 原生 R2Bucket 绑定（wrangler.toml），读写走绑定。
//   2) S3 直连模式：bucket 传 undefined，仅凭 creds(accountId/accessKeyId/secretAccessKey/bucketName)
//      通过 S3 兼容 API 直连 —— 支持任意跨账户/跨桶，配置全存 KV，无需 wrangler 绑定。
// createPresignedUrl 两种模式都走 S3 签名（R2 binding 本身不暴露 presign）。
// 设计原则（用户 2026-08-02「一律云端」）：文件体默认落 R2，流式读写不进内存。

import { AwsClient } from 'aws4fetch';
import { StorageBackend, TransferError } from '../../src/transfer/tus/types';

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

export class R2StorageBackend implements StorageBackend {
  readonly kind = 'r2' as const;
  private readonly aws: AwsClient;
  private readonly endpoint: string;

  constructor(
    private readonly bucket: R2Bucket | undefined,
    private readonly creds: R2Credentials,
  ) {
    this.aws = new AwsClient({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    this.endpoint = `https://${creds.bucketName}.${creds.accountId}.r2.cloudflarestorage.com`;
  }

  private s3Url(key: string): string {
    return key ? `${this.endpoint}/${key}` : `${this.endpoint}/`;
  }

  /** 存：body 必须是 ReadableStream（tus 分片直传，不缓冲整文件）。 */
  async put(key: string, body: ReadableStream<Uint8Array>, size: number): Promise<void> {
    if (this.bucket) {
      const res = await this.bucket.put(key, body, {
        contentLength: size,
        customMetadata: { size: String(size) },
      } as any);
      if (!res) throw new TransferError('STORAGE', `R2 put 失败: ${key}`);
      return;
    }
    const res = await this.aws.fetch(this.s3Url(key), {
      method: 'PUT',
      body,
      headers: { 'Content-Length': String(size) },
    });
    if (!res.ok) throw new TransferError('STORAGE', `R2 S3 put 失败(${res.status}): ${key}`);
  }

  /** 取：支持 Range 断点续传。返回流式 body，调用方负责 pipe 回响应。 */
  async get(
    key: string,
    range?: { start: number; end?: number },
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; contentRange?: string }> {
    if (this.bucket) {
      const obj = await this.bucket.get(
        key,
        range
          ? { range: { offset: range.start, length: (range.end ?? Infinity) - range.start + 1 } as any }
          : undefined,
      );
      if (!obj) throw new TransferError('NOT_FOUND', `R2 对象不存在: ${key}`);
      const total = obj.size;
      let contentRange: string | undefined;
      if (range) {
        const offset = (obj.range as any)?.offset ?? range.start;
        const length = (obj.range as any)?.length ?? total - offset;
        const end = offset + length - 1;
        contentRange = `bytes ${offset}-${end}/${total}`;
      }
      return { body: obj.body, size: total, contentRange };
    }
    const headers: Record<string, string> = {};
    if (range) headers.Range = `bytes=${range.start}-${range.end ?? ''}`;
    const res = await this.aws.fetch(this.s3Url(key), { method: 'GET', headers });
    if (res.status === 404) throw new TransferError('NOT_FOUND', `R2 对象不存在: ${key}`);
    if (!res.ok) throw new TransferError('STORAGE', `R2 S3 get 失败(${res.status}): ${key}`);
    const total = Number(res.headers.get('content-length') || 0);
    const contentRange = res.headers.get('content-range') ?? undefined;
    return { body: res.body as ReadableStream<Uint8Array>, size: total, contentRange };
  }

  /** 预签名直传：返回浏览器可直传 R2 的临时 URL。大体积密文流绕过 Worker 的 request.body pipe，
   *  避免 CF 边缘对大请求体流式透传的字节损坏（HMAC 校验失败的根因）。 */
  async createPresignedUrl(
    key: string,
    opts: { method?: string; expiresIn?: number } = {},
  ): Promise<string> {
    const method = opts.method ?? 'PUT';
    const expiresIn = opts.expiresIn ?? 600;
    const url = new URL(this.s3Url(key));
    const signed = await this.aws.sign(
      new Request(url, { method }),
      { aws: { signQuery: true, expires: expiresIn } as any },
    );
    return signed.url;
  }

  async delete(key: string): Promise<void> {
    if (this.bucket) {
      await this.bucket.delete(key);
      return;
    }
    const res = await this.aws.fetch(this.s3Url(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404)
      throw new TransferError('STORAGE', `R2 S3 delete 失败(${res.status}): ${key}`);
  }

  async exists(key: string): Promise<boolean> {
    if (this.bucket) {
      const head = await this.bucket.head(key);
      return !!head;
    }
    const res = await this.aws.fetch(this.s3Url(key), { method: 'HEAD' });
    return res.status === 200;
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    if (this.bucket) {
      const out: { key: string; size: number }[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.bucket.list({ prefix, cursor, limit: 1000 });
        for (const obj of page.objects ?? []) {
          out.push({ key: obj.key, size: obj.size });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return out;
    }
    // S3 ListObjectsV2：分页取全部，解析 XML Contents 的 Key/Size
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
      if (token) q.set('continuation-token', token);
      const res = await this.aws.fetch(`${this.s3Url('')}?${q.toString()}`, { method: 'GET' });
      if (!res.ok) throw new TransferError('STORAGE', `R2 S3 list 失败(${res.status})`);
      const xml = await res.text();
      const items = xml.split('<Contents>').slice(1);
      for (const it of items) {
        const km = it.match(/<Key>([\s\S]*?)<\/Key>/);
        const sm = it.match(/<Size>(\d+)<\/Size>/);
        if (km && sm) out.push({ key: km[1], size: Number(sm[1]) });
      }
      token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
    } while (token);
    return out;
  }

  /** 生命周期规则检测：GET /?lifecycle 看是否配置了删除规则（Expiration）。
   *  未配置时 S3 返回 404（NoSuchLifecycleConfiguration）→ false；
   *  配置了且含 Expiration → true。异常统一视为未配置（false），不阻断健康检查。 */
  async checkLifecycle(): Promise<boolean> {
    try {
      const res = await this.aws.fetch(`${this.s3Url('')}?lifecycle`, { method: 'GET' });
      if (res.status === 404) return false;
      if (!res.ok) return false;
      const xml = await res.text();
      return /<Expiration>/.test(xml);
    } catch {
      return false;
    }
  }
}
