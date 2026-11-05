import { createHmac } from 'node:crypto';
import { safeEqual } from '../lib/crypto';

export interface SendResult { providerRef: string; status: 'sent' | 'failed'; error?: string }

/** WhatsApp Business (F17). Templates must be pre-approved; we pass params in order. */
export interface MessagingProvider {
  readonly name: string;
  sendTemplate(m: { to: string; template: string; language: 'ar' | 'en'; params: string[]; preview: string }): Promise<SendResult>;
  sendText(m: { to: string; body: string }): Promise<SendResult>; // only inside a 24h customer-service window
  verifyWebhook?(headers: Record<string, string | string[] | undefined>, rawBody: string): boolean;
}

export class MetaCloudWhatsApp implements MessagingProvider {
  readonly name = 'meta';
  constructor(private cfg: { phoneNumberId: string; token: string; appSecret?: string }, private fetchImpl: typeof fetch = fetch) {}
  private async post(body: unknown): Promise<SendResult> {
    const res = await this.fetchImpl(`https://graph.facebook.com/v21.0/${this.cfg.phoneNumberId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = (await res.json()) as any;
    if (!res.ok) return { providerRef: '', status: 'failed', error: j?.error?.message ?? String(res.status) };
    return { providerRef: j?.messages?.[0]?.id ?? '', status: 'sent' };
  }
  sendTemplate(m: { to: string; template: string; language: 'ar' | 'en'; params: string[] }) {
    return this.post({
      messaging_product: 'whatsapp', to: m.to.replace('+', ''), type: 'template',
      template: { name: m.template, language: { code: m.language }, components: [{ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text })) }] },
    });
  }
  sendText(m: { to: string; body: string }) {
    return this.post({ messaging_product: 'whatsapp', to: m.to.replace('+', ''), type: 'text', text: { body: m.body } });
  }
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string) {
    const sig = headers['x-hub-signature-256'];
    if (!this.cfg.appSecret || typeof sig !== 'string') return false;
    return safeEqual(sig, 'sha256=' + createHmac('sha256', this.cfg.appSecret).update(rawBody).digest('hex'));
  }
}

export interface SmsProvider { send(to: string, body: string): Promise<SendResult> }
export interface PushProvider { send(m: { tokens: string[]; title: string; body: string; data?: Record<string, string> }): Promise<SendResult> }
/** Calling provider for paging the on-call doctor (F8 step 2). */
export interface CallingProvider { placeCall(m: { to: string; message: string; language: 'ar' | 'en' }): Promise<SendResult> }

export class ExpoPush implements PushProvider {
  constructor(private accessToken?: string, private fetchImpl: typeof fetch = fetch) {}
  async send(m: { tokens: string[]; title: string; body: string; data?: Record<string, string> }): Promise<SendResult> {
    if (m.tokens.length === 0) return { providerRef: '', status: 'failed', error: 'no_tokens' };
    const res = await this.fetchImpl('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}) },
      body: JSON.stringify(m.tokens.map((to) => ({ to, title: m.title, body: m.body, data: m.data, sound: 'default', priority: 'high' }))),
    });
    const j = (await res.json()) as any;
    return res.ok ? { providerRef: j?.data?.[0]?.id ?? '', status: 'sent' } : { providerRef: '', status: 'failed', error: JSON.stringify(j).slice(0, 300) };
  }
}

export class TwilioSms implements SmsProvider, CallingProvider {
  constructor(private cfg: { sid: string; token: string; from: string }, private fetchImpl: typeof fetch = fetch) {}
  private async post(path: string, form: Record<string, string>): Promise<SendResult> {
    const res = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${this.cfg.sid}/${path}`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${this.cfg.sid}:${this.cfg.token}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
    const j = (await res.json()) as any;
    return res.ok ? { providerRef: j.sid, status: 'sent' } : { providerRef: '', status: 'failed', error: j?.message };
  }
  send(to: string, body: string) { return this.post('Messages.json', { To: to, From: this.cfg.from, Body: body }); }
  placeCall(m: { to: string; message: string; language: 'ar' | 'en' }) {
    const lang = m.language === 'ar' ? 'arb' : 'en-US';
    const twiml = `<Response><Say language="${lang}">${m.message.replace(/[<>&]/g, '')}</Say><Pause length="1"/><Say language="${lang}">${m.message.replace(/[<>&]/g, '')}</Say></Response>`;
    return this.post('Calls.json', { To: m.to, From: this.cfg.from, Twiml: twiml });
  }
}

/** Records everything; used in dev/tests. Can be made to fail. */
export class RecordingChannel implements MessagingProvider, SmsProvider, PushProvider, CallingProvider {
  readonly name = 'console';
  sent: { channel: string; to: string; body: string; template?: string }[] = [];
  failFor = new Set<string>();
  constructor(private channel: string, private log = false) {}
  private rec(to: string, body: string, template?: string): SendResult {
    this.sent.push({ channel: this.channel, to, body, template });
    if (this.log) console.log(`[${this.channel}] → ${to}: ${body}`);
    if (this.failFor.has(to)) return { providerRef: '', status: 'failed', error: 'simulated_failure' };
    return { providerRef: `${this.channel}-${this.sent.length}`, status: 'sent' };
  }
  async sendTemplate(m: { to: string; template: string; preview: string }) { return this.rec(m.to, m.preview, m.template); }
  async sendText(m: { to: string; body: string }) { return this.rec(m.to, m.body); }
  async send(a: any, b?: any): Promise<SendResult> {
    if (typeof a === 'string') return this.rec(a, b);
    return this.rec(a.tokens.join(','), `${a.title}: ${a.body}`);
  }
  async placeCall(m: { to: string; message: string }) { return this.rec(m.to, m.message); }
  clear() { this.sent = []; }
}
