import { createHmac } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { safeEqual } from '../lib/crypto';

/** Object storage with signed, expiring URLs (§8: ≤ 15 minutes). */
export interface StorageProvider {
  signUpload(key: string, contentType: string, ttlS: number): Promise<{ url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: Date }>;
  signDownload(key: string, ttlS: number): Promise<string>;
}

const MAX_TTL = 900;
const clampTtl = (t: number) => Math.max(30, Math.min(MAX_TTL, t));

export class S3Storage implements StorageProvider {
  private s3: S3Client;
  constructor(private cfg: { bucket: string; region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string }) {
    this.s3 = new S3Client({
      region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: !!cfg.endpoint,
      credentials: cfg.accessKeyId && cfg.secretAccessKey ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } : undefined,
    });
  }
  async signUpload(key: string, contentType: string, ttlS: number) {
    const t = clampTtl(ttlS);
    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, ContentType: contentType, ServerSideEncryption: 'AES256' }), { expiresIn: t });
    return { url, method: 'PUT' as const, headers: { 'content-type': contentType }, expiresAt: new Date(Date.now() + t * 1000) };
  }
  signDownload(key: string, ttlS: number) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: clampTtl(ttlS) });
  }
}

/** Local dev storage: HMAC-signed URLs served by the API at /v1/media/*. */
export class LocalStorage implements StorageProvider {
  constructor(private baseUrl: string, private secret: string, private nowFn: () => Date = () => new Date()) {}
  sign(key: string, exp: number, method: string) { return createHmac('sha256', this.secret).update(`${method}:${key}:${exp}`).digest('base64url'); }
  verify(key: string, exp: number, method: string, sig: string) { return exp * 1000 > this.nowFn().getTime() && safeEqual(sig, this.sign(key, exp, method)); }
  async signUpload(key: string, contentType: string, ttlS: number) {
    const exp = Math.floor(this.nowFn().getTime() / 1000) + clampTtl(ttlS);
    return { url: `${this.baseUrl}/v1/media/${encodeURIComponent(key)}?exp=${exp}&sig=${this.sign(key, exp, 'PUT')}`, method: 'PUT' as const, headers: { 'content-type': contentType }, expiresAt: new Date(exp * 1000) };
  }
  async signDownload(key: string, ttlS: number) {
    const exp = Math.floor(this.nowFn().getTime() / 1000) + clampTtl(ttlS);
    return `${this.baseUrl}/v1/media/${encodeURIComponent(key)}?exp=${exp}&sig=${this.sign(key, exp, 'GET')}`;
  }
}
