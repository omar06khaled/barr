import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakePaymentProvider } from '../src/providers/payment';
import { activate, api, makeHarness, newFamily, signInPhone, type Harness } from './harness';

let h: Harness;
beforeEach(async () => { if (h) await h.close(); h = await makeHarness(new Date('2026-11-05T09:00:00Z')); });
afterAll(async () => { await h.close(); });

async function webhook(body: Record<string, unknown>, signature?: string) {
  const raw = JSON.stringify(body);
  return h.app.inject({ method: 'POST', url: '/v1/webhooks/payments/fake', payload: raw, headers: { 'content-type': 'application/json', signature: signature ?? FakePaymentProvider.sign(raw) } });
}
const sub = async (parentId: string) => (await h.owner.query(`select * from subscriptions where parent_id=$1 order by created_at desc limit 1`, [parentId])).rows[0];
const notifTypes = async () => (await h.owner.query(`select type from notifications order by created_at`)).rows.map((r) => r.type);

/** Subscribe + simulate the hosted-page success webhook. */
async function paidSubscription(currency: 'USD' | 'SAR' | 'AED' = 'USD', plan = 'visit') {
  const f = await newFamily(h);
  const r = await api(h, f.token, 'POST', '/subscriptions', { parentId: f.parentId, planCode: plan, currency });
  expect(r.status).toBe(200);
  expect(r.body.redirectUrl).toMatch(/^https:\/\/fake-pay/);
  const pay = (await h.owner.query(`select * from payments where subscription_id=$1`, [r.body.subscriptionId])).rows[0];
  const wh = await webhook({ eventId: 'evt-1', orderId: pay.idempotency_key, providerRef: 'TRX-1', status: 'succeeded', token: 'tok_abc', last4: '4242', brand: 'mada', amount: pay.amount, currency });
  expect(wh.statusCode).toBe(200);
  return { f, subscriptionId: r.body.subscriptionId as string, payment: pay };
}

