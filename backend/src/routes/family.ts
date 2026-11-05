import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bookAssessment, concernCreate, escalationCreate, inviteCreate, pageQuery, parentCreate, parentUpdate, subscribeRequest, PLAN_CODES } from '@barr/shared';
import type { Deps } from '../deps';
import { actor, assertParentAccess, authHook, parse, requireCap } from '../http';
import { createParent, getParent, inviteMember, removeMember, updateParent, assertFamilyMember } from '../services/families';
import { dailyStatus, dosesToday, timeline } from '../services/timeline';
import { createEscalation, escalationWithTimeline } from '../services/escalations';
import { acceptCarePlan, careTeamHistory, carePlans, messages, postMessage, raiseConcern, reopenConcern, requestReplacement } from '../services/care';
import { cancelSubscription, changePlan, subscribe, updatePaymentMethod } from '../services/payments';
import { ChromiumPdfRenderer, invoiceHtml, monthlyHtml } from '../services/documents';
import { audit, track } from '../services/audit';
import { getConfig } from '../services/settings';
import { AppError, badRequest, notFound } from '../lib/errors';

const idParam = z.object({ id: z.string().uuid() });
const pdf = new ChromiumPdfRenderer();

export async function familyRoutes(app: FastifyInstance, d: Deps) {
  app.register(async (r) => {
    r.addHook('preHandler', authHook(d));
    const now = () => d.clock.now();

    // ── Parents (F1) ──
    r.get('/parents', async (req) => d.db.as(actor(req), async (c) => {
      const rows = (await c.query(
        `select p.id, p.name, p.gender, p.status, p.photo_key, p.family_id, s.plan_code, s.status sub_status from parents p
         left join subscriptions s on s.parent_id=p.id and s.status <> 'cancelled' where p.deleted_at is null order by p.created_at limit 50`)).rows;
      return { items: await Promise.all(rows.map(async (p) => ({ ...p, status_today: await dailyStatus(c, p.id, now()) }))) };
    }));
    r.post('/parents', async (req) => {
      const b = parse(parentCreate.extend({ familyId: z.string().uuid().optional() }), req.body);
      return d.db.as(requireCap(req, 'plan.manage'), (c) => createParent(d, c, actor(req), b));
    });
    r.get('/parents/:id', async (req) => { const { id } = parse(idParam, req.params); return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return getParent(d, c, actor(req), id); }); });
    r.patch('/parents/:id', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(parentUpdate, req.body);
      return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return updateParent(d, c, actor(req), id, b); });
    });

    // ── Timeline, status, doses (F2, F3, F7) ──
    r.get('/parents/:id/timeline', async (req) => {
      const { id } = parse(idParam, req.params);
      const q = parse(pageQuery.extend({ filter: z.enum(['all', 'visits', 'medicines', 'alerts', 'concerns']).default('all'), lang: z.enum(['ar', 'en']).default('ar') }), req.query);
      return d.db.as(actor(req), async (c) => {
        await assertParentAccess(c, id);
        if (!q.cursor) await track(c, 'timeline_opened', actor(req).userId, id);
        return timeline(d, c, id, q.filter, q.cursor, q.limit, q.lang);
      });
    });
    r.get('/parents/:id/status', async (req) => { const { id } = parse(idParam, req.params); return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return dailyStatus(c, id, now()); }); });
    r.get('/parents/:id/doses/today', async (req) => { const { id } = parse(idParam, req.params); return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return { items: await dosesToday(c, id, now()) }; }); });
    r.get('/parents/:id/medications', async (req) => { const { id } = parse(idParam, req.params); return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return { items: (await c.query(`select id, name, dose_text, times_of_day, start_date, end_date, instructions, active from medications where parent_id=$1 order by active desc, name`, [id])).rows }; }); });

    // ── Escalation: "Get help now" (F8) ──
    r.post('/escalations', async (req) => {
      const b = parse(escalationCreate, req.body);
      const a = requireCap(req, 'escalation.trigger');
      return d.db.as(a, async (c) => {
        await assertParentAccess(c, b.parentId);
        const trigger = a.roles.includes('family') ? 'family_help' : 'staff';
        return createEscalation(c, now(), { parentId: b.parentId, trigger, severity: b.severity, createdBy: a.userId, note: b.note });
      });
    });
    r.get('/parents/:id/escalations', async (req) => {
      const { id } = parse(idParam, req.params);
      return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return { items: (await c.query(`select id, status, severity, trigger, created_at, closed_at from escalations where parent_id=$1 order by created_at desc limit 50`, [id])).rows }; });
    });
    r.get('/escalations/:id', async (req) => {
      const { id } = parse(idParam, req.params);
      return d.db.as(actor(req), async (c) => { const e = await escalationWithTimeline(c, id, actor(req).roles.every((x) => x === 'family')); await assertParentAccess(c, e.parent_id); return e; });
    });

    // ── Family members & invites (§5, §6) ──
    r.get('/families/:id/members', async (req) => {
      const { id } = parse(idParam, req.params);
      return d.db.as(actor(req), async (c) => {
        await assertFamilyMember(c, id, actor(req).userId);
        const members = (await c.query(`select u.id, u.display_name, u.first_name, fm.joined_at from family_members fm join users u on u.id=fm.user_id where fm.family_id=$1 and fm.removed_at is null order by fm.joined_at`, [id])).rows;
        const invites = (await c.query(`select id, created_at, expires_at from family_invites where family_id=$1 and accepted_at is null and revoked_at is null and expires_at > $2`, [id, now()])).rows;
        return { members, invites };
      });
    });
    r.post('/families/:id/invites', async (req) => { const { id } = parse(idParam, req.params); const b = parse(inviteCreate, req.body); return d.db.as(requireCap(req, 'family.invite'), (c) => inviteMember(d, c, actor(req), id, b.phone)); });
    r.delete('/families/:id/members/:userId', async (req) => {
      const p = parse(z.object({ id: z.string().uuid(), userId: z.string().uuid() }), req.params);
      await d.db.as(requireCap(req, 'family.invite'), (c) => removeMember(d, c, actor(req), p.id, p.userId));
      return { ok: true };
    });

    // ── Assessment booking (F1) ──
    r.get('/parents/:id/assessment-slots', async (req) => {
      const { id } = parse(idParam, req.params);
      return d.db.as(actor(req), async (c) => {
        await assertParentAccess(c, id);
        const pod = (await c.query(`select pod_id from parents where id=$1`, [id])).rows[0].pod_id;
        return { items: (await c.query(`select id, starts_at, ends_at from assessment_slots where pod_id=$1 and booked_parent_id is null and starts_at > $2 order by starts_at limit 30`, [pod, now()])).rows };
      });
    });
    r.post('/assessments', async (req) => {
      const b = parse(bookAssessment, req.body);
      return d.db.as(requireCap(req, 'plan.manage'), async (c) => {
        await assertParentAccess(c, b.parentId);
        const p = (await c.query(`select city_id, pod_id from parents where id=$1`, [b.parentId])).rows[0];
        const s = (await c.query(`update assessment_slots set booked_parent_id=$2, booked_at=$3 where id=$1 and booked_parent_id is null and pod_id=$4 returning *`, [b.slotId, b.parentId, now(), p.pod_id])).rows[0];
        if (!s) throw new AppError(409, 'slot_taken');
        // Coordinator may not be verified yet in dev data: insert unassigned then assign through the trigger path.
        const v = (await c.query(`insert into visits (parent_id, city_id, pod_id, type, scheduled_at, duration_min, source) values ($1,$2,$3,'assessment',$4,$5,'assessment') returning id`, [b.parentId, p.city_id, p.pod_id, s.starts_at, Math.round((s.ends_at - s.starts_at) / 60000)])).rows[0];
        try { await c.query(`savepoint a`); await c.query(`update visits set staff_user_id=$2 where id=$1`, [v.id, s.coordinator_user_id]); await c.query(`insert into staff_assignments (parent_id, user_id, role) values ($1,$2,'coordinator')`, [b.parentId, s.coordinator_user_id]); await c.query(`release savepoint a`); }
        catch { await c.query(`rollback to savepoint a`); }
        await audit(c, { actorUserId: actor(req).userId, action: 'assessment.book', entityType: 'visit', entityId: v.id, parentId: b.parentId });
        await track(c, 'assessment_booked', actor(req).userId, b.parentId);
        return { visitId: v.id, startsAt: s.starts_at };
      });
    });

    // ── Plans & payments (F9) ──
    r.get('/plans', async (req) => d.db.as(actor(req), async (c) => ({
      items: (await c.query(`select p.code, p.name_en, p.name_ar, p.inclusions, coalesce(json_agg(json_build_object('currency', pp.currency, 'amount', pp.amount)) filter (where pp.currency is not null), '[]') prices from plans p left join plan_prices pp on pp.plan_code=p.code where p.active group by p.code order by array_position(array['visit','plus','caregiver'], p.code)`)).rows,
    })));
    r.post('/subscriptions', async (req) => { const b = parse(subscribeRequest, req.body); return d.db.as(requireCap(req, 'payment.manage'), async (c) => { await assertParentAccess(c, b.parentId); return subscribe(d, c, actor(req), b); }); });
    r.get('/parents/:id/subscription', async (req) => {
      const { id } = parse(idParam, req.params);
      return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return (await c.query(`select id, plan_code, next_plan_code, currency, status, card_last4, card_brand, current_period_start, current_period_end, custom_amount from subscriptions where parent_id=$1 and status <> 'cancelled' order by created_at desc limit 1`, [id])).rows[0] ?? null; });
    });
    r.post('/subscriptions/:id/cancel', async (req) => { const { id } = parse(idParam, req.params); return d.db.as(requireCap(req, 'plan.manage'), (c) => cancelSubscription(c, now(), actor(req), id)); });
    r.post('/subscriptions/:id/plan', async (req) => { const { id } = parse(idParam, req.params); const b = parse(z.object({ planCode: z.enum(PLAN_CODES) }), req.body); await d.db.as(requireCap(req, 'plan.manage'), (c) => changePlan(c, now(), actor(req), id, b.planCode)); return { ok: true }; });
    r.post('/subscriptions/:id/payment-method', async (req) => { const { id } = parse(idParam, req.params); return d.db.as(requireCap(req, 'payment.manage'), (c) => updatePaymentMethod(d, c, actor(req), id)); });
    r.get('/parents/:id/invoices', async (req) => {
      const { id } = parse(idParam, req.params);
      return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return { items: (await c.query(`select id, number, currency, total, status, issued_at, paid_at, lines from invoices where parent_id=$1 order by issued_at desc limit 50`, [id])).rows }; });
    });
    r.get('/invoices/:id/pdf', async (req, reply) => {
      const { id } = parse(idParam, req.params);
      const q = parse(z.object({ lang: z.enum(['ar', 'en']).default('ar') }), req.query);
      const html = await d.db.as(actor(req), async (c) => {
        const inv = (await c.query(`select i.*, p.name from invoices i join parents p on p.id=i.parent_id where i.id=$1`, [id])).rows[0];
        if (!inv) throw notFound();
        return invoiceHtml(inv, inv.name, q.lang);
      });
      reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="invoice-${id}-${q.lang}.pdf"`);
      return reply.send(await pdf.render(html));
    });

    // ── Reports (F14) ──
    r.get('/parents/:id/reports', async (req) => {
      const { id } = parse(idParam, req.params);
      return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return { items: (await c.query(`select id, type, period_start, period_end, generator, created_at from reports where parent_id=$1 and type='monthly' order by period_start desc limit 24`, [id])).rows }; });
    });
    r.get('/reports/:id', async (req) => {
      const { id } = parse(idParam, req.params);
      return d.db.as(actor(req), async (c) => { const x = (await c.query(`select id, type, parent_id, period_start, period_end, structured_payload, rendered_ar, rendered_en from reports where id=$1`, [id])).rows[0]; if (!x) throw notFound(); return x; });
    });
    r.get('/reports/:id/pdf', async (req, reply) => {
      const { id } = parse(idParam, req.params);
      const q = parse(z.object({ lang: z.enum(['ar', 'en']).default('ar') }), req.query);
      const html = await d.db.as(actor(req), async (c) => {
        const x = (await c.query(`select structured_payload payload, rendered_ar, rendered_en from reports where id=$1 and type='monthly'`, [id])).rows[0];
        if (!x) throw notFound();
        return monthlyHtml(x, q.lang);
      });
      reply.header('content-type', 'application/pdf');
      return reply.send(await pdf.render(html));
    });

    // ── Care plan + agreement (F10) ──
    r.get('/parents/:id/care-plans', async (req) => { const { id } = parse(idParam, req.params); return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return { items: await carePlans(c, id) }; }); });
    r.post('/care-plans/:id/accept', async (req) => { const { id } = parse(idParam, req.params); await d.db.as(actor(req), (c) => acceptCarePlan(c, now(), actor(req), id)); return { ok: true }; });

    // ── Concerns (F11) ──
    r.post('/concerns', async (req) => { const b = parse(concernCreate, req.body); return d.db.as(requireCap(req, 'concern.raise'), async (c) => { await assertParentAccess(c, b.parentId); return raiseConcern(c, now(), actor(req), b); }); });
    r.get('/parents/:id/concerns', async (req) => { const { id } = parse(idParam, req.params); return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return { items: (await c.query(`select id, ref, category, urgency, safety_flag, text, status, deadline, resolution, resolved_at, created_at from concerns where parent_id=$1 order by created_at desc limit 50`, [id])).rows }; }); });
    r.post('/concerns/:id/reopen', async (req) => { const { id } = parse(idParam, req.params); const b = parse(z.object({ reason: z.string().min(2).max(500) }), req.body); await d.db.as(requireCap(req, 'concern.raise'), (c) => reopenConcern(c, now(), actor(req), id, b.reason)); return { ok: true }; });

    // ── Chat (F12) ──
    r.get('/parents/:id/messages', async (req) => {
      const { id } = parse(idParam, req.params);
      const q = parse(z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }), req.query);
      return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return messages(c, actor(req), id, q.before ? new Date(q.before) : null, q.limit); });
    });
    r.post('/parents/:id/messages', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ kind: z.enum(['text', 'photo', 'voice']).default('text'), body: z.string().max(4000).default(''), mediaKey: z.string().max(300).optional(), clientId: z.string().uuid().optional() }), req.body);
      if (b.kind === 'text' && !b.body.trim()) throw badRequest('empty_message');
      return d.db.as(requireCap(req, 'chat.use'), async (c) => { await assertParentAccess(c, id); return postMessage(c, now(), actor(req), { parentId: id, ...b }); });
    });

    // ── Continuity & verified staff profiles (F13, F4) ──
    r.get('/parents/:id/care-team', async (req) => { const { id } = parse(idParam, req.params); return d.db.as(actor(req), async (c) => { await assertParentAccess(c, id); return { items: await careTeamHistory(c, id) }; }); });
    r.post('/parents/:id/replacement-requests', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ staffUserId: z.string().uuid().nullable().optional(), reason: z.string().min(3).max(500) }), req.body);
      return d.db.as(requireCap(req, 'concern.raise'), async (c) => { await assertParentAccess(c, id); return requestReplacement(c, now(), actor(req), { parentId: id, ...b }); });
    });
    r.get('/parents/:id/staff/:staffId', async (req) => {
      const p = parse(z.object({ id: z.string().uuid(), staffId: z.string().uuid() }), req.params);
      return d.db.as(actor(req), async (c) => {
        await assertParentAccess(c, p.id);
        // Families never see staff phone numbers or ID numbers (F4).
        const s = (await c.query(`select u.id, u.first_name, u.photo_key, s.role, s.languages from staff s join users u on u.id=s.user_id where s.user_id=$1`, [p.staffId])).rows[0];
        if (!s) throw notFound();
        const checks = (await c.query(`select item, completed_on from staff_verifications where user_id=$1`, [p.staffId])).rows;
        const visits = (await c.query(`select count(*)::int n from visits where parent_id=$1 and staff_user_id=$2 and status='completed'`, [p.id, p.staffId])).rows[0].n;
        const cfg = await getConfig(c);
        return { id: s.id, firstName: s.first_name, role: s.role, languages: s.languages, photoUrl: s.photo_key ? await d.storage.signDownload(s.photo_key, cfg.signedUrlTtlS) : null, verification: checks, verified: checks.length === 4, visitsWithFamily: visits };
      });
    });

    // ── Uploads (signed, expiring) ──
    r.post('/uploads', async (req) => {
      const b = parse(z.object({ purpose: z.enum(['visit_photo', 'parent_photo', 'receipt', 'consent_doc', 'chat_media', 'concern_photo']), parentId: z.string().uuid(), visitId: z.string().uuid().optional(), contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'audio/m4a', 'audio/aac', 'audio/mpeg']) }), req.body);
      return d.db.as(actor(req), async (c) => {
        await assertParentAccess(c, b.parentId);
        const ext = b.contentType.split('/')[1];
        let key: string;
        if (b.purpose === 'visit_photo') {
          if (!b.visitId) throw badRequest('visit_id_required');
          const ok = (await c.query(`select parent_has_photo_consent($1) ok`, [b.parentId])).rows[0].ok;
          if (!ok) throw new AppError(422, 'no_photo_consent');
          key = `visits/${b.visitId}/${randomUUID()}.${ext}`;
        } else key = `${b.purpose}/${b.parentId}/${randomUUID()}.${ext}`;
        const cfg = await getConfig(c);
        return { key, ...(await d.storage.signUpload(key, b.contentType, cfg.signedUrlTtlS)) };
      });
    });
    r.get('/media-url', async (req) => {
      const q = parse(z.object({ key: z.string().max(300), parentId: z.string().uuid() }), req.query);
      return d.db.as(actor(req), async (c) => {
        await assertParentAccess(c, q.parentId);
        if (!q.key.includes(q.parentId) && !(await c.query(`select 1 from visit_photos where storage_key=$1 and parent_id=$2`, [q.key, q.parentId])).rowCount) throw notFound();
        const cfg = await getConfig(c);
        return { url: await d.storage.signDownload(q.key, cfg.signedUrlTtlS) };
      });
    });
  });
}
