// 云端文件柜：基于 Cloudflare R2 绑定（Worker 运行时原生 R2Bucket）。
// 设计原则（用户 2026-08-02「一律云端」）：文件体默认落 R2，流式读写不进内存。
// 本地磁盘实现（LocalStorageBackend）作为可插拔备选，不在默认路径，留待后续研究。

import { AwsClient } from 'aws4fetch';
import { StorageBackend, TransferError } from '../../src/transfer/tus/types';

interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

export class R2StorageBackend implements StorageBackend {
  readonly kind = 'r2' as const;
  private readonly aws: AwsClient;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly creds: R2Credentials,
  ) {
    this.aws = new AwsClient({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
  }

  /** 存：body 必须是 ReadableStream（tus 分片直传，不缓冲整文件）。 */
  async put(key: string, body: ReadableStream<Uint8Array>, size: number): Promise<void> {
    const res = await this.bucket.put(key, body, {
      contentLength: size,
      customMetadata: { size: String(size) },
    });
    if (!res) throw new TransferError('STORAGE', `R2 put 失败: ${key}`);
  }

  /** 取：支持 Range 断点续传。返回流式 body，调用方负责 pipe 回响应。 */
  async get(
    key: string,
    range?: { start: number; end?: number },
  ): Promise<{ body: ReadableStream<Uint8Array>; size: number; contentRange?: string }> {
    const obj = await this.bucket.get(
      key,
      range
        ? { range: { offset: range.start, length: (range.end ?? Infinity) - range.start + 1 } }
        : undefined,
    );
    if (!obj) throw new TransferError('NOT_FOUND', `R2 对象不存在: ${key}`);

    const total = obj.size;
    let contentRange: string | undefined;
    if (range) {
      const offset = obj.range?.offset ?? range.start;
      const length = obj.range?.length ?? total - offset;
      const end = offset + length - 1;
      contentRange = `bytes ${offset}-${end}/${total}`;
    }
    return { body: obj.body, size: total, contentRange };
  }

  /** 预签名直传：返回浏览器可直传 R2 的临时 URL。大体积密文流绕过 Worker 的 request.body pipe，
   *  避免 CF 边缘对大请求体流式透传的字节损坏（HMAC 校验失败的根因）。
   *  用 aws4fetch 做 S3 兼容签名（Workers R2 binding 自身未暴露 createPresignedUrl）。 */
  async createPresignedUrl(
    key: string,
    opts: { method?: string; expiresIn?: number } = {},
  ): Promise<string> {
    const method = opts.method ?? 'PUT';
    const expiresIn = opts.expiresIn ?? 600;
    const url = new URL(
      `https://${this.creds.bucketName}.${this.creds.accountId}.r2.cloudflarestorage.com/${key}`,
    );
    url.searchParams.set('X-Amz-Expires', String(expiresIn));
    const signed = await this.aws.sign(
      new Request(url, { method }),
      { aws: { signQuery: true } },
    );
    return signed.url;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const head = await this.bucket.head(key);
    return !!head;
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
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
}
