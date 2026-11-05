import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Badge, Loading, Section, fmtAge, fmtTime, useApi } from '../components';
import { useI18n } from '../i18n';

const DECISIONS = ['phone_advice', 'nurse_dispatched', 'ambulance_called', 'hospital_transfer'] as const;

function EscalationRow({ e, reload }: { e: any; reload: () => void }) {
  const { s, t, lang } = useI18n();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body?: unknown) => { setBusy(true); try { await api(`/escalations/${e.id}/${path}`, { method: 'POST', body }); reload(); } catch (err: any) { alert(err.code); } finally { setBusy(false); } };
  const age = e.age_s as number;
  return (
    <tr className="alert-row">
      <td><Badge tone="alert">{t(`escalation.status.${e.status}`)}</Badge><div className="muted">{e.severity === 'urgent' ? `‼ ${s.today.urgent}` : s.today.nonUrgent} · {e.trigger}</div></td>
      <td><Link to={`/families/${e.parent_id}`}>{e.parent_name}</Link><div className="muted">{fmtTime(e.created_at, lang)}</div></td>
      <td><b>{fmtAge(age)}</b>{!e.acknowledged_at && age > 120 && <div><Badge tone="warn">2 min ✗</Badge></div>}</td>
      <td>{e.family_notified_at ? <Badge tone="ok">{s.today.familyTold}</Badge> : <Badge tone={age > 600 ? 'warn' : 'neutral'}>{s.today.familyTold}: {s.today.notYet}</Badge>}</td>
      <td>
        <div className="stack">
          <div className="row">
            {!e.acknowledged_at && <button disabled={busy} onClick={() => act('acknowledge')}>{s.today.ack}</button>}
            <select aria-label={s.today.decide} disabled={busy} defaultValue="" onChange={(ev) => ev.target.value && act('decision', { decision: ev.target.value })}>
              <option value="">{s.today.decide}…</option>
              {DECISIONS.map((d) => <option key={d} value={d}>{t(`escalation.decision.${d}`)}</option>)}
            </select>
          </div>
          <div className="row">
            <input aria-label={s.today.closeNote} placeholder={s.today.closeNote} value={note} onChange={(ev) => setNote(ev.target.value)} />
            <button className="secondary" disabled={busy || note.trim().length < 3} onClick={() => act('follow-up', { note, visibleToFamily: true }).then(() => setNote(''))}>{s.today.followUp}</button>
            <button className="danger" disabled={busy || note.trim().length < 3} onClick={() => act('close', { note })}>{s.today.close}</button>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function Today() {
  const { s, lang } = useI18n();
  const { data, error, reload } = useApi<any>('/admin/today', [], 15_000);
  if (!data) return <Loading error={error} />;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><h1>{s.nav.today} · {data.date}</h1><button className="secondary" onClick={reload}>{s.common.refresh}</button></div>
      <Section title={`${s.today.openEscalations} (${data.openEscalations.length})`}>
        {data.openEscalations.length === 0 ? <p><Badge tone="ok">{s.today.none}</Badge></p> : (
          <table><thead><tr><th>{s.today.status}</th><th>{s.today.parent}</th><th>{s.today.age}</th><th>{s.today.familyTold}</th><th /></tr></thead>
            <tbody>{data.openEscalations.map((e: any) => <EscalationRow key={e.id} e={e} reload={reload} />)}</tbody></table>
        )}
      </Section>
      <div className="grid">
        <Section title={s.today.overdueConcerns}>
          <table><tbody>{data.concerns.map((c: any) => (
            <tr key={c.id}><td>{c.overdue ? <Badge tone="alert">{s.today.overdue}</Badge> : <Badge tone="neutral">{s.today.due}</Badge>} {c.safety_flag && <Badge tone="warn">{s.today.safety}</Badge>}</td>
              <td><Link to={`/families/${c.parent_id}`}>{c.parent_name}</Link><div className="muted">{c.ref} · {c.category}</div></td><td className="muted">{fmtTime(c.deadline, lang)}</td></tr>
          ))}</tbody></table>
        </Section>
        <Section title={s.today.missedDoses}>
          {data.missedDoses.length === 0 ? <Badge tone="ok">{s.today.none}</Badge> : <table><tbody>{data.missedDoses.map((d: any) => (
            <tr key={d.id}><td><Badge tone="warn">✗</Badge></td><td><Link to={`/families/${d.parent_id}`}>{d.parent_name}</Link></td><td>{d.medicine}</td><td className="muted">{fmtTime(d.scheduled_at, lang)}</td></tr>
          ))}</tbody></table>}
        </Section>
        <Section title={s.today.noContact}>
          {data.noContact.length === 0 ? <Badge tone="ok">{s.today.none}</Badge> : <ul>{data.noContact.map((n: any) => <li key={n.parent_id}><Badge tone="warn">{n.parent_name}</Badge></li>)}</ul>}
        </Section>
        <Section title={s.today.visits}>
          <div className="row">{Object.entries(data.visits).map(([k, v]) => <span key={k} className="pill">{k}: <b>{String(v)}</b></span>)}</div>
          <h3 style={{ marginTop: 16 }}>{s.today.onCall}</h3>
          <ul>{data.onCall.map((o: any) => <li key={o.user_id + o.tier}>{o.first_name} — {o.tier}</li>)}</ul>
        </Section>
        <Section title={`${s.today.tasks} (${data.tasks.length})`}>
          <table><tbody>{data.tasks.slice(0, 25).map((t: any) => (
            <tr key={t.id}><td><span className="pill">{t.kind}</span></td><td>{t.parent_id ? <Link to={`/families/${t.parent_id}`}>{t.title}</Link> : t.title}</td><td className="muted">{fmtTime(t.due_at, lang)}</td>
              <td><button className="secondary" onClick={() => api(`/tasks/${t.id}/done`, { method: 'POST' }).then(reload)}>✓</button></td></tr>
          ))}</tbody></table>
        </Section>
      </div>
    </div>
  );
}
