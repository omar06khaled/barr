/** Thin API client with refresh-token rotation. Tokens live in sessionStorage (cleared when the tab closes). */
const store = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* ignore */ } },
};

export class ApiError extends Error { constructor(public status: number, public code: string, public details?: unknown) { super(code); } }

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  const rt = store.get('barr.refresh');
  if (!rt) return false;
  const r = await fetch('/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
  if (!r.ok) { signOut(); return false; }
  const j = await r.json();
  setSession(j.accessToken, j.refreshToken);
  return true;
}

export function setSession(access: string, refreshToken: string) { store.set('barr.access', access); store.set('barr.refresh', refreshToken); }
export function signOut() { store.set('barr.access', null); store.set('barr.refresh', null); }
export const isSignedIn = () => !!store.get('barr.access');

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const r = await fetch(`/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(store.get('barr.access') ? { authorization: `Bearer ${store.get('barr.access')}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401 && !retried) {
    refreshing ??= refresh().finally(() => { refreshing = null; });
    if (await refreshing) return api<T>(path, opts, true);
  }
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, json?.error ?? 'error', json?.details);
  return json as T;
}
