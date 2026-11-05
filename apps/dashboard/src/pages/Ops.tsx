import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Badge, Loading, Section, fmtDateTime, useApi } from '../components';
import { useI18n } from '../i18n';

export function Helpline() {
  const { s, lang } = useI18n();
  const { data, reload } = useApi<any>('/admin/helpline');
  const fams = useApi<any>('/admin/families?limit=100');
  const [f, setF] = useState({ parentId: '', callerName: '', summary: '', convertToEscalation: false });
  const submit = async () => { try { await api('/admin/helpline', { method: 'POST', body: { ...f, parentId: f.parentId || null } }); setF({ parentId: '', callerName: '', summary: '', convertToEscalation: false }); reload(); } catch (e: any) { alert(e.code); } };
  return (
    <div className="grid">
      <Section title={s.helpline.log}>
        <div className="stack">
          <select aria-label={s.helpline.parent} value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}><option value="">— {s.helpline.parent} —</option>{(fams.data?.items ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name} · {p.neighborhood}</option>)}</select>
          <input aria-label={s.helpline.caller} placeholder={s.helpline.caller} value={f.callerName} onChange={(e) => setF({ ...f, callerName: e.target.value })} />
          <textarea aria-label={s.helpline.summary} placeholder={s.helpline.summary} rows={4} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
          <label className="row"><input type="checkbox" checked={f.convertToEscalation} onChange={(e) => setF({ ...f, convertToEscalation: e.target.checked })} /> {s.helpline.convert}</label>
          <button onClick={submit} disabled={!f.callerName || f.summary.length < 2}>{s.common.save}</button>
        </div>
      </Section>
      <Section title={s.helpline.recent}>
        <table><tbody>{(data?.items ?? []).map((c: any) => (
          <tr key={c.id}><td>{fmtDateTime(c.created_at, lang)}</td><td>{c.parent_id ? <Link to={`/families/${c.parent_id}`}>{c.parent_name}</Link> : '—'}<div className="muted">{c.caller_name}: {c.summary}</div></td>
            <td>{c.escalation_id ? <Badge tone="alert">escalated</Badge> : c.parent_id && <button className="danger" onClick={() => api(`/admin/helpline/${c.id}/escalate`, { method: 'POST' }).then(reload)}>{s.helpline.escalate}</button>}</td></tr>
        ))}</tbody></table>
      </Section>
    </div>
  );
}

export function Settings() {
  const { s } = useI18n();
  const { data, error, reload } = useApi<any>('/admin/settings');
  const [cfg, setCfg] = useState<string>('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const saveCfg = async () => { try { await api('/admin/settings/config', { method: 'PATCH', body: JSON.parse(cfg || '{}') }); setMsg('✓'); reload(); } catch (e: any) { setMsg(e.code ?? 'invalid JSON'); } };
  const savePrice = async (planCode: string, currency: string, amount: string) => { try { await api('/admin/plan-prices', { method: 'PUT', body: { planCode, currency, amount: Number(amount) } }); reload(); } catch (e: any) { alert(e.code); } };
  const saveTpl = async (type: string, language: string, body: string) => { try { await api('/admin/notification-templates', { method: 'PUT', body: { type, language, body } }); reload(); } catch (e: any) { alert(e.code); } };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>{s.nav.settings}</h1>
      <Section title={s.settings.config}>
        <pre dir="ltr" className="card sand" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(data.config, null, 2)}</pre>
        <textarea dir="ltr" aria-label={s.settings.config} rows={4} style={{ width: '100%', fontFamily: 'monospace' }} placeholder='{"noContactAfter":"18:30","checkInRadiusM":200}' value={cfg} onChange={(e) => setCfg(e.target.value)} />
        <div className="row"><button onClick={saveCfg}>{s.settings.save}</button>{msg && <span>{msg}</span>}</div>
      </Section>
      <Section title={s.settings.prices}>
        <table><tbody>{data.prices.map((p: any) => <PriceRow key={p.plan_code + p.currency} p={p} onSave={savePrice} />)}</tbody></table>
        <p className="muted">Amounts in minor units (cents / halalas / fils). Caregiver plan price is set per family on the family page.</p>
      </Section>
      <Section title={s.settings.templates}>
        <p className="muted">Overrides of the default bilingual templates. WhatsApp templates must also be approved by Meta under the name barr_&lt;type&gt;.</p>
        <TemplateEditor onSave={saveTpl} existing={data.notificationTemplates} />
      </Section>
      <Section title={s.settings.checklists}>
        {data.checklistTemplates.map((t: any) => <details key={t.id}><summary>{t.visit_type} v{t.version}</summary><pre dir="ltr">{JSON.stringify(t.definition, null, 2)}</pre></details>)}
      </Section>
      <Section title={s.settings.cities}>
        <ul>{data.cities.map((c: any) => <li key={c.id}>{c.name_en} / {c.name_ar} ({c.timezone})<ul>{data.pods.filter((p: any) => p.city_id === c.id).map((p: any) => <li key={p.id}>{p.name} — {p.coordinator ?? '—'} — {p.neighborhoods.join(', ')}</li>)}</ul></li>)}</ul>
      </Section>
    </div>
  );
}
function PriceRow({ p, onSave }: { p: any; onSave: (a: string, b: string, c: string) => void }) {
  const [v, setV] = useState(String(p.amount));
  return <tr><td>{p.plan_code}</td><td>{p.currency}</td><td><input aria-label={`${p.plan_code} ${p.currency}`} value={v} onChange={(e) => setV(e.target.value)} /></td><td><button className="secondary" onClick={() => onSave(p.plan_code, p.currency, v)}>✓</button></td></tr>;
}
function TemplateEditor({ onSave, existing }: { onSave: (t: string, l: string, b: string) => void; existing: any[] }) {
  const [type, setType] = useState('daily_status');
  const [lang, setLang] = useState('ar');
  const [body, setBody] = useState('');
  return (
    <div className="stack">
      <div className="row">
        <input aria-label="type" value={type} onChange={(e) => setType(e.target.value)} />
        <select aria-label="language" value={lang} onChange={(e) => setLang(e.target.value)}><option>ar</option><option>en</option></select>
      </div>
      <textarea aria-label="body" dir={lang === 'ar' ? 'rtl' : 'ltr'} rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Use {{parent}}, {{status}} …" />
      <button onClick={() => onSave(type, lang, body)} disabled={body.length < 3}>✓</button>
      <ul>{existing.map((t) => <li key={t.type + t.language}><b>{t.type}</b> [{t.language}]: {t.body}</li>)}</ul>
    </div>
  );
}

