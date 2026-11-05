import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps';
import { handlePaymentWebhook } from '../services/payments';
import { monthlyHtml, verifyReportLink } from '../services/documents';
import { LocalStorage } from '../providers/storage';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { safeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';

export async function webhookRoutes(app: FastifyInstance, d: Deps) {
  /** Payment provider callbacks: signature-verified, idempotent. */
  app.post('/webhooks/payments/:provider', async (req) => {
    const raw = (req as any).rawBody as string;
    return d.db.system((c) => handlePaymentWebhook(d, c, req.headers as any, raw));
  });
  /** F14: WhatsApp link to the monthly report (signed, expiring; no sign-in needed). */
  app.get('/r/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ exp: z.coerce.number(), sig: z.string(), lang: z.enum(['ar', 'en']).optional() }).parse(req.query);
    if (!verifyReportLink(d.env.JWT_SECRET, id, q.exp, q.sig, d.clock.now())) throw new AppError(403, 'link_expired');
    const r = await d.db.system(async (c) => {
      const x = (await c.query(`select r.parent_id, r.structured_payload payload, r.rendered_ar, r.rendered_en, p.language from reports r join parents p on p.id=r.parent_id where r.id=$1 and r.type='monthly'`, [id])).rows[0];
      if (x) await c.query(`insert into analytics_events (name, parent_id, props) values ('whatsapp_report_opened', $1, $2)`, [x.parent_id, { reportId: id }]);
      return x;
    });
    if (!r) throw new AppError(404, 'not_found');
    return reply.type('text/html').send(monthlyHtml(r, q.lang ?? r.language));
  });
  app.get('/payments/return', async (_req, reply) => reply.type('text/html').send('<html><body style="font-family:sans-serif;text-align:center;padding:40px">Payment received. You can return to the Barr app. / تم استلام الدفع. يمكنك العودة إلى تطبيق بر.</body></html>'));

  /** WhatsApp (Meta Cloud API): verification handshake, delivery statuses, and parent dose replies ("1"/"نعم"). */
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && d.env.WHATSAPP_VERIFY_TOKEN && safeEqual(q['hub.verify_token'] ?? '', d.env.WHATSAPP_VERIFY_TOKEN)) return reply.send(q['hub.challenge']);
    throw new AppError(403, 'verify_failed');
  });
  app.post('/webhooks/whatsapp', async (req) => {
    const raw = (req as any).rawBody as string;
    if (d.whatsapp.verifyWebhook && !d.whatsapp.verifyWebhook(req.headers as any, raw)) throw new AppError(401, 'bad_signature');
    const body = req.body as any;
    await d.db.system(async (c) => {
      for (const entry of body?.entry ?? []) for (const ch of entry?.changes ?? []) {
        for (const s of ch?.value?.statuses ?? []) {
          await c.query(`update notifications set status=$2, updated_at=now() where provider_ref=$1 and status <> 'read'`, [s.id, s.status === 'read' ? 'read' : s.status === 'delivered' ? 'delivered' : s.status === 'failed' ? 'failed' : 'sent']);
          if (s.status === 'read') {
            const n = (await c.query(`select recipient_user_id, parent_id, type from notifications where provider_ref=$1`, [s.id])).rows[0];
            if (n && ['visit_report_ready', 'monthly_report', 'daily_status'].includes(n.type)) await c.query(`insert into analytics_events (name, user_id, parent_id) values ('whatsapp_report_opened',$1,$2)`, [n.recipient_user_id, n.parent_id]);
          }
        }
        // Inbound messages are logged for staff follow-up; dose confirmations from parents are confirmed by staff (logged), per F7.
        for (const m of ch?.value?.messages ?? []) {
          await c.query(`insert into tasks (kind, title, dedupe_key) values ('whatsapp_inbound', $1, $2) on conflict do nothing`, [`WhatsApp message from ${String(m.from).slice(0, 5)}…: ${String(m?.text?.body ?? '').slice(0, 200)}`, `wa:${m.id}`]);
        }
      }
    });
    return { ok: true };
  });

  /** Local-dev object storage (signed URLs). Production uses S3-compatible storage directly. */
  if (d.storage instanceof LocalStorage) {
    const store = d.storage;
    const root = join(process.cwd(), 'storage');
    const pathFor = (key: string) => { const p = normalize(join(root, key)); if (!p.startsWith(root)) throw new AppError(400, 'bad_key'); return p; };
    app.addContentTypeParser(/^(image|audio)\/.*|application\/pdf$/, { parseAs: 'buffer' }, (_r, b, done) => done(null, b));
    app.put('/media/:key', async (req) => {
      const { key } = z.object({ key: z.string() }).parse(req.params);
      const q = z.object({ exp: z.coerce.number(), sig: z.string() }).parse(req.query);
      if (!store.verify(key, q.exp, 'PUT', q.sig)) throw new AppError(403, 'bad_signature');
      const p = pathFor(key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, req.body as Buffer);
      return { ok: true };
    });
    app.get('/media/:key', async (req, reply) => {
      const { key } = z.object({ key: z.string() }).parse(req.params);
      const q = z.object({ exp: z.coerce.number(), sig: z.string() }).parse(req.query);
      if (!store.verify(key, q.exp, 'GET', q.sig)) throw new AppError(403, 'expired_or_bad_signature');
      const p = pathFor(key);
      if (!existsSync(p)) throw new AppError(404, 'not_found');
      return reply.send(readFileSync(p));
    });
  }
}
