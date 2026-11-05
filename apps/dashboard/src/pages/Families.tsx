import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Badge, Loading, Section, fmtDateTime, useApi } from '../components';
import { useI18n } from '../i18n';

export function Families() {
  const { s } = useI18n();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const id = setTimeout(() => setQuery(q), 300); return () => clearTimeout(id); }, [q]);
  const { data, error } = useApi<any>(`/admin/families?limit=100${query ? `&search=${encodeURIComponent(query)}` : ''}`, [query]);
  return (
    <div className="stack">
      <h1>{s.nav.families}</h1>
      <input aria-label={s.families.search} placeholder={s.families.search} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
      {!data ? <Loading error={error} /> : (
        <div className="card"><table>
          <thead><tr><th>Name</th><th>{s.families.status}</th><th>{s.families.plan}</th><th>{s.families.payment}</th><th>{s.families.pod}</th><th>{s.families.members}</th><th>{s.families.churn}</th></tr></thead>
          <tbody>{data.items.map((f: any) => (
            <tr key={f.id}>
              <td><Link to={`/families/${f.id}`}>{f.name}</Link><div className="muted">{f.neighborhood}</div></td>
              <td>{f.status}</td><td>{f.plan_code ?? '—'}</td>
              <td>{f.payment_state === 'active' ? <Badge tone="ok">active</Badge> : f.payment_state ? <Badge tone={f.payment_state === 'paused' ? 'alert' : 'warn'}>{f.payment_state}</Badge> : '—'}</td>
              <td>{f.pod}</td><td>{f.members}</td>
              <td>{f.churn_risk ? <Badge tone="warn">{(f.churn_reasons ?? []).join(', ')}</Badge> : <span className="muted">—</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export function FamilyDetail() {
  const { id } = useParams();
  const { s, t, lang } = useI18n();
  const { data, error, reload } = useApi<any>(`/admin/families/${id}`, [id]);
  const started = useRef(Date.now());
  // §14 proxy metric: coordinator time in dashboard per family.
  useEffect(() => () => { const seconds = Math.round((Date.now() - started.current) / 1000); if (seconds > 2) api('/me/analytics', { method: 'POST', body: { name: 'dashboard_family_time', parentId: id, props: { seconds } } }).catch(() => {}); }, [id]);
  const [plan, setPlan] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const p = data.parent;
  const publish = async () => {
    try { await api(`/admin/parents/${id}/care-plans`, { method: 'POST', body: { content: JSON.parse(plan) } }); setMsg('✓'); reload(); } catch (e: any) { setMsg(e.code ?? 'invalid JSON'); }
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>{p.name} <span className="pill">{p.status}</span></h1>
      <div className="grid">
        <Section title={s.family.parent}>
          <p>{s.family.address}: {p.address} ({p.neighborhood}) <a href={`https://maps.google.com/?q=${p.location.lat},${p.location.lng}`} target="_blank" rel="noreferrer">map</a></p>
          <p>{s.family.phone}: <span dir="ltr">{p.phone ?? '—'}</span> · {p.language} · carer: {p.carerPreference}</p>
          <p>Allergies: {p.allergies.has ? <Badge tone="warn">{p.allergies.text}</Badge> : s.common.no} · Mobility: {p.mobilityNotes}</p>
          <h3>{s.family.consents}</h3>
          <div className="row">{data.consents.map((c: any) => <Badge key={c.type} tone={c.granted ? 'ok' : 'neutral'}>{c.type}: {c.granted ? s.common.yes : s.common.no}</Badge>)}</div>
        </Section>
        <Section title={s.family.members}>
          <ul>{data.members.map((m: any) => <li key={m.id}>{m.first_name || m.display_name} {m.whatsapp_opt_in && <span className="pill">WhatsApp</span>}</li>)}</ul>
          <h3>{s.family.subscription}</h3>
          {data.subscription ? <p>{data.subscription.plan_code} · {data.subscription.currency} · <b>{data.subscription.status}</b> · until {fmtDateTime(data.subscription.current_period_end, lang)} · •••• {data.subscription.card_last4}</p> : <p>—</p>}
        </Section>
        <Section title={s.family.careTeam}>
          <ul>{data.careTeam.map((c: any) => <li key={c.user_id + c.started_at}>{c.first_name} ({c.role}) {fmtDateTime(c.started_at, lang)} → {c.ended_at ? fmtDateTime(c.ended_at, lang) : 'now'}</li>)}</ul>
          {data.replacements.filter((r: any) => !r.resolved_at).map((r: any) => <p key={r.id}><Badge tone="warn">Replacement requested</Badge> {r.reason} (target {fmtDateTime(r.target_at, lang)})</p>)}
        </Section>
      </div>
      <Section title={s.family.visits}>
        <table><tbody>{data.visits.map((v: any) => <tr key={v.id}><td>{fmtDateTime(v.scheduled_at, lang)}</td><td>{t(`visitType.${v.type}`)}</td><td>{v.staff ?? <Badge tone="warn">{s.schedule.unassigned}</Badge>}</td><td>{v.status === 'completed' ? <Badge tone="ok">{v.status}</Badge> : v.status === 'missed' ? <Badge tone="alert">{v.status}</Badge> : <Badge tone="neutral">{v.status}</Badge>}</td></tr>)}</tbody></table>
      </Section>
      <div className="grid">
        <Section title={s.family.escalations}><ul>{data.escalations.map((e: any) => <li key={e.id}>{fmtDateTime(e.created_at, lang)} · {e.trigger} · <b>{e.status}</b></li>)}</ul></Section>
        <Section title={s.family.concerns}><ul>{data.concerns.map((c: any) => <ConcernItem key={c.id} c={c} reload={reload} />)}</ul></Section>
        <Section title={s.family.meds}><ul>{data.medications.map((m: any) => <li key={m.id}>{m.name} {m.dose_text} — {m.times_of_day.join(', ')} {!m.active && '(stopped)'}</li>)}</ul></Section>
      </div>
      <Section title={s.family.carePlans}>
        <ul>{data.carePlans.map((c: any) => <li key={c.id}>v{c.version} · {c.status} · {fmtDateTime(c.published_at, lang)}</li>)}</ul>
        <label>{s.family.publishPlan}<textarea dir="ltr" rows={6} style={{ width: '100%', fontFamily: 'monospace' }} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder='{"visitRules":[{"type":"nurse","freq":"weekly","weekdays":[0],"time":"10:00","durationMin":45}],"goals":[],"included":[],"notIncluded":[],"carerPreferences":{"gender":"female","languages":["ar"]}}' /></label>
        <div className="row"><button onClick={publish} disabled={!plan}>{s.common.save}</button>{msg && <span>{msg}</span>}</div>
      </Section>
    </div>
  );
}

function ConcernItem({ c, reload }: { c: any; reload: () => void }) {
  const { s } = useI18n();
  const [note, setNote] = useState('');
  return (
    <li>
      {c.ref} · {c.category} · <b>{c.status}</b> {c.safety_flag && <Badge tone="warn">{s.today.safety}</Badge>}
      {c.status !== 'resolved' && (
        <div className="row"><input aria-label={s.family.resolution} placeholder={s.family.resolution} value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="secondary" disabled={note.length < 3} onClick={() => api(`/admin/concerns/${c.id}`, { method: 'POST', body: { status: 'resolved', resolution: note } }).then(reload)}>{s.family.resolve}</button></div>
      )}
    </li>
  );
}