export function Audit() {
  const { s, lang } = useI18n();
  const [action, setAction] = useState('');
  const { data, error } = useApi<any>(`/admin/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`, [action]);
  return (
    <div className="stack">
      <h1>{s.nav.audit}</h1>
      <input aria-label="action filter" placeholder="action prefix, e.g. escalation." value={action} onChange={(e) => setAction(e.target.value)} style={{ maxWidth: 320 }} />
      {!data ? <Loading error={error} /> : <div className="card"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Before → After</th></tr></thead><tbody>
        {data.items.map((a: any) => <tr key={a.id}><td>{fmtDateTime(a.at, lang)}</td><td>{a.actor_name ?? 'system'}</td><td><span className="pill">{a.action}</span></td><td className="muted">{a.entity_type} {a.entity_id?.slice(0, 8)}</td>
          <td dir="ltr" style={{ fontFamily: 'monospace', fontSize: 12 }}>{a.before ? JSON.stringify(a.before).slice(0, 120) : ''}{a.after ? ` → ${JSON.stringify(a.after).slice(0, 160)}` : ''}</td></tr>)}
      </tbody></table></div>}
    </div>
  );
}

export function Jobs() {
  const { s, lang } = useI18n();
  const [status, setStatus] = useState('');
  const { data, error, reload } = useApi<any>(`/admin/jobs?limit=200${status ? `&status=${status}` : ''}`, [status], 10_000);
  return (
    <div className="stack">
      <div className="row"><h1>{s.nav.jobs}</h1><select aria-label="status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">all</option>{['queued', 'running', 'done', 'failed', 'dead'].map((x) => <option key={x}>{x}</option>)}</select></div>
      {!data ? <Loading error={error} /> : (
        <>
          <div className="card"><div className="row">{data.summary.map((r: any) => <span key={r.name + r.status} className="pill">{r.name} · {r.status}: <b>{r.n}</b></span>)}</div></div>
          <div className="card"><table><tbody>{data.items.map((j: any) => (
            <tr key={j.id}><td>#{j.id}</td><td>{j.name}</td><td>{j.status === 'done' ? <Badge tone="ok">done</Badge> : j.status === 'dead' ? <Badge tone="alert">dead</Badge> : j.status === 'failed' ? <Badge tone="warn">failed</Badge> : <Badge tone="neutral">{j.status}</Badge>}</td>
              <td className="muted">{fmtDateTime(j.run_at, lang)} · {j.attempts}/{j.max_attempts}</td><td className="error">{j.last_error}</td>
              <td>{['failed', 'dead'].includes(j.status) && <button className="secondary" onClick={() => api(`/admin/jobs/${j.id}/retry`, { method: 'POST' }).then(reload)}>{s.common.retry}</button>}</td></tr>
          ))}</tbody></table></div>
        </>
      )}
    </div>
  );
}

export function Metrics() {
  const { s } = useI18n();
  const { data, error } = useApi<any>('/admin/metrics');
  if (!data) return <Loading error={error} />;
  const r = (ok: number, total: number, target: number) => {
    if (!total) return <Badge tone="neutral">—</Badge>;
    const v = ok / total;
    return <Badge tone={v >= target ? 'ok' : 'warn'}>{Math.round(v * 100)}% (target {Math.round(target * 100)}%)</Badge>;
  };
  return (
    <div className="stack">
      <h1>{s.nav.metrics}</h1>
      <div className="card"><table><tbody>
        <tr><td>Weekly families opening timeline / WhatsApp report</td><td>{r(data.weeklyEngagement.engaged, data.weeklyEngagement.active_families, 0.8)}</td></tr>
        <tr><td>Visit reports delivered within 24 h</td><td>{r(data.reportsWithin24h.ok, data.reportsWithin24h.total, 0.98)}</td></tr>
        <tr><td>Escalations with family told within 15 min</td><td>{r(data.escalationsFamilyTold15m.ok, data.escalationsFamilyTold15m.total, 1)}</td></tr>
        <tr><td>Missed doses resolved same day</td><td>{r(data.missedDosesResolvedSameDay.ok, data.missedDosesResolvedSameDay.total, 0.9)}</td></tr>
        <tr><td>Concerns resolved by deadline</td><td>{r(data.concernsByDeadline.ok, data.concernsByDeadline.total, 0.9)}</td></tr>
        <tr><td>Dashboard time per family per week</td><td>{data.dashboardTimePerFamily.families ? `${Math.round(data.dashboardTimePerFamily.seconds / data.dashboardTimePerFamily.families / 60)} min (target < 10)` : '—'}</td></tr>
        <tr><td>Renewal into month two</td><td>{r(data.renewalMonthTwo.renewed, data.renewalMonthTwo.eligible, 0.8)}</td></tr>
      </tbody></table></div>
    </div>
  );
}
