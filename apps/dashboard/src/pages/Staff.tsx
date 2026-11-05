import { useState } from 'react';
import { api } from '../api';
import { Badge, Loading, Section, fmtDateTime, useApi } from '../components';
import { useI18n } from '../i18n';

const ITEMS = ['id_checked', 'background_check', 'reference_check', 'training'] as const;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export function Staff() {
  const { s, t, lang } = useI18n();
  const { data, error, reload } = useApi<any>('/admin/staff');
  const now = new Date();
  const rota = useApi<any>(`/admin/oncall?from=${new Date(now.getTime() - 86_400_000).toISOString()}&to=${new Date(now.getTime() + 14 * 86_400_000).toISOString()}`);
  const settings = useApi<any>('/admin/settings');
  const [form, setForm] = useState({ phone: '', firstName: '', role: 'nurse', gender: 'female' });
  const [shift, setShift] = useState({ userId: '', tier: 'primary', startsAt: '', endsAt: '' });
  const setItem = async (id: string, item: string, on: boolean) => { await api(`/admin/staff/${id}/verification`, { method: 'PUT', body: { item, completedOn: on ? new Date().toISOString().slice(0, 10) : null } }); reload(); };
  const add = async () => { try { await api('/admin/staff', { method: 'POST', body: { ...form, languages: ['ar'] } }); setForm({ ...form, phone: '', firstName: '' }); reload(); } catch (e: any) { alert(e.code); } };
  const addShift = async () => { try { await api('/admin/oncall', { method: 'POST', body: { ...shift, cityId: settings.data?.cities?.[0]?.id, startsAt: new Date(shift.startsAt).toISOString(), endsAt: new Date(shift.endsAt).toISOString() } }); rota.reload(); } catch (e: any) { alert(e.code); } };
  if (!data) return <Loading error={error} />;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>{s.nav.staff}</h1>
      <Section title={s.nav.staff}>
        <table>
          <thead><tr><th>Name</th><th>{s.staff.role}</th><th>{s.staff.verified}</th><th>{s.staff.perf}</th><th /></tr></thead>
          <tbody>{data.items.map((x: any) => {
            const done = new Map((x.verification ?? []).map((v: any) => [v.item, v.completedOn]));
            return (
              <tr key={x.id} style={{ opacity: x.active ? 1 : 0.5 }}>
                <td>{x.first_name}<div className="muted">{x.languages?.join(', ')}</div></td>
                <td>{x.role}</td>
                <td>
                  {x.verified ? <Badge tone="ok">{s.staff.verified}</Badge> : <Badge tone="warn">{s.staff.notVerified}</Badge>}
                  <div className="stack" style={{ marginTop: 6 }}>{ITEMS.map((i) => (
                    <label key={i} className="row" style={{ gap: 4 }}><input type="checkbox" checked={done.has(i)} onChange={(e) => setItem(x.id, i, e.target.checked)} disabled={!x.active} />{t(`staff.${{ id_checked: 'idChecked', background_check: 'background', reference_check: 'reference', training: 'training' }[i]}`)} <span className="muted">{String(done.get(i) ?? '')}</span></label>
                  ))}</div>
                </td>
                <td className="muted">{s.staff.completion}: {pct(x.completed_30d, x.due_30d)}<br />{s.staff.onTime}: {pct(x.on_time_30d, x.completed_30d)}<br />{s.staff.reportDelay}: {x.avg_report_delay_s != null ? `${Math.round(x.avg_report_delay_s / 60)} min` : '—'}</td>
                <td>{x.active && x.role !== 'admin' && <button className="danger" onClick={async () => { if (confirm(s.staff.deactivate + '?')) { await api(`/admin/staff/${x.id}/deactivate`, { method: 'POST' }); reload(); } }}>{s.staff.deactivate}</button>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </Section>
      <div className="grid">
        <Section title={s.staff.add}>
          <div className="stack">
            <input aria-label="phone" dir="ltr" placeholder="+20…" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <input aria-label="first name" placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
            <select aria-label={s.staff.role} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{['coordinator', 'nurse', 'doctor', 'caregiver', 'oncall_doctor', 'admin'].map((r) => <option key={r}>{r}</option>)}</select>
            <select aria-label="gender" value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}><option>female</option><option>male</option></select>
            <button onClick={add} disabled={!form.phone || !form.firstName}>{s.staff.add}</button>
          </div>
        </Section>
        <Section title={s.staff.rota}>
          {!rota.data ? <Loading error={rota.error} /> : <ul>{rota.data.items.map((r: any) => <li key={r.id}><span className="pill">{r.tier}</span> {r.first_name}: {fmtDateTime(r.starts_at, lang)} → {fmtDateTime(r.ends_at, lang)} <button className="secondary" onClick={() => api(`/admin/oncall/${r.id}`, { method: 'DELETE' }).then(rota.reload)}>✕</button></li>)}</ul>}
          <div className="stack">
            <select aria-label="doctor" value={shift.userId} onChange={(e) => setShift({ ...shift, userId: e.target.value })}><option value="">—</option>{data.items.filter((x: any) => ['doctor', 'oncall_doctor'].includes(x.role) && x.verified && x.active).map((x: any) => <option key={x.id} value={x.id}>{x.first_name}</option>)}</select>
            <select aria-label="tier" value={shift.tier} onChange={(e) => setShift({ ...shift, tier: e.target.value })}><option>primary</option><option>backup</option></select>
            <input aria-label="starts" type="datetime-local" value={shift.startsAt} onChange={(e) => setShift({ ...shift, startsAt: e.target.value })} />
            <input aria-label="ends" type="datetime-local" value={shift.endsAt} onChange={(e) => setShift({ ...shift, endsAt: e.target.value })} />
            <button onClick={addShift} disabled={!shift.userId || !shift.startsAt || !shift.endsAt}>{s.staff.addShift}</button>
          </div>
        </Section>
      </div>
    </div>
  );
}
