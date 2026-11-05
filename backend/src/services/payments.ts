import {
  addMonth, buildInvoiceLines, formatMoney, invoiceTotal, retrySchedule, statusAfterFailedAttempt, subscriptionPrice,
  type Currency, type PlanCode, type PlanPrice, type PassThroughCharge,
} from '@barr/shared';
import type { Actor, Sql } from '../db/pool';
import type { Deps } from '../deps';
import { enqueue } from '../jobs/queue';
import { AppError, badRequest, notFound } from '../lib/errors';
import { audit, track } from './audit';
import { createTask, notify } from './notifications';
import { getConfig } from './settings';
import { notifySiblings } from './families';

async function prices(c: Sql): Promise<PlanPrice[]> {
  return (await c.query(`select plan_code "planCode", currency, amount from plan_prices`)).rows;
}

const periodLabel = (start: Date) => start.toISOString().slice(0, 7);
const money = (amount: number, currency: string) => ({ en: formatMoney({ amount, currency: currency as Currency }, 'en'), ar: formatMoney({ amount, currency: currency as Currency }, 'ar') });
const planName = (code: string) => ({ en: { visit: 'Visit', plus: 'Plus', caregiver: 'Caregiver' }[code] ?? code, ar: { visit: 'زيارة', plus: 'بلس', caregiver: 'مرافق' }[code] ?? code });

async function nextInvoiceNumber(c: Sql, now: Date) {
  const n = (await c.query(`select nextval('invoice_seq') n`)).rows[0].n;
  return `BARR-${now.toISOString().slice(0, 7).replace('-', '')}-${String(n).padStart(6, '0')}`;
}

async function createInvoice(c: Sql, now: Date, sub: any, opts: { includeSubscription: boolean; periodStart: Date | null; periodEnd: Date | null; planCode?: string; amount?: number; passThroughs?: boolean }) {
  const pts: PassThroughCharge[] = opts.passThroughs
    ? (await c.query(`select id, category, description, amount, currency, handling_fee "handlingFee" from pass_through_charges where parent_id=$1 and invoice_id is null and currency=$2`, [sub.parent_id, sub.currency])).rows
    : [];
  const lines = buildInvoiceLines({
    currency: sub.currency,
    subscription: opts.includeSubscription ? { planCode: (opts.planCode ?? sub.plan_code) as PlanCode, price: { amount: opts.amount!, currency: sub.currency }, periodLabel: periodLabel(opts.periodStart!) } : undefined,
    passThroughs: pts,
  });
  const inv = (await c.query(
    `insert into invoices (number, family_id, parent_id, city_id, pod_id, subscription_id, currency, lines, total, status, period_start, period_end, issued_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'issued',$10,$11,$12) returning id, total`,
    [await nextInvoiceNumber(c, now), sub.family_id, sub.parent_id, sub.city_id, sub.pod_id, sub.id, sub.currency, JSON.stringify(lines), invoiceTotal(lines), opts.periodStart, opts.periodEnd, now],
  )).rows[0];
  if (pts.length) await c.query(`update pass_through_charges set invoice_id=$1 where id = any($2)`, [inv.id, pts.map((p) => p.id)]);
  return inv as { id: string; total: number };
}