describe('F9 payments (fake provider = sandbox stand-in)', () => {
  it('subscribe → hosted page → signed webhook activates subscription (prepaid month), stores only token + last4, idempotent', async () => {
    const { f, subscriptionId, payment } = await paidSubscription('SAR');
    const s = await sub(f.parentId);
    expect(s.status).toBe('active');
    expect(s.card_last4).toBe('4242');
    expect(s.card_brand).toBe('mada');
    expect(s.payment_token_enc).not.toContain('tok_abc'); // encrypted at rest
    expect(s.current_period_end.toISOString().slice(0, 10)).toBe('2026-12-05');
    expect(payment.amount).toBe(22100);
    expect((await h.owner.query(`select status from parents where id=$1`, [f.parentId])).rows[0].status).toBe('active');
    expect((await h.owner.query(`select status from invoices where subscription_id=$1`, [subscriptionId])).rows[0].status).toBe('paid');
    // Same webhook again → duplicate, nothing changes.
    const again = await webhook({ eventId: 'evt-1', orderId: payment.idempotency_key, providerRef: 'TRX-1', status: 'succeeded', amount: payment.amount, currency: 'SAR' });
    expect(again.json()).toEqual({ duplicate: true });
    // Bad signature rejected.
    const bad = await webhook({ eventId: 'evt-2', orderId: payment.idempotency_key, status: 'succeeded', amount: 1, currency: 'SAR' }, 'deadbeef');
    expect(bad.statusCode).toBe(401);
    expect(await notifTypes()).toContain('payment_succeeded');
  });

  it('renewal at period end charges the token and extends the period; pass-through on the next invoice is itemised at cost', async () => {
    const { f, subscriptionId } = await paidSubscription('USD');
    const pt = await api(h, h.token('coordinator'), 'POST', '/pass-through-charges', { parentId: f.parentId, category: 'medicine', description: 'Amlodipine 5mg x30', amount: 450, currency: 'USD', handlingFee: 100, receiptKey: `receipt/${f.parentId}/r1.jpg` });
    expect(pt.status).toBe(200);
    expect(pt.body.charged).toBe('next_invoice');
    h.clock.set(new Date('2026-12-05T09:30:00Z'));
    await h.worker.tickCron(h.clock.now(), [{ name: 'payments.renewals', kind: 'interval', minutes: 60 }]);
    await h.worker.drain(h.clock.now());
    expect(h.payments.charges).toHaveLength(1);
    expect(h.payments.charges[0]).toMatchObject({ amount: 5900 + 450 + 100, token: 'tok_abc', currency: 'USD' });
    const s = await sub(f.parentId);
    expect(s.status).toBe('active');
    expect(s.current_period_end.toISOString().slice(0, 10)).toBe('2027-01-05');
    const inv = (await h.owner.query(`select * from invoices where subscription_id=$1 order by issued_at desc limit 1`, [subscriptionId])).rows[0];
    expect(inv.lines.map((l: any) => l.kind)).toEqual(['subscription', 'pass_through', 'handling_fee']);
    expect(inv.lines[1].atCost).toBe(true);
    // Running the renewal sweep again does not double-charge.
    await h.worker.tickCron(new Date('2026-12-05T10:31:00Z'), [{ name: 'payments.renewals', kind: 'interval', minutes: 60 }]);
    await h.worker.drain(new Date('2026-12-05T10:31:00Z'));
    expect(h.payments.charges).toHaveLength(1);
  });

  it('failed renewal → retries on day 1, 3, 7 with family notifications → paused (not cancelled) + coordinator task', async () => {
    const { f } = await paidSubscription('AED');
    h.payments.failNextCharges = 4;
    const t0 = new Date('2026-12-05T09:30:00Z');
    h.clock.set(t0);
    await h.worker.tickCron(t0, [{ name: 'payments.renewals', kind: 'interval', minutes: 60 }]);
    await h.worker.drain(t0);
    let s = await sub(f.parentId);
    expect(s.status).toBe('past_due');
    expect(s.next_retry_at.toISOString()).toBe('2026-12-06T09:30:00.000Z');
    const retries = (await h.owner.query(`select run_at from jobs where name='payment.retry' order by run_at`)).rows;
    expect(retries.map((r) => r.run_at.toISOString())).toEqual(['2026-12-06T09:30:00.000Z']);
    for (const [day, expectStatus] of [[1, 'past_due'], [3, 'past_due'], [7, 'paused']] as const) {
      const t = new Date(t0.getTime() + day * 86_400_000);
      h.clock.set(t);
      await h.worker.drain(t);
      s = await sub(f.parentId);
      expect(s.status).toBe(expectStatus);
    }
    expect(h.payments.charges).toHaveLength(4);
    const types = await notifTypes();
    expect(types.filter((t) => t === 'payment_failed')).toHaveLength(3);
    expect(types).toContain('payment_paused');
    expect((await h.owner.query(`select status from parents where id=$1`, [f.parentId])).rows[0].status).toBe('paused');
    expect((await h.owner.query(`select count(*)::int n from tasks where kind='payment_paused'`)).rows[0].n).toBe(1);

    // Family updates card → pays the outstanding invoice → service resumes.
    const fam = (await signInPhone(h.app, '+966501234567')).accessToken;
    const pm = await api(h, fam, 'POST', `/subscriptions/${s.id}/payment-method`);
    expect(pm.status).toBe(200);
    const p = (await h.owner.query(`select * from payments where subscription_id=$1 and status='pending'`, [s.id])).rows[0];
    await webhook({ eventId: 'evt-recover', orderId: p.idempotency_key, providerRef: 'TRX-9', status: 'succeeded', token: 'tok_new', last4: '1111', amount: p.amount, currency: 'AED' });
    s = await sub(f.parentId);
    expect(s.status).toBe('active');
    expect(s.card_last4).toBe('1111');
  });

  it('cancel takes effect at end of the paid month; any family member can do it and siblings are told', async () => {
    const { f, subscriptionId } = await paidSubscription('USD');
    const c = await api(h, f.token, 'POST', `/subscriptions/${subscriptionId}/cancel`);
    expect(c.status).toBe(200);
    expect((await sub(f.parentId)).status).toBe('cancel_at_period_end');
    h.clock.set(new Date('2026-12-05T10:00:00Z'));
    await h.worker.tickCron(h.clock.now(), [{ name: 'payments.renewals', kind: 'interval', minutes: 60 }]);
    await h.worker.drain(h.clock.now());
    expect(h.payments.charges).toHaveLength(0);
    expect((await h.owner.query(`select status from subscriptions where id=$1`, [subscriptionId])).rows[0].status).toBe('cancelled');
  });

  it('refunds: admin only, cannot exceed payment; immediate pass-through charge (CONFIG)', async () => {
    const { f, payment } = await paidSubscription('USD');
    const paid = (await h.owner.query(`select id from payments where id=$1`, [payment.id])).rows[0];
    expect((await api(h, f.token, 'POST', `/admin/payments/${paid.id}/refund`, { amount: 100, reason: 'test' })).status).toBe(403);
    expect((await api(h, h.token('coordinator'), 'POST', `/admin/payments/${paid.id}/refund`, { amount: 100, reason: 'test' })).status).toBe(403);
    expect((await api(h, h.token('admin'), 'POST', `/admin/payments/${paid.id}/refund`, { amount: 99999, reason: 'too much' })).status).toBe(400);
    const r = await api(h, h.token('admin'), 'POST', `/admin/payments/${paid.id}/refund`, { amount: 2000, reason: 'Missed visit goodwill' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('succeeded');
    expect((await h.owner.query(`select status from payments where id=$1`, [paid.id])).rows[0].status).toBe('partially_refunded');
    expect((await h.owner.query(`select count(*)::int n from audit_log where action='payment.refund'`)).rows[0].n).toBe(1);

    expect((await api(h, h.token('admin'), 'PATCH', '/admin/settings/config', { passThroughBilling: 'immediate' })).status).toBe(200);
    const pt = await api(h, h.token('coordinator'), 'POST', '/pass-through-charges', { parentId: f.parentId, category: 'ambulance', description: 'Private ambulance to Anglo-American hospital', amount: 3500, currency: 'USD', handlingFee: null, receiptKey: `receipt/${f.parentId}/amb.jpg` });
    expect(pt.body.charged).toBe('succeeded');
    const inv = (await h.owner.query(`select * from invoices where id=$1`, [pt.body.invoiceId])).rows[0];
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({ kind: 'pass_through', atCost: true, amount: 3500 });
  });

  it('caregiver plan needs a per-family price; plan change applies next month and notifies siblings', async () => {
    const f = await newFamily(h);
    const r = await api(h, f.token, 'POST', '/subscriptions', { parentId: f.parentId, planCode: 'caregiver', currency: 'USD' });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('caregiver_price_must_be_set_per_family');
    expect((await api(h, h.token('admin'), 'PUT', `/admin/parents/${f.parentId}/custom-price`, { kind: 'caregiver', planCode: 'caregiver', currency: 'USD', amount: 42000 })).status).toBe(200);
    const ok = await api(h, f.token, 'POST', '/subscriptions', { parentId: f.parentId, planCode: 'caregiver', currency: 'USD' });
    expect(ok.status).toBe(200);
    expect(ok.body.amount).toBe(42000);
  });
});
