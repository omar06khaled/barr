import { secureStorage } from './secureStorage';
import { API_URL } from './config';

/** Tokens in the OS keychain/keystore. Access token is short-lived; refresh rotates. */
const K = { access: 'barr.access', refresh: 'barr.refresh' };
let access: string | null = null;
let onSignedOut: (() => void) | null = null;
export const setSignedOutHandler = (fn: () => void) => { onSignedOut = fn; };

export async function loadSession() { access = await secureStorage.get(K.access); return !!access; }
export async function saveSession(a: string, r: string) { access = a; await secureStorage.set(K.access, a); await secureStorage.set(K.refresh, r); }
export async function clearSession() { access = null; await secureStorage.del(K.access); await secureStorage.del(K.refresh); }

export class ApiError extends Error { constructor(public status: number, public code: string, public details?: any) { super(code); } }

let refreshing: Promise<boolean> | null = null;
async function doRefresh() {
  const rt = await secureStorage.get(K.refresh);
  if (!rt) return false;
  const r = await fetch(`${API_URL}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
  if (!r.ok) { await clearSession(); onSignedOut?.(); return false; }
  const j = await r.json();
  await saveSession(j.accessToken, j.refreshToken);
  return true;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1${path}`, {
      method: opts.method ?? 'GET',
      headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(access ? { authorization: `Bearer ${access}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (r.status === 401 && !retried && !path.startsWith('/auth/')) {
    refreshing ??= doRefresh().finally(() => { refreshing = null; });
    if (await refreshing) return api<T>(path, opts, true);
  }
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, json?.error ?? 'error', json?.details);
  return json as T;
}
