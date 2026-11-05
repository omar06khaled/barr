import { createHmac } from 'node:crypto';
import type { Currency } from '@barr/shared';
import { safeEqual } from '../lib/crypto';

/**
 * PaymentProvider (F9). Barr never touches raw card data: the first payment goes
 * through the provider's hosted page with tokenisation; renewals charge the token.
 * Switching provider (PayTabs → Tap) = new adapter + PAYMENT_PROVIDER config only.
 */
export interface HostedPaymentRequest {
  orderId: string; // our idempotency key / cart id
  amount: number; // minor units
  currency: Currency;
  description: string;
  customer: { name: string; email?: string | null; phone?: string | null; country?: string };
  returnUrl: string;
  callbackUrl: string;
  language: 'ar' | 'en';
}
export interface ChargeResult { status: 'succeeded' | 'failed' | 'pending'; providerRef: string; failureReason?: string }
export interface WebhookPayment {
  eventId: string;
  orderId: string;
  providerRef: string;
  status: 'succeeded' | 'failed' | 'pending';
  failureReason?: string;
  token?: string;
  last4?: string;
  brand?: string;
  amount: number;
  currency: string;
}
export interface PaymentProvider {
  readonly name: string;
  createHostedPayment(r: HostedPaymentRequest): Promise<{ redirectUrl: string; providerRef: string }>;
  chargeToken(r: { token: string; previousRef?: string | null; orderId: string; amount: number; currency: Currency; description: string }): Promise<ChargeResult>;
  refund(r: { providerRef: string; orderId: string; amount: number; currency: Currency; reason: string }): Promise<ChargeResult>;
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): boolean;
  parseWebhook(rawBody: string): WebhookPayment;
}

const toMajor = (minor: number) => (minor / 100).toFixed(2);
const toMinor = (major: number | string) => Math.round(Number(major) * 100);

/** PayTabs adapter (PT2 API). Requires PAYTABS_PROFILE_ID / PAYTABS_SERVER_KEY. */
export class PayTabsProvider implements PaymentProvider {
  readonly name = 'paytabs';
  constructor(private cfg: { profileId: string; serverKey: string; baseUrl: string }, private fetchImpl: typeof fetch = fetch) {}

  private async call(body: Record<string, unknown>) {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/payment/request`, {
      method: 'POST',
      headers: { authorization: this.cfg.serverKey, 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: Number(this.cfg.profileId), ...body }),
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`paytabs_error:${res.status}:${json?.message ?? ''}`);
    return json;
  }

  async createHostedPayment(r: HostedPaymentRequest) {
    const j = await this.call({
      tran_type: 'sale', tran_class: 'ecom', cart_id: r.orderId, cart_currency: r.currency, cart_amount: toMajor(r.amount),
      cart_description: r.description, paypage_lang: r.language, callback: r.callbackUrl, return: r.returnUrl,
      tokenise: 2, show_save_card: false, hide_shipping: true,
      customer_details: { name: r.customer.name, email: r.customer.email ?? 'noemail@barr.care', phone: r.customer.phone ?? '', country: r.customer.country ?? 'SA', street1: 'N/A', city: 'N/A', state: 'N/A', ip: '127.0.0.1' },
    });
    return { redirectUrl: j.redirect_url as string, providerRef: j.tran_ref as string };
  }

  private result(j: any): ChargeResult {
    const s = j?.payment_result?.response_status;
    return { status: s === 'A' ? 'succeeded' : s === 'H' || s === 'P' ? 'pending' : 'failed', providerRef: j.tran_ref, failureReason: s === 'A' ? undefined : j?.payment_result?.response_message };
  }

  async chargeToken(r: { token: string; previousRef?: string | null; orderId: string; amount: number; currency: Currency; description: string }) {
    return this.result(await this.call({ tran_type: 'sale', tran_class: 'recurring', token: r.token, tran_ref: r.previousRef ?? undefined, cart_id: r.orderId, cart_currency: r.currency, cart_amount: toMajor(r.amount), cart_description: r.description }));
  }

  async refund(r: { providerRef: string; orderId: string; amount: number; currency: Currency; reason: string }) {
    return this.result(await this.call({ tran_type: 'refund', tran_class: 'ecom', tran_ref: r.providerRef, cart_id: r.orderId, cart_currency: r.currency, cart_amount: toMajor(r.amount), cart_description: r.reason }));
  }

  /** PayTabs signs callbacks: header "signature" = HMAC-SHA256(rawBody, serverKey). */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string) {
    const sig = headers['signature'];
    if (typeof sig !== 'string') return false;
    return safeEqual(sig, createHmac('sha256', this.cfg.serverKey).update(rawBody).digest('hex'));
  }

  parseWebhook(rawBody: string): WebhookPayment {
    const j = JSON.parse(rawBody);
    const r = this.result(j);
    const desc: string = j?.payment_info?.payment_description ?? '';
    return {
      eventId: `${j.tran_ref}:${j?.payment_result?.response_status}`,
      orderId: j.cart_id, providerRef: j.tran_ref, status: r.status, failureReason: r.failureReason,
      token: j.token, last4: desc.slice(-4) || undefined, brand: j?.payment_info?.card_scheme,
      amount: toMinor(j.cart_amount ?? j.tran_total ?? 0), currency: j.cart_currency ?? j.tran_currency,
    };
  }
}

/**
 * Fake provider for development and tests. Simulates hosted page + webhooks,
 * token charges, refunds, with programmable failures.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  static SECRET = 'fake-webhook-secret';
  failNextCharges = 0;
  charges: { orderId: string; amount: number; currency: string; token: string }[] = [];
  refunds: { providerRef: string; amount: number }[] = [];
  private n = 0;
  async createHostedPayment(r: HostedPaymentRequest) {
    const ref = `FAKE-${++this.n}`;
    return { redirectUrl: `https://fake-pay.local/pay/${ref}?order=${r.orderId}`, providerRef: ref };
  }
  async chargeToken(r: { token: string; orderId: string; amount: number; currency: Currency }): Promise<ChargeResult> {
    this.charges.push({ orderId: r.orderId, amount: r.amount, currency: r.currency, token: r.token });
    if (this.failNextCharges > 0) { this.failNextCharges--; return { status: 'failed', providerRef: `FAKE-${++this.n}`, failureReason: 'insufficient_funds' }; }
    return { status: 'succeeded', providerRef: `FAKE-${++this.n}` };
  }
  async refund(r: { providerRef: string; amount: number }): Promise<ChargeResult> {
    this.refunds.push({ providerRef: r.providerRef, amount: r.amount });
    return { status: 'succeeded', providerRef: `FAKE-R-${++this.n}` };
  }
  static sign(rawBody: string) { return createHmac('sha256', FakePaymentProvider.SECRET).update(rawBody).digest('hex'); }
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string) {
    const sig = headers['signature'];
    return typeof sig === 'string' && safeEqual(sig, FakePaymentProvider.sign(rawBody));
  }
  parseWebhook(rawBody: string): WebhookPayment { return JSON.parse(rawBody) as WebhookPayment; }
}