/** F9 subscribe: creates a pending subscription + payment and returns the provider's hosted page URL (tokenised). */
export async function subscribe(d: Deps, c: Sql, actor: Actor, a: { parentId: string; planCode: PlanCode; currency: Currency }) {
  const now = d.clock.now();
  const p = (await c.query(`select p.*, u.email, u.display_name from parents p, users u where p.id=$1 and u.id=$2`, [a.parentId, actor.userId])).rows[0];
  if (!p) throw notFound();
  const live = (await c.query(`select id, status from subscriptions where parent_id=$1 and status <> 'cancelled'`, [a.parentId])).rows[0];
  if (live && live.status !== 'pending_payment') throw new AppError(409, 'subscription_exists');
  if (live) await c.query(`update subscriptions set status='cancelled', updated_at=$2 where id=$1`, [live.id, now]);
  const custom = a.planCode === 'caregiver'
    ? (await c.query(`select value from settings where key=$1`, [`caregiver_price:${a.parentId}:${a.currency}`])).rows[0]?.value?.amount ?? null
    : (await c.query(`select value from settings where key=$1`, [`founding_price:${a.parentId}:${a.planCode}:${a.currency}`])).rows[0]?.value?.amount ?? null;
  let price;
  try { price = subscriptionPrice({ planCode: a.planCode, currency: a.currency, prices: await prices(c), customAmount: custom }); }
  catch (e: any) { throw new AppError(422, e.message); }
  const sub = (await c.query(
    `insert into subscriptions (parent_id, family_id, city_id, pod_id, plan_code, currency, custom_amount, founding_family, provider, status, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_payment',$10,$10) returning *`,
    [p.id, p.family_id, p.city_id, p.pod_id, a.planCode, a.currency, custom, a.planCode !== 'caregiver' && custom != null, d.payments.name, now],
  )).rows[0];
  const start = now, end = addMonth(now);
  const inv = await createInvoice(c, now, sub, { includeSubscription: true, periodStart: start, periodEnd: end, amount: price.amount });
  const orderId = `sub:${sub.id}:initial`;
  const hosted = await d.payments.createHostedPayment({
    orderId, amount: inv.total, currency: a.currency, description: `Barr ${a.planCode} plan (prepaid monthly)`,
    customer: { name: p.display_name || 'Barr family', email: p.email }, language: 'ar',
    returnUrl: `${d.env.PUBLIC_BASE_URL}/v1/payments/return?sub=${sub.id}`, callbackUrl: `${d.env.PUBLIC_BASE_URL}/v1/webhooks/payments/${d.payments.name}`,
  });
  await c.query(`insert into payments (subscription_id, invoice_id, parent_id, provider, provider_ref, amount, currency, kind, status, idempotency_key, created_at) values ($1,$2,$3,$4,$5,$6,$7,'initial','pending',$8,$9)`, [
    sub.id, inv.id, p.id, d.payments.name, hosted.providerRef, inv.total, a.currency, orderId, now]);
  await audit(c, { actorUserId: actor.userId, action: 'subscription.create', entityType: 'subscription', entityId: sub.id, parentId: p.id, after: a });
  await track(c, 'subscribe_started', actor.userId, p.id, { plan: a.planCode, currency: a.currency });
  return { subscriptionId: sub.id as string, redirectUrl: hosted.redirectUrl, amount: inv.total, currency: a.currency };
}

