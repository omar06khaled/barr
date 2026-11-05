import { useState } from 'react';
import { api } from '../api';
import { Badge, Loading, Section, fmtDateTime, fmtMoney, useApi } from '../components';
import { useI18n } from '../i18n';

export function Payments() {
  const { s, lang } = useI18n();
  const { data, error, reload } = useApi<any>('/admin/payments');
  const [refund, setRefund] = useState<{ id: string; amount: string; reason: string } | null>(null);
  if (!data) return <Loading error={error} />;
  const doRefund = async () => { try { await api(`/admin/payments/${refund!.id}/refund`, { method: 'POST', body: { amount: Number(refund!.amount), reason: refund!.reason } }); setRefund(null); reload(); } catch (e: any) { alert(e.code); } };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>{s.nav.payments}</h1>
      <div className="grid">
        <Section title={s.payments.revenue}>{data.revenueByCurrency.map((r: any) => <p key={r.currency}><b>{fmtMoney(r.gross, r.currency, lang)}</b> <span className="muted">({r.n})</span></p>)}</Section>
        <Section title={s.payments.subscriptions}><table><tbody>{data.subscriptions.map((r: any, i: number) => <tr key={i}><td>{r.status}</td><td>{r.plan_code}</td><td>{r.currency}</td><td>{r.n}</td></tr>)}</tbody></table></Section>
      </div>
      <Section title={s.payments.failures}>
        <table><tbody>{data.failures.map((f: any) => <tr key={f.id}><td>{f.name}</td><td>{f.status === 'paused' ? <Badge tone="alert">paused</Badge> : <Badge tone="warn">past due</Badge>}</td><td>attempts: {f.failed_attempts}</td><td className="muted">next: {fmtDateTime(f.next_retry_at, lang)}</td></tr>)}</tbody></table>
      </Section>
      <Section title={s.payments.recent}>
        <table><tbody>{data.recent.map((p: any) => (
          <tr key={p.id}><td>{fmtDateTime(p.created_at, lang)}</td><td>{p.name}</td><td>{p.kind}</td><td>{fmtMoney(p.amount, p.currency, lang)}</td>
            <td>{p.status === 'succeeded' ? <Badge tone="ok">{p.status}</Badge> : p.status === 'failed' ? <Badge tone="alert">{p.status}</Badge> : <Badge tone="neutral">{p.status}</Badge>} <span className="muted">{p.failure_reason}</span></td>
            <td>{['succeeded', 'partially_refunded'].includes(p.status) && <button className="secondary" onClick={() => setRefund({ id: p.id, amount: '', reason: '' })}>{s.payments.refund}</button>}</td></tr>
        ))}</tbody></table>
        {refund && (
          <div className="row card sand" style={{ marginTop: 12 }}>
            <input aria-label={s.payments.amount} placeholder={s.payments.amount} value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} />
            <input aria-label={s.payments.reason} placeholder={s.payments.reason} value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} />
            <button className="danger" onClick={doRefund} disabled={!Number(refund.amount) || refund.reason.length < 3}>{s.payments.refund}</button>
            <button className="secondary" onClick={() => setRefund(null)}>{s.common.cancel}</button>
          </div>
        )}
      </Section>
      <Section title={s.payments.passThrough}>
        <table><tbody>{data.passThrough.map((p: any) => <tr key={p.id}><td>{p.name}</td><td>{p.category}</td><td>{p.description}</td><td>{fmtMoney(p.amount, p.currency, lang)} <span className="pill">at cost</span></td><td>{p.handling_fee ? `+ fee ${fmtMoney(p.handling_fee, p.currency, lang)}` : ''}</td><td>{p.invoice_id ? 'invoiced' : 'next invoice'}</td></tr>)}</tbody></table>
      </Section>
    </div>
  );
}
