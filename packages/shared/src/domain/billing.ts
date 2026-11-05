export const CURRENCIES = ['USD', 'SAR', 'AED'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const PLAN_CODES = ['visit', 'plus', 'caregiver'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/** Amounts in minor units (cents/halalas/fils) to avoid float errors. */
export type Money = { amount: number; currency: Currency };

export type SubscriptionStatus = 'pending_payment' | 'active' | 'past_due' | 'paused' | 'cancel_at_period_end' | 'cancelled';

export interface PlanPrice { planCode: PlanCode; currency: Currency; amount: number }

/**
 * Monthly price for a subscription. Caregiver plan price is set per family (customAmount).
 * "Founding family" is an admin-applied fixed price (customAmount) — the only discount in V1.
 */
export function subscriptionPrice(args: { planCode: PlanCode; currency: Currency; prices: PlanPrice[]; customAmount?: number | null }): Money {
  if (args.customAmount != null) {
    if (!Number.isInteger(args.customAmount) || args.customAmount <= 0) throw new Error('invalid_custom_amount');
    return { amount: args.customAmount, currency: args.currency };
  }
  if (args.planCode === 'caregiver') throw new Error('caregiver_price_must_be_set_per_family');
  const p = args.prices.find((x) => x.planCode === args.planCode && x.currency === args.currency);
  if (!p) throw new Error('price_not_configured');
  return { amount: p.amount, currency: args.currency };
}

export type InvoiceLineKind = 'subscription' | 'pass_through' | 'handling_fee' | 'refund';
export interface InvoiceLine { kind: InvoiceLineKind; description_en: string; description_ar: string; amount: number; atCost?: boolean; refId?: string }

export interface PassThroughCharge { id: string; category: 'medicine' | 'lab' | 'ambulance' | 'other'; description: string; amount: number; currency: Currency; handlingFee: number | null }

const ptLabel = { medicine: ['Medicines', 'أدوية'], lab: ['Lab tests', 'تحاليل'], ambulance: ['Ambulance', 'إسعاف'], other: ['Other', 'أخرى'] } as const;

/**
 * Invoice lines: subscription (if any), each pass-through at cost, and any handling
 * fee as its OWN labelled line (F9). Pass-throughs must match invoice currency.
 */
export function buildInvoiceLines(args: { subscription?: { planCode: PlanCode; price: Money; periodLabel: string }; passThroughs: PassThroughCharge[]; currency: Currency }): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  if (args.subscription) {
    if (args.subscription.price.currency !== args.currency) throw new Error('currency_mismatch');
    lines.push({
      kind: 'subscription',
      description_en: `Barr ${args.subscription.planCode} plan — ${args.subscription.periodLabel} (prepaid)`,
      description_ar: `باقة بر ${args.subscription.planCode} — ${args.subscription.periodLabel} (مدفوعة مقدمًا)`,
      amount: args.subscription.price.amount,
    });
  }
  for (const pt of args.passThroughs) {
    if (pt.currency !== args.currency) throw new Error('currency_mismatch');
    const [en, ar] = ptLabel[pt.category];
    lines.push({ kind: 'pass_through', description_en: `${en} at cost: ${pt.description}`, description_ar: `${ar} بسعر التكلفة: ${pt.description}`, amount: pt.amount, atCost: true, refId: pt.id });
    if (pt.handlingFee && pt.handlingFee > 0) {
      lines.push({ kind: 'handling_fee', description_en: `Handling fee for: ${pt.description}`, description_ar: `رسوم خدمة: ${pt.description}`, amount: pt.handlingFee, refId: pt.id });
    }
  }
  return lines;
}

export const invoiceTotal = (lines: InvoiceLine[]) => lines.reduce((s, l) => s + (l.kind === 'refund' ? -l.amount : l.amount), 0);

/** F9 retries: given the first failure time, returns retry instants (day 1, 3, 7 by default). */
export function retrySchedule(firstFailureAt: Date, retryDays: number[]): Date[] {
  return retryDays.map((d) => new Date(firstFailureAt.getTime() + d * 86_400_000));
}

/** After the final retry fails the subscription is paused (not cancelled). */
export function statusAfterFailedAttempt(attemptIndex: number, retryDays: number[]): SubscriptionStatus {
  return attemptIndex >= retryDays.length ? 'paused' : 'past_due';
}

/** Adds one calendar month, clamping to month end (Jan 31 → Feb 28/29). */
export function addMonth(d: Date): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
  return new Date(Date.UTC(y, m + 1, Math.min(day, lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
}

export function formatMoney(m: Money, lang: 'ar' | 'en'): string {
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', { style: 'currency', currency: m.currency }).format(m.amount / 100);
}