/** Webhook (signature verified by caller). Idempotent by (provider, eventId) and by payment status. */
export async function handlePaymentWebhook(d: Deps, c: Sql, headers: Record<string, any>, raw: string) {
  if (!d.payments.verifyWebhook(headers, raw)) throw new AppError(401, 'bad_signature');
  const w = d.payments.parseWebhook(raw);
  const now = d.clock.now();
  const ins = await c.query(`insert into webhook_events (provider, event_id, payload) values ($1,$2,$3) on conflict do nothing`, [d.payments.name, w.eventId, JSON.parse(raw)]);
  if (!ins.rowCount) return { duplicate: true };
  const pay = (await c.query(`select * from payments where idempotency_key=$1 for update`, [w.orderId])).rows[0];
  if (!pay) { await c.query(`update webhook_events set processed_at=$3 where provider=$1 and event_id=$2`, [d.payments.name, w.eventId, now]); return { unknownOrder: true }; }
  if (pay.status !== 'pending') return { alreadyFinal: true };
  if (w.amount !== pay.amount || w.currency !== pay.currency) throw new AppError(422, 'amount_mismatch');
  const sub = (await c.query(`select s.*, p.name parent_name from subscriptions s join parents p on p.id=s.parent_id where s.id=$1 for update of s`, [pay.subscription_id])).rows[0];
  if (w.status === 'succeeded') {
    await c.query(`update payments set status='succeeded', provider_ref=$2, updated_at=$3 where id=$1`, [pay.id, w.providerRef, now]);
    await c.query(`update invoices set status='paid', paid_at=$2 where id=$1`, [pay.invoice_id, now]);
    const inv = (await c.query(`select period_start, period_end from invoices where id=$1`, [pay.invoice_id])).rows[0];
    await c.query(
      `update subscriptions set status='active', payment_token_enc=coalesce($2, payment_token_enc), card_last4=coalesce($3, card_last4), card_brand=coalesce($4, card_brand),
         current_period_start=$5, current_period_end=$6, failed_attempts=0, first_failure_at=null, next_retry_at=null, last_provider_ref=$7, updated_at=$8 where id=$1`,
      [sub.id, w.token ? d.crypto.encrypt(w.token) : null, w.last4 ?? null, w.brand ?? null, inv.period_start, inv.period_end, w.providerRef, now],
    );
    await c.query(`update parents set status='active' where id=$1 and status in ('onboarding','paused')`, [sub.parent_id]);
    await notify(c, now, { type: 'payment_succeeded', parentId: sub.parent_id, to: { family: sub.family_id }, vars: { amount: money(pay.amount, pay.currency), parent: sub.parent_name, plan: planName(sub.plan_code) }, dedupeKey: `payment:${pay.id}:ok` });
    await enqueue(c, 'visits.generate_parent', { parentId: sub.parent_id }, { runAt: now, dedupeKey: `visits.gen:${sub.parent_id}:activate:${pay.id}` });
    await track(c, 'subscription_paid', null, sub.parent_id, { kind: pay.kind });
  } else if (w.status === 'failed') {
    await c.query(`update payments set status='failed', failure_reason=$2, provider_ref=$3, updated_at=$4 where id=$1`, [pay.id, w.failureReason ?? 'declined', w.providerRef, now]);
    await c.query(`update invoices set status='failed' where id=$1`, [pay.invoice_id]);
  }
  await c.query(`update webhook_events set processed_at=$3 where provider=$1 and event_id=$2`, [d.payments.name, w.eventId, now]);
  return { processed: true };
}

