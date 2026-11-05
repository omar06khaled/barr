import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface OAuthIdentity { subject: string; email?: string }
export interface OAuthVerifier { verify(provider: 'google' | 'apple', idToken: string, nonce?: string): Promise<OAuthIdentity> }

/** Verifies Google / Apple ID tokens against their JWKS. */
export class JwksOAuthVerifier implements OAuthVerifier {
  private google = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  private apple = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
  constructor(private googleClientIds: string[], private appleAudiences: string[]) {}
  async verify(provider: 'google' | 'apple', idToken: string, nonce?: string) {
    const { payload } =
      provider === 'google'
        ? await jwtVerify(idToken, this.google, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: this.googleClientIds })
        : await jwtVerify(idToken, this.apple, { issuer: 'https://appleid.apple.com', audience: this.appleAudiences });
    if (nonce && payload.nonce !== nonce) throw new Error('nonce_mismatch');
    if (!payload.sub) throw new Error('no_subject');
    return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined };
  }
}

/** Test verifier: token format "provider:subject:email". */
export class FakeOAuthVerifier implements OAuthVerifier {
  async verify(provider: 'google' | 'apple', idToken: string) {
    const [p, subject, email] = idToken.split(':');
    if (p !== provider || !subject) throw new Error('invalid_token');
    return { subject, email };
  }
}
