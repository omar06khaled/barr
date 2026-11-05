import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { useI18n } from './i18n';

type Tone = 'ok' | 'warn' | 'alert' | 'neutral';
const ICON: Record<Tone, string> = { ok: '✓', warn: '◷', alert: '⚠', neutral: '•' };
/** Status badge: always text + icon + fill style; colour is only a secondary cue. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}><span aria-hidden="true">{ICON[tone]}</span>{children}</span>;
}

export function useApi<T>(path: string | null, deps: unknown[] = [], intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const load = () => api<T>(path).then((d) => live && (setData(d), setError(null))).catch((e) => live && setError(e.code ?? 'error'));
    load();
    const id = intervalMs ? setInterval(load, intervalMs) : undefined;
    return () => { live = false; if (id) clearInterval(id); };
  }, [path, n, ...deps]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function Loading({ error }: { error?: string | null }) {
  const { s } = useI18n();
  return error ? <p className="error" role="alert">{s.common.error}: {error}</p> : <p className="muted">{s.common.loading}</p>;
}

export const fmtDateTime = (iso: string | null | undefined, lang: 'ar' | 'en') =>
  iso ? new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' }).format(new Date(iso)) : '—';
export const fmtTime = (iso: string | null | undefined, lang: 'ar' | 'en') =>
  iso ? new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', { timeStyle: 'short', timeZone: 'Africa/Cairo' }).format(new Date(iso)) : '—';
export const fmtMoney = (minor: number, currency: string, lang: 'ar' | 'en') =>
  new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', { style: 'currency', currency }).format(minor / 100);
export const fmtAge = (s: number) => (s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

export function Section({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return <section className="card"><div className="row" style={{ justifyContent: 'space-between' }}><h2>{title}</h2>{extra}</div>{children}</section>;
}
