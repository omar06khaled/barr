import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM field-level encryption (§8). Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
export class FieldCrypto {
  private key: Buffer;
  constructor(base64Key: string, private blindKey: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must decode to 32 bytes');
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }
  decrypt(enc: string): string {
    const [v, iv, tag, ct] = enc.split('.');
    if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('bad_ciphertext');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }
  encryptNullable(v: string | null | undefined) { return v == null || v === '' ? null : this.encrypt(v); }
  decryptNullable(v: string | null | undefined) { return v ? this.decrypt(v) : null; }
  /** Deterministic blind index for equality lookup (e.g. phone → user). */
  blindIndex(v: string): string { return createHmac('sha256', this.blindKey).update(v).digest('base64url'); }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sixDigitCode = () => randomInt(0, 1_000_000).toString().padStart(6, '0');
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
