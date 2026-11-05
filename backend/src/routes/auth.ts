import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NOTIFICATION_TYPES, oauthSignIn as oauthSchema, otpRequest, otpVerify, refreshRequest, lang } from '@barr/shared';
import type { Deps } from '../deps';
import { actor, authHook, parse } from '../http';
import { oauthSignIn, refresh, requestOtp, verifyOtp } from '../services/auth';
import { deleteAccount } from '../services/families';
import { audit, track } from '../services/audit';

export async function authRoutes(app: FastifyInstance, d: Deps) {
  app.post('/auth/otp/request', async (req) => requestOtp(d, parse(otpRequest, req.body).phone));
  app.post('/auth/otp/verify', async (req) => { const b = parse(otpVerify, req.body); return verifyOtp(d, b.phone, b.code, b.deviceName); });
  app.post('/auth/oauth', async (req) => { const b = parse(oauthSchema, req.body); return oauthSignIn(d, b.provider, b.idToken, b.nonce); });
  app.post('/auth/refresh', async (req) => refresh(d, parse(refreshRequest, req.body).refreshToken));

  app.register(async (r) => {
    r.addHook('preHandler', authHook(d));
    r.post('/auth/link', async (req) => { const b = parse(oauthSchema, req.body); return oauthSignIn(d, b.provider, b.idToken, b.nonce, actor(req).userId); });
    r.post('/auth/logout', async (req) => {
      await d.db.system((c) => c.query(`update sessions set revoked_at=$2, revoked_reason='logout' where id=$1`, [req.actor!.sessionId, d.clock.now()]));
      return { ok: true };
    });
    r.get('/me', async (req) => d.db.as(actor(req), async (c) => {
      const u = (await c.query(`select id, display_name, first_name, email, language, roles, phone_enc, photo_key from users where id=$1`, [actor(req).userId])).rows[0];
      const families = (await c.query(`select fm.family_id, fm.whatsapp_opt_in, fm.chat_whatsapp_mirror from family_members fm where fm.user_id=$1 and fm.removed_at is null`, [u.id])).rows;
      const staff = (await c.query(`select role, languages, pod_id, city_id, active, staff_is_verified(user_id) verified from staff where user_id=$1`, [u.id])).rows[0] ?? null;
      const identities = (await c.query(`select provider from auth_identities where user_id=$1`, [u.id])).rows.map((x) => x.provider);
      return { id: u.id, displayName: u.display_name, firstName: u.first_name, email: u.email, language: u.language, roles: u.roles, phone: d.crypto.decryptNullable(u.phone_enc), families, staff, identities };
    }));
    r.patch('/me', async (req) => {
      const b = parse(z.object({ displayName: z.string().max(80).optional(), firstName: z.string().max(40).optional(), language: lang.optional() }), req.body);
      return d.db.as(actor(req), async (c) => {
        await c.query(`update users set display_name=coalesce($2, display_name), first_name=coalesce($3, first_name), language=coalesce($4, language) where id=$1`, [actor(req).userId, b.displayName ?? null, b.firstName ?? null, b.language ?? null]);
        return { ok: true };
      });
    });
    r.put('/me/push-token', async (req) => {
      const b = parse(z.object({ token: z.string().min(10).max(300), platform: z.enum(['ios', 'android', 'web']), app: z.enum(['family', 'field']) }), req.body);
      return d.db.as(actor(req), async (c) => {
        await c.query(`insert into push_tokens (user_id, token, platform, app) values ($1,$2,$3,$4) on conflict (user_id, token) do update set updated_at=now()`, [actor(req).userId, b.token, b.platform, b.app]);
        return { ok: true };
      });
    });
    r.put('/me/notification-prefs', async (req) => {
      const b = parse(z.object({ prefs: z.array(z.object({ type: z.enum(NOTIFICATION_TYPES), enabled: z.boolean() })) }), req.body);
      return d.db.as(actor(req), async (c) => {
        for (const p of b.prefs) await c.query(`insert into notification_prefs (user_id, type, enabled) values ($1,$2,$3) on conflict (user_id, type) do update set enabled=excluded.enabled`, [actor(req).userId, p.type, p.enabled]);
        return { ok: true, note: 'escalation messages cannot be turned off' };
      });
    });
    r.put('/me/whatsapp', async (req) => {
      const b = parse(z.object({ familyId: z.string().uuid(), optIn: z.boolean(), chatMirror: z.boolean().default(false) }), req.body);
      return d.db.as(actor(req), async (c) => {
        await c.query(`update family_members set whatsapp_opt_in=$3, chat_whatsapp_mirror=$4 and $3 where family_id=$1 and user_id=$2`, [b.familyId, actor(req).userId, b.optIn, b.chatMirror]);
        await audit(c, { actorUserId: actor(req).userId, action: 'whatsapp.opt_in', entityType: 'user', entityId: actor(req).userId, after: b });
        return { ok: true };
      });
    });
    r.post('/me/analytics', async (req) => {
      const b = parse(z.object({ name: z.enum(['timeline_opened', 'whatsapp_report_opened', 'app_opened', 'dashboard_family_time']), parentId: z.string().uuid().nullable().optional(), props: z.record(z.unknown()).default({}) }), req.body);
      return d.db.as(actor(req), async (c) => { await track(c, b.name, actor(req).userId, b.parentId ?? null, b.props); return { ok: true }; });
    });
    r.delete('/me', async (req) => {
      const a = actor(req);
      if (!a.roles.every((x) => x === 'family')) return { error: 'staff_accounts_are_removed_by_admin' };
      await d.db.as(a, (c) => deleteAccount(c, d.clock.now(), a.userId));
      return { deleted: true };
    });
  });
}