/** Charge the stored token for one subscription (renewal or retry). Idempotent per (subscription, period, attempt). */
export async function chargeRenewal(d: Deps, c: Sql, now: Date, subscriptionId: string, attempt: number) {
  const cfg = await getConfig(c);
  const sub = (await c.query(`select s.*, p.name parent_name from subscriptions s join parents p on p.id=s.parent_id where s.id=$1 for update of s`, [subscriptionId])).rows[0];
  if (!sub || !['active', 'past_due', 'cancel_at_period_end'].includes(sub.status)) return { skipped: 'status' };
  if (sub.current_period_end > now) return { skipped: 'not_due' };
  if (sub.status === 'cancel_at_period_end') {
    await c.query(`update subscriptions set status='cancelled', updated_at=$2 where id=$1`, [sub.id, now]);
    await c.query(`update parents set status='cancelled' where id=$1`, [sub.parent_id]);
    await audit(c, { actorUserId: null, action: 'subscription.cancelled_at_period_end', entityType: 'subscription', entityId: sub.id, parentId: sub.parent_id });
    return { cancelled: true };
  }
  if (attempt > 0 && sub.status !== 'past_due') return { skipped: 'already_paid' };
  if (!sub.payment_token_enc) throw new Error('no_payment_token');
  const planCode = sub.next_plan_code ?? sub.plan_code;
  let price;
  const customAmount = planCode === sub.plan_code ? sub.custom_amount : null;
  try { price = subscriptionPrice({ planCode, currency: sub.currency, prices: await prices(c), customAmount }); }
  catch (e: any) { await createTask(c, { kind: 'pricing_error', parentId: sub.parent_id, title: `Cannot price renewal: ${e.message}`, dedupeKey: `pricing:${sub.id}:${sub.current_period_end.toISOString()}` }); return { skipped: 'pricing' }; }
  const periodStart = sub.current_period_end, periodEnd = addMonth(sub.current_period_end);
  const orderId = `sub:${sub.id}:${periodStart.toISOString().slice(0, 10)}:${attempt}`;
  const existing = (await c.query(`select id from payments where idempotency_key=$1`, [orderId])).rows[0];
  if (existing) return { skipped: 'duplicate' };
  let invoiceId = (await c.query(`select id from invoices where subscription_id=$1 and period_start=$2 and status in ('issued','failed') order by issued_at desc limit 1`, [sub.id, periodStart])).rows[0]?.id;
  let total;
  if (!invoiceId) {
    const inv = await createInvoice(c, now, sub, { includeSubscription: true, periodStart, periodEnd, planCode, amount: price.amount, passThroughs: cfg.passThroughBilling === 'next_invoice' });
    invoiceId = inv.id; total = inv.total;
  } else total = (await c.query(`select total from invoices where id=$1`, [invoiceId])).rows[0].total;
  const r = await d.payments.chargeToken({ token: d.crypto.decrypt(sub.payment_token_enc), previousRef: sub.last_provider_ref, orderId, amount: total, currency: sub.currency, description: `Barr ${planCode} ${periodLabel(periodStart)}` });
  await c.query(`insert into payments (subscription_id, invoice_id, parent_id, provider, provider_ref, amount, currency, kind, status, failure_reason, idempotency_key, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
    sub.id, invoiceId, sub.parent_id, sub.provider, r.providerRef, total, sub.currency, attempt === 0 ? 'renewal' : 'retry', r.status === 'succeeded' ? 'succeeded' : r.status === 'pending' ? 'pending' : 'failed', r.failureReason ?? null, orderId, now]);
  if (r.status === 'succeeded') {
    await c.query(`update invoices set status='paid', paid_at=$2 where id=$1`, [invoiceId, now]);
    await c.query(`update subscriptions set status='active', plan_code=$2, next_plan_code=null, custom_amount=$7, current_period_start=$3, current_period_end=$4, failed_attempts=0, first_failure_at=null, next_retry_at=null, last_provider_ref=$5, updated_at=$6 where id=$1`, [
      sub.id, planCode, periodStart, periodEnd, r.providerRef, now, customAmount]);
    await c.query(`update parents set status='active' where id=$1 and status='paused'`, [sub.parent_id]);
    await notify(c, now, { type: 'payment_succeeded', parentId: sub.parent_id, to: { family: sub.family_id }, vars: { amount: money(total, sub.currency), parent: sub.parent_name, plan: planName(planCode) }, dedupeKey: `payment:${orderId}:ok` });
    if (attempt === 0 && sub.current_period_start && addMonth(sub.created_at) <= periodStart) await track(c, 'renewal_succeeded', null, sub.parent_id, { month: periodLabel(periodStart) });
    return { status: 'succeeded' };
  }
  if (r.status === 'pending') return { status: 'pending' };
  // Failure: schedule retries on day 1/3/7 (CONFIG) from the first failure; pause after the last.
  const firstFailure = sub.first_failure_at ?? now;
  const nextStatus = statusAfterFailedAttempt(attempt, cfg.paymentRetryDays);
  const schedule = retrySchedule(firstFailure, cfg.paymentRetryDays);
  const nextRetry = schedule[attempt] ?? null;
  await c.query(`update invoices set status='failed' where id=$1`, [invoiceId]);
  await c.query(`update subscriptions set status=$2, failed_attempts=failed_attempts+1, first_failure_at=$3, next_retry_at=$4, updated_at=$5 where id=$1`, [sub.id, nextStatus, firstFailure, nextStatus === 'paused' ? null : nextRetry, now]);
  if (nextStatus === 'paused') {
    await c.query(`update parents set status='paused' where id=$1`, [sub.parent_id]);
    await notify(c, now, { type: 'payment_paused', parentId: sub.parent_id, to: { family: sub.family_id }, vars: { parent: sub.parent_name }, dedupeKey: `sub:${sub.id}:paused:${periodLabel(periodStart)}` });
    await createTask(c, { kind: 'payment_paused', parentId: sub.parent_id, title: `Service paused for ${sub.parent_name}: payment failed after all retries`, refType: 'subscription', refId: sub.id, dueAt: new Date(now.getTime() + 86_400_000), dedupeKey: `sub:${sub.id}:paused:${periodLabel(periodStart)}` });
    await audit(c, { actorUserId: null, action: 'subscription.paused', entityType: 'subscription', entityId: sub.id, parentId: sub.parent_id });
  } else if (nextRetry) {
    await enqueue(c, 'payment.retry', { subscriptionId: sub.id, attempt: attempt + 1 }, { runAt: nextRetry, dedupeKey: `payment.retry:${sub.id}:${periodLabel(periodStart)}:${attempt + 1}` });
    const date = { en: nextRetry.toISOString().slice(0, 10), ar: new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(nextRetry) };
    await notify(c, now, { type: 'payment_failed', parentId: sub.parent_id, to: { family: sub.family_id }, vars: { amount: money(total, sub.currency), parent: sub.parent_name, date }, dedupeKey: `payment:${orderId}:failed` });
  }
  return { status: 'failed', nextStatus };
}

/** Hourly: due subscriptions → renewal jobs (fan-out). */
export async function enqueueDueRenewals(c: Sql, now: Date) {
  const rows = (await c.query(`select id, current_period_end from subscriptions where status in ('active','cancel_at_period_end') and current_period_end <= $1 limit 1000`, [now])).rows;
  for (const r of rows) await enqueue(c, 'payment.renew', { subscriptionId: r.id, attempt: 0 }, { runAt: now, dedupeKey: `payment.renew:${r.id}:${r.current_period_end.toISOString()}` });
  return rows.length;
}

export async function cancelSubscription(c: Sql, now: Date, actor: Actor, subscriptionId: string) {
  const s = (await c.query(`select s.*, p.name from subscriptions s join parents p on p.id=s.parent_id where s.id=$1 for update of s`, [subscriptionId])).rows[0];
  if (!s) throw notFound();
  if (!['active', 'past_due'].includes(s.status)) throw new AppError(409, 'not_cancellable');
  await c.query(`update subscriptions set status='cancel_at_period_end', updated_at=$2 where id=$1`, [s.id, now]);
  await audit(c, { actorUserId: actor.userId, action: 'subscription.cancel', entityType: 'subscription', entityId: s.id, parentId: s.parent_id, before: { status: s.status }, after: { status: 'cancel_at_period_end', effectiveAt: s.current_period_end } });
  await notifySiblings(c, now, s.family_id, actor.userId, { en: `cancelled ${s.name}'s plan (ends ${s.current_period_end.toISOString().slice(0, 10)})`, ar: `ألغى باقة ${s.name} (تنتهي ${s.current_period_end.toISOString().slice(0, 10)})` }, `sub:${s.id}:cancel`, s.parent_id);
  return { effectiveAt: s.current_period_end };
}

export async function changePlan(c: Sql, now: Date, actor: Actor, subscriptionId: string, planCode: PlanCode) {
  const s = (await c.query(`select s.*, p.name from subscriptions s join parents p on p.id=s.parent_id where s.id=$1 for update of s`, [subscriptionId])).rows[0];
  if (!s) throw notFound();
  if (!['active', 'past_due', 'cancel_at_period_end'].includes(s.status)) throw new AppError(409, 'not_changeable');
  try { subscriptionPrice({ planCode, currency: s.currency, prices: await prices(c), customAmount: planCode === 'caregiver' ? (await c.query(`select value from settings where key=$1`, [`caregiver_price:${s.parent_id}:${s.currency}`])).rows[0]?.value?.amount ?? null : null }); }
  catch (e: any) { throw new AppError(422, e.message); }
  await c.query(`update subscriptions set next_plan_code=$2, status=case when status='cancel_at_period_end' then 'active' else status end, updated_at=$3 where id=$1`, [s.id, planCode, now]);
  await audit(c, { actorUserId: actor.userId, action: 'subscription.change_plan', entityType: 'subscription', entityId: s.id, parentId: s.parent_id, before: { plan: s.plan_code }, after: { nextPlan: planCode } });
  await notifySiblings(c, now, s.family_id, actor.userId, { en: `changed the plan to ${planName(planCode).en} (from next month)`, ar: `غيّر الباقة إلى ${planName(planCode).ar} (من الشهر القادم)` }, `sub:${s.id}:plan:${planCode}:${now.getTime()}`, s.parent_id);
}

/** Payment method change: new hosted tokenisation page (zero-amount not universally supported → small verification is provider-specific; V1 charges next renewal on new token). */
export async function updatePaymentMethod(d: Deps, c: Sql, actor: Actor, subscriptionId: string) {
  const now = d.clock.now();
  const s = (await c.query(`select * from subscriptions where id=$1`, [subscriptionId])).rows[0];
  if (!s) throw notFound();
  if (s.status === 'past_due' || s.status === 'paused') {
    // Pay the outstanding invoice with the new card; success reactivates.
    const inv = (await c.query(`select id, total from invoices where subscription_id=$1 and status='failed' order by issued_at desc limit 1`, [s.id])).rows[0];
    if (!inv) throw new AppError(409, 'nothing_outstanding');
    const orderId = `sub:${s.id}:recover:${now.getTime()}`;
    const hosted = await d.payments.createHostedPayment({ orderId, amount: inv.total, currency: s.currency, description: 'Barr outstanding invoice', customer: { name: 'Barr family' }, language: 'ar', returnUrl: `${d.env.PUBLIC_BASE_URL}/v1/payments/return?sub=${s.id}`, callbackUrl: `${d.env.PUBLIC_BASE_URL}/v1/webhooks/payments/${d.payments.name}` });
    await c.query(`insert into payments (subscription_id, invoice_id, parent_id, provider, provider_ref, amount, currency, kind, status, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,'retry','pending',$8)`, [s.id, inv.id, s.parent_id, d.payments.name, hosted.providerRef, inv.total, s.currency, orderId]);
    await audit(c, { actorUserId: actor.userId, action: 'payment_method.update_started', entityType: 'subscription', entityId: s.id, parentId: s.parent_id });
    await notifySiblings(c, now, s.family_id, actor.userId, { en: 'is updating the payment card', ar: 'يقوم بتحديث بطاقة الدفع' }, `sub:${s.id}:card:${now.getTime()}`, s.parent_id);
    return { redirectUrl: hosted.redirectUrl };
  }
  throw new AppError(409, 'card_update_at_next_renewal_not_supported_v1');
}

export async function refund(d: Deps, c: Sql, actor: Actor, paymentId: string, amount: number, reason: string) {
  const now = d.clock.now();
  const p = (await c.query(`select * from payments where id=$1 for update`, [paymentId])).rows[0];
  if (!p) throw notFound();
  if (!['succeeded', 'partially_refunded'].includes(p.status)) throw new AppError(409, 'not_refundable');
  const already = (await c.query(`select coalesce(sum(amount),0)::int s from refunds where payment_id=$1 and status='succeeded'`, [paymentId])).rows[0].s;
  if (amount <= 0 || amount + already > p.amount) throw badRequest('invalid_refund_amount');
  const r = await d.payments.refund({ providerRef: p.provider_ref, orderId: `refund:${paymentId}:${already + amount}`, amount, currency: p.currency, reason });
  const status = r.status === 'succeeded' ? 'succeeded' : r.status === 'pending' ? 'pending' : 'failed';
  const ref = (await c.query(`insert into refunds (payment_id, amount, reason, issued_by, provider_ref, status, created_at) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [paymentId, amount, reason, actor.userId, r.providerRef, status, now])).rows[0];
  if (status === 'succeeded') await c.query(`update payments set status=$2, updated_at=$3 where id=$1`, [paymentId, amount + already === p.amount ? 'refunded' : 'partially_refunded', now]);
  await audit(c, { actorUserId: actor.userId, action: 'payment.refund', entityType: 'payment', entityId: paymentId, parentId: p.parent_id, after: { amount, reason, status } });
  return { id: ref.id, status };
}

/** F9 pass-through: at cost, receipt required; billed on next invoice or immediately (CONFIG). */
export async function recordPassThrough(d: Deps, c: Sql, actor: Actor, a: { parentId: string; category: 'medicine' | 'lab' | 'ambulance' | 'other'; description: string; amount: number; currency: Currency; handlingFee: number | null; receiptKey: string }) {
  const now = d.clock.now();
  const sub = (await c.query(`select s.*, p.name parent_name from subscriptions s join parents p on p.id=s.parent_id where s.parent_id=$1 and s.status <> 'cancelled' order by created_at desc limit 1`, [a.parentId])).rows[0];
  if (!sub) throw new AppError(409, 'no_subscription');
  if (sub.currency !== a.currency) throw badRequest('currency_must_match_subscription');
  const pt = (await c.query(
    `insert into pass_through_charges (parent_id, family_id, city_id, pod_id, category, description, amount, currency, handling_fee, receipt_key, recorded_by, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [a.parentId, sub.family_id, sub.city_id, sub.pod_id, a.category, a.description, a.amount, a.currency, a.handlingFee, a.receiptKey, actor.userId, now],
  )).rows[0];
  await audit(c, { actorUserId: actor.userId, action: 'pass_through.record', entityType: 'pass_through', entityId: pt.id, parentId: a.parentId, after: a });
  const cfg = await getConfig(c);
  if (cfg.passThroughBilling === 'immediate' && sub.payment_token_enc) {
    const inv = await createInvoice(c, now, sub, { includeSubscription: false, periodStart: null, periodEnd: null, passThroughs: true });
    const orderId = `pt:${pt.id}`;
    const r = await d.payments.chargeToken({ token: d.crypto.decrypt(sub.payment_token_enc), previousRef: sub.last_provider_ref, orderId, amount: inv.total, currency: a.currency, description: `Barr at-cost charges` });
    await c.query(`insert into payments (subscription_id, invoice_id, parent_id, provider, provider_ref, amount, currency, kind, status, failure_reason, idempotency_key, created_at) values ($1,$2,$3,$4,$5,$6,$7,'pass_through',$8,$9,$10,$11)`, [
      sub.id, inv.id, a.parentId, sub.provider, r.providerRef, inv.total, a.currency, r.status === 'succeeded' ? 'succeeded' : 'failed', r.failureReason ?? null, orderId, now]);
    await c.query(`update invoices set status=$2, paid_at=$3 where id=$1`, [inv.id, r.status === 'succeeded' ? 'paid' : 'failed', r.status === 'succeeded' ? now : null]);
    if (r.status !== 'succeeded') await createTask(c, { kind: 'pass_through_failed', parentId: a.parentId, title: `At-cost charge failed: ${a.description}`, refType: 'pass_through', refId: pt.id, dedupeKey: `pt:${pt.id}:failed` });
    return { id: pt.id as string, invoiceId: inv.id, charged: r.status };
  }
  return { id: pt.id as string, invoiceId: null, charged: 'next_invoice' };
}
