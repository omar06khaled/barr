import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDays, groupRoute, localParts, zonedTimeToUtc } from '@barr/shared';
import { api } from '../api';
import { Badge, Loading, Section, fmtTime, useApi } from '../components';
import { useI18n } from '../i18n';

export function Schedule() {
  const { s, t, lang } = useI18n();
  const [date, setDate] = useState(() => localParts(new Date(), 'Africa/Cairo').date);
  const from = zonedTimeToUtc(date, '00:00', 'Africa/Cairo').toISOString(), to = zonedTimeToUtc(addDays(date, 1), '00:00', 'Africa/Cairo').toISOString();
  const { data, error, reload } = useApi<any>(`/admin/schedule?from=${from}&to=${to}`, [date]);
  const staff = useApi<any>('/admin/staff');
  const byStaff = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const v of data?.items ?? []) m.set(v.staff ?? s.schedule.unassigned, [...(m.get(v.staff ?? s.schedule.unassigned) ?? []), v]);
    return [...m.entries()];
  }, [data, s]);
  const reassign = async (visitId: string, staffId: string) => { try { await api(`/admin/visits/${visitId}/assign`, { method: 'POST', body: { staffId: staffId || null } }); reload(); } catch (e: any) { alert(e.code); } };
  const override = async (visitId: string) => { const reason = prompt(s.schedule.reason); if (reason) { try { await api(`/admin/visits/${visitId}/check-in-override`, { method: 'POST', body: { reason } }); alert('✓'); } catch (e: any) { alert(e.code); } } };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row"><h1>{s.nav.schedule}</h1><label>{s.schedule.date} <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label></div>
      {!data ? <Loading error={error} /> : byStaff.map(([name, visits]) => (
        <Section key={name} title={`${name} (${visits.length})`}>
          <p className="muted">{s.schedule.route}: {groupRoute(visits.map((v) => ({ ...v, neighborhood: v.neighborhood || '—', scheduledAt: new Date(v.scheduled_at) }))).map((g) => `${g.neighborhood} (${g.visits.length})`).join(' → ')}</p>
          <table><tbody>{visits.map((v) => (
            <tr key={v.id}>
              <td>{fmtTime(v.scheduled_at, lang)}</td><td>{t(`visitType.${v.type}`)}</td>
              <td><Link to={`/families/${v.parent_id}`}>{v.parent_name}</Link><div className="muted">{v.neighborhood}</div></td>
              <td>{v.status === 'completed' ? <Badge tone="ok">{v.status}</Badge> : v.status === 'in_progress' ? <Badge tone="neutral">{v.status}</Badge> : <span className="pill">{v.status}</span>}</td>
              <td>{v.status === 'scheduled' && (
                <div className="row">
                  <select aria-label={s.schedule.reassign} value={v.staff_user_id ?? ''} onChange={(e) => reassign(v.id, e.target.value)}>
                    <option value="">{s.schedule.unassigned}</option>
                    {(staff.data?.items ?? []).filter((x: any) => x.active && x.verified && x.role !== 'admin').map((x: any) => <option key={x.id} value={x.id}>{x.first_name} ({x.role})</option>)}
                  </select>
                  <button className="secondary" onClick={() => override(v.id)}>{s.schedule.override}</button>
                </div>
              )}</td>
            </tr>
          ))}</tbody></table>
        </Section>
      ))}
    </div>
  );
}
