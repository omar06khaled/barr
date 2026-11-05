import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CURRENCIES, NOTIFICATION_TYPES, PLAN_CODES, checklistTemplate, helplineCall, localParts, toE164, visitSchedule, zonedTimeToUtc, addDays, defaultConfig, STAFF_ROLES } from '@barr/shared';
import type { Deps } from '../deps';
import { actor, authHook, parse, requireCap, requireRole } from '../http';
import { assignStaff } from '../services/visits';
import { createEscalation } from '../services/escalations';
import { publishCarePlan, resolveReplacement, updateConcern } from '../services/care';
import { refund } from '../services/payments';
import { revokeUserSessions } from '../services/auth';
import { getConfig, setConfig } from '../services/settings';
import { scheduleVisitJobs } from '../services/automation';
import { audit } from '../services/audit';
import { AppError, badRequest, notFound } from '../lib/errors';

const idParam = z.object({ id: z.string().uuid() });

export async function adminRoutes(app: FastifyInstance, d: Deps) {
  app.register(async (r) => {
    r.addHook('preHandler', authHook(d));
    const now = () => d.clock.now();
    const dash = (req: any) => requireRole(req, 'admin', 'coordinator');

    /** F16.1 Today. RLS limits coordinators to their pod automatically. */
    r.get('/admin/today', async (req) => d.db.as(dash(req), async (c) => {
      const cfg = await getConfig(c);
      const today = localParts(now(), cfg.timezone).date;
      const from = zonedTimeToUtc(today, '00:00', cfg.timezone), to = zonedTimeToUtc(addDays(today, 1), '00:00', cfg.timezone);
      const seq = async <T,>(ps: (() => Promise<T>)[]) => { const out: T[] = []; for (const p of ps) out.push(await p()); return out; };
      const [escalations, concerns, doses, visits, staffOn, tasks, noContact] = (await seq([
        () => c.query(`select e.id, e.parent_id, p.name parent_name, e.trigger, e.severity, e.status, e.created_at, e.acknowledged_at, e.family_notified_at, extract(epoch from ($1 - e.created_at))::int age_s from escalations e join parents p on p.id=e.parent_id where e.status <> 'closed' order by e.created_at`, [now()]),
        () => c.query(`select cn.id, cn.ref, cn.parent_id, p.name parent_name, cn.category, cn.safety_flag, cn.status, cn.deadline, cn.deadline < $1 overdue from concerns cn join parents p on p.id=cn.parent_id where cn.status <> 'resolved' order by (cn.deadline < $1) desc, cn.safety_flag desc, cn.deadline limit 100`, [now()]),
        () => c.query(`select de.id, de.parent_id, p.name parent_name, m.name medicine, de.scheduled_at, de.family_notified_at from dose_events de join medications m on m.id=de.medication_id join parents p on p.id=de.parent_id where de.status='missed' and de.scheduled_at >= $1 and de.scheduled_at < $2 order by de.scheduled_at`, [from, to]),
        () => c.query(`select v.status, count(*)::int n from visits v where v.scheduled_at >= $1 and v.scheduled_at < $2 group by v.status`, [from, to]),
        () => c.query(`select o.user_id, u.first_name, o.tier, o.ends_at from oncall_rota o join users u on u.id=o.user_id where o.starts_at <= $1 and o.ends_at > $1`, [now()]),
        () => c.query(`select t.id, t.kind, t.title, t.parent_id, t.due_at, t.assignee_user_id from tasks t where t.status='open' order by t.due_at nulls last limit 100`),
        () => c.query(`select t.parent_id, p.name parent_name from tasks t join parents p on p.id=t.parent_id where t.kind='no_contact' and t.status='open' and t.created_at >= $1`, [from]),
      ])) as any[];
      return {
        date: today, openEscalations: escalations.rows, concerns: concerns.rows, missedDoses: doses.rows,
        visits: Object.fromEntries(visits.rows.map((x: any) => [x.status, x.n])), onCall: staffOn.rows, tasks: tasks.rows, noContact: noContact.rows,
      };
    }));

    /** F16.2 Families: searchable, paginated. */
    r.get('/admin/families', async (req) => {
      const q = parse(z.object({ search: z.string().max(80).optional(), podId: z.string().uuid().optional(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
      return d.db.as(dash(req), async (c) => ({
        items: (await c.query(
          `select p.id, p.name, p.status, p.neighborhood, po.name pod, s.plan_code, s.status payment_state, s.currency, coalesce(f.churn_risk, false) churn_risk, f.reasons churn_reasons,
             (select count(*) from family_members fm where fm.family_id=p.family_id and fm.removed_at is null)::int members
           from parents p join pods po on po.id=p.pod_id left join subscriptions s on s.parent_id=p.id and s.status <> 'cancelled' left join parent_flags f on f.parent_id=p.id
           where p.deleted_at is null and ($1::text is null or p.name ilike '%' || $1 || '%' or p.neighborhood ilike '%' || $1 || '%') and ($2::uuid is null or p.pod_id=$2)
           order by coalesce(f.churn_risk,false) desc, p.name offset $3 limit $4`, [q.search ?? null, q.podId ?? null, q.offset, q.limit])).rows,
      }));
    });
    r.get('/admin/families/:id', async (req) => {
      const { id } = parse(idParam, req.params);
      const a = dash(req);
      return d.db.as(a, async (c) => {
        const p = (await c.query(`select p.*, po.name pod_name from parents p join pods po on po.id=p.pod_id where p.id=$1`, [id])).rows[0];
        if (!p) throw notFound();
        await audit(c, { actorUserId: a.userId, action: 'parent.read', entityType: 'parent', entityId: id, parentId: id, meta: { via: 'dashboard' } });
        const q = async (sql: string) => (await c.query(sql, [id])).rows;
        return {
          parent: { id: p.id, name: p.name, gender: p.gender, status: p.status, pod: p.pod_name, neighborhood: p.neighborhood, address: d.crypto.decrypt(p.address_enc), phone: d.crypto.decryptNullable(p.phone_enc), language: p.language, carerPreference: p.carer_preference, allergies: { has: p.allergies_has, text: p.allergies_text }, mobilityNotes: p.mobility_notes, location: { lat: p.lat, lng: p.lng } },
          members: await q(`select u.id, u.display_name, u.first_name, fm.joined_at, fm.whatsapp_opt_in from family_members fm join users u on u.id=fm.user_id join parents p on p.family_id=fm.family_id where p.id=$1 and fm.removed_at is null`),
          subscription: (await q(`select * from subscriptions where parent_id=$1 order by created_at desc limit 1`)).map(({ payment_token_enc, ...s }) => s)[0] ?? null,
          visits: await q(`select v.id, v.type, v.status, v.scheduled_at, v.checked_in_at, v.staff_user_id, u.first_name staff from visits v left join users u on u.id=v.staff_user_id where v.parent_id=$1 order by v.scheduled_at desc limit 40`),
          medications: await q(`select id, name, dose_text, times_of_day, active from medications where parent_id=$1`),
          escalations: await q(`select id, status, trigger, severity, created_at, closed_at from escalations where parent_id=$1 order by created_at desc limit 20`),
          concerns: await q(`select id, ref, status, category, deadline, safety_flag from concerns where parent_id=$1 order by created_at desc limit 20`),
          carePlans: await q(`select id, version, status, published_at from care_plans where parent_id=$1 order by version desc`),
          consents: await q(`select distinct on (type) type, granted, recorded_at from consents where parent_id=$1 order by type, recorded_at desc`),
          careTeam: await q(`select sa.user_id, u.first_name, sa.role, sa.started_at, sa.ended_at from staff_assignments sa join users u on u.id=sa.user_id where sa.parent_id=$1 order by sa.started_at desc`),
          replacements: await q(`select id, reason, target_at, resolved_at, created_at from replacement_requests where parent_id=$1 order by created_at desc`),
        };
      });
    });

    /** F16.3 Schedule: by pod/staff, with day route. */
    r.get('/admin/schedule', async (req) => {
      const q = parse(z.object({ from: z.string().datetime(), to: z.string().datetime(), podId: z.string().uuid().optional(), staffId: z.string().uuid().optional() }), req.query);
      return d.db.as(dash(req), async (c) => ({
        items: (await c.query(
          `select v.id, v.type, v.status, v.scheduled_at, v.duration_min, v.staff_user_id, u.first_name staff, v.parent_id, p.name parent_name, p.neighborhood, v.pod_id
           from visits v join parents p on p.id=v.parent_id left join users u on u.id=v.staff_user_id
           where v.scheduled_at >= $1 and v.scheduled_at < $2 and ($3::uuid is null or v.pod_id=$3) and ($4::uuid is null or v.staff_user_id=$4) and v.status <> 'cancelled'
           order by v.scheduled_at limit 2000`, [q.from, q.to, q.podId ?? null, q.staffId ?? null])).rows,
      }));
    });
    r.post('/admin/visits', async (req) => {
      const b = parse(visitSchedule, req.body);
      const a = requireCap(req, 'visit.schedule');
      return d.db.as(a, async (c) => {
        const p = (await c.query(`select city_id, pod_id from parents where id=$1`, [b.parentId])).rows[0];
        if (!p) throw notFound();
        const v = (await c.query(`insert into visits (parent_id, city_id, pod_id, type, scheduled_at, duration_min, source) values ($1,$2,$3,$4,$5,$6,'manual') returning id`, [b.parentId, p.city_id, p.pod_id, b.type, b.scheduledAt, b.durationMin])).rows[0];
        if (b.staffId) await assignStaff(c, v.id, b.staffId, a.userId);
        await scheduleVisitJobs(c, v.id, new Date(b.scheduledAt), (await getConfig(c)).noShowGraceMin);
        await audit(c, { actorUserId: a.userId, action: 'visit.create', entityType: 'visit', entityId: v.id, parentId: b.parentId, after: b });
        return { id: v.id };
      });
    });
    r.post('/admin/visits/:id/assign', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ staffId: z.string().uuid().nullable(), scheduledAt: z.string().datetime().optional() }), req.body);
      const a = requireCap(req, 'visit.schedule');
      await d.db.as(a, async (c) => {
        await assignStaff(c, id, b.staffId, a.userId);
        if (b.scheduledAt) {
          await c.query(`update visits set scheduled_at=$2, updated_at=$3 where id=$1`, [id, b.scheduledAt, now()]);
          await scheduleVisitJobs(c, id, new Date(b.scheduledAt), (await getConfig(c)).noShowGraceMin);
        }
      });
      return { ok: true };
    });
    r.post('/admin/visits/:id/cancel', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ reason: z.string().min(2) }), req.body);
      const a = requireCap(req, 'visit.schedule');
      await d.db.as(a, async (c) => {
        const v = (await c.query(`update visits set status='cancelled', updated_at=$2 where id=$1 and status='scheduled' returning parent_id`, [id, now()])).rows[0];
        if (!v) throw new AppError(409, 'not_cancellable');
        await audit(c, { actorUserId: a.userId, action: 'visit.cancel', entityType: 'visit', entityId: id, parentId: v.parent_id, meta: { reason: b.reason } });
      });
      return { ok: true };
    });
    /** F5: admin override of geofence, with reason (logged). */
    r.post('/admin/visits/:id/check-in-override', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ reason: z.string().min(5).max(300) }), req.body);
      const a = requireCap(req, 'checkin.override');
      await d.db.as(a, async (c) => {
        const v = (await c.query(`update visits set check_in_override_reason=$2, check_in_override_by=$3 where id=$1 and checked_in_at is null returning parent_id`, [id, b.reason, a.userId])).rows[0];
        if (!v) throw new AppError(409, 'already_checked_in');
        await audit(c, { actorUserId: a.userId, action: 'visit.check_in_override', entityType: 'visit', entityId: id, parentId: v.parent_id, meta: { reason: b.reason } });
      });
      return { ok: true };
    });

    /** F10: coordinator publishes care plan. */
    r.post('/admin/parents/:id/care-plans', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ content: z.record(z.unknown()) }), req.body);
      return d.db.as(requireCap(req, 'careplan.publish'), (c) => publishCarePlan(c, now(), actor(req), id, b.content as any));
    });

    // ── F16.4 Staff ──
    r.get('/admin/staff', async (req) => d.db.as(dash(req), async (c) => ({
      items: (await c.query(
        `select s.user_id id, u.first_name, u.display_name, s.role, s.languages, s.gender, s.pod_id, s.active, staff_is_verified(s.user_id) verified,
           (select json_agg(json_build_object('item', sv.item, 'completedOn', sv.completed_on)) from staff_verifications sv where sv.user_id=s.user_id) verification,
           (select count(*) filter (where v.status='completed')::int from visits v where v.staff_user_id=s.user_id and v.scheduled_at > $1) completed_30d,
           (select count(*) filter (where v.status in ('completed','missed') or (v.status='scheduled' and v.scheduled_at < $2))::int from visits v where v.staff_user_id=s.user_id and v.scheduled_at > $1 and v.scheduled_at < $2) due_30d,
           (select count(*) filter (where v.checked_in_at <= v.scheduled_at + interval '15 minutes')::int from visits v where v.staff_user_id=s.user_id and v.scheduled_at > $1 and v.checked_in_at is not null) on_time_30d,
           (select avg(extract(epoch from (v.submitted_at - v.checked_out_at)))::int from visits v where v.staff_user_id=s.user_id and v.scheduled_at > $1 and v.submitted_at is not null) avg_report_delay_s
         from staff s join users u on u.id=s.user_id order by s.active desc, s.role, u.first_name`, [new Date(now().getTime() - 30 * 86_400_000), now()])).rows,
    })));
    r.post('/admin/staff', async (req) => {
      const b = parse(z.object({ phone: z.string(), firstName: z.string().min(1).max(40), displayName: z.string().max(80).default(''), role: z.enum(STAFF_ROLES as [string, ...string[]]), languages: z.array(z.enum(['ar', 'en'])).default(['ar']), gender: z.enum(['female', 'male']), podId: z.string().uuid().nullable().default(null), cityId: z.string().uuid().nullable().default(null), language: z.enum(['ar', 'en']).default('ar') }), req.body);
      const a = requireCap(req, 'staff.manage');
      const phone = toE164(b.phone, 'EG');
      if (!phone) throw badRequest('invalid_phone');
      return d.db.as(a, async (c) => {
        const ph = d.crypto.blindIndex(phone);
        if ((await c.query(`select 1 from users where phone_hash=$1`, [ph])).rowCount) throw new AppError(409, 'phone_in_use');
        const roles = b.role === 'oncall_doctor' ? ['doctor', 'oncall_doctor'] : [b.role];
        const u = (await c.query(`insert into users (phone_enc, phone_hash, first_name, display_name, roles, language) values ($1,$2,$3,$4,$5,$6) returning id`, [d.crypto.encrypt(phone), ph, b.firstName, b.displayName || b.firstName, roles, b.language])).rows[0];
        await c.query(`insert into staff (user_id, role, languages, gender, pod_id, city_id) values ($1,$2,$3,$4,$5,$6)`, [u.id, b.role, b.languages, b.gender, b.podId, b.cityId]);
        await audit(c, { actorUserId: a.userId, action: 'staff.create', entityType: 'staff', entityId: u.id, after: { ...b, phone: '[encrypted]' } });
        return { id: u.id };
      });
    });
    r.put('/admin/staff/:id/verification', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ item: z.enum(['id_checked', 'background_check', 'reference_check', 'training']), completedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }), req.body);
      const a = requireCap(req, 'staff.manage');
      await d.db.as(a, async (c) => {
        if (b.completedOn) await c.query(`insert into staff_verifications (user_id, item, completed_on, verified_by) values ($1,$2,$3,$4) on conflict (user_id, item) do update set completed_on=excluded.completed_on, verified_by=excluded.verified_by`, [id, b.item, b.completedOn, a.userId]);
        else await c.query(`delete from staff_verifications where user_id=$1 and item=$2`, [id, b.item]);
        await audit(c, { actorUserId: a.userId, action: 'staff.verification', entityType: 'staff', entityId: id, after: b });
      });
      return { ok: true };
    });
    r.post('/admin/staff/:id/deactivate', async (req) => {
      const { id } = parse(idParam, req.params);
      const a = requireCap(req, 'staff.manage');
      return d.db.as(a, async (c) => {
        await c.query(`update staff set active=false where user_id=$1`, [id]);
        const n = await revokeUserSessions(c, id, now(), 'offboarded');
        await c.query(`update staff_assignments set ended_at=$2, end_reason='offboarded' where user_id=$1 and ended_at is null`, [id, now()]);
        const unassigned = (await c.query(`update visits set staff_user_id=null where staff_user_id=$1 and status='scheduled' and scheduled_at > $2 returning id`, [id, now()])).rowCount;
        await audit(c, { actorUserId: a.userId, action: 'staff.deactivate', entityType: 'staff', entityId: id, meta: { sessionsRevoked: n, visitsUnassigned: unassigned } });
        return { sessionsRevoked: n, visitsUnassigned: unassigned };
      });
    });
    r.post('/admin/staff/:id/revoke-sessions', async (req) => {
      const { id } = parse(idParam, req.params);
      const a = requireCap(req, 'staff.manage');
      return d.db.as(a, async (c) => { const n = await revokeUserSessions(c, id, now(), 'admin_revoked'); await audit(c, { actorUserId: a.userId, action: 'staff.revoke_sessions', entityType: 'staff', entityId: id, meta: { n } }); return { revoked: n }; });
    });
    r.get('/admin/oncall', async (req) => {
      const q = parse(z.object({ from: z.string().datetime(), to: z.string().datetime() }), req.query);
      return d.db.as(dash(req), async (c) => ({ items: (await c.query(`select o.*, u.first_name from oncall_rota o join users u on u.id=o.user_id where o.ends_at > $1 and o.starts_at < $2 order by o.starts_at`, [q.from, q.to])).rows }));
    });
    r.post('/admin/oncall', async (req) => {
      const b = parse(z.object({ cityId: z.string().uuid(), userId: z.string().uuid(), tier: z.enum(['primary', 'backup']), startsAt: z.string().datetime(), endsAt: z.string().datetime() }), req.body);
      const a = requireCap(req, 'staff.manage');
      return d.db.as(a, async (c) => {
        const ok = (await c.query(`select 1 from staff where user_id=$1 and active and role in ('doctor','oncall_doctor') and staff_is_verified(user_id)`, [b.userId])).rowCount;
        if (!ok) throw new AppError(422, 'oncall_must_be_verified_doctor');
        const r0 = (await c.query(`insert into oncall_rota (city_id, user_id, tier, starts_at, ends_at) values ($1,$2,$3,$4,$5) returning id`, [b.cityId, b.userId, b.tier, b.startsAt, b.endsAt])).rows[0];
        await audit(c, { actorUserId: a.userId, action: 'oncall.add', entityType: 'oncall', entityId: r0.id, after: b });
        return { id: r0.id };
      });
    });
    r.delete('/admin/oncall/:id', async (req) => { const { id } = parse(idParam, req.params); const a = requireCap(req, 'staff.manage'); await d.db.as(a, async (c) => { await c.query(`delete from oncall_rota where id=$1`, [id]); await audit(c, { actorUserId: a.userId, action: 'oncall.remove', entityType: 'oncall', entityId: id }); }); return { ok: true }; });

    // ── F16.5 Payments ──
    r.get('/admin/payments', async (req) => d.db.as(requireCap(req, 'refund.issue'), async (c) => {
      const since = new Date(now().getTime() - 31 * 86_400_000);
      return {
        subscriptions: (await c.query(`select s.status, s.plan_code, s.currency, count(*)::int n from subscriptions s group by 1,2,3 order by 1,2,3`)).rows,
        failures: (await c.query(`select s.id, p.name, s.status, s.failed_attempts, s.next_retry_at, s.currency from subscriptions s join parents p on p.id=s.parent_id where s.status in ('past_due','paused') order by s.next_retry_at nulls last`)).rows,
        recent: (await c.query(`select py.id, py.kind, py.status, py.amount, py.currency, py.created_at, py.failure_reason, p.name from payments py join parents p on p.id=py.parent_id order by py.created_at desc limit 100`)).rows,
        passThrough: (await c.query(`select pt.id, p.name, pt.category, pt.description, pt.amount, pt.currency, pt.handling_fee, pt.invoice_id, pt.created_at from pass_through_charges pt join parents p on p.id=pt.parent_id order by pt.created_at desc limit 100`)).rows,
        refunds: (await c.query(`select r.id, r.amount, r.reason, r.status, r.created_at, py.currency from refunds r join payments py on py.id=r.payment_id order by r.created_at desc limit 50`)).rows,
        revenueByCurrency: (await c.query(`select currency, sum(amount)::int gross, count(*)::int n from payments where status in ('succeeded','partially_refunded') and created_at > $1 group by currency`, [since])).rows,
      };
    }));
    r.post('/admin/payments/:id/refund', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ amount: z.number().int().positive(), reason: z.string().min(3).max(300) }), req.body);
      return d.db.as(requireCap(req, 'refund.issue'), (c) => refund(d, c, actor(req), id, b.amount, b.reason));
    });

    // ── F16.6 Settings ──
    r.get('/admin/settings', async (req) => d.db.as(requireCap(req, 'settings.manage'), async (c) => ({
      config: await getConfig(c), defaults: defaultConfig,
      plans: (await c.query(`select * from plans order by code`)).rows,
      prices: (await c.query(`select * from plan_prices order by plan_code, currency`)).rows,
      checklistTemplates: (await c.query(`select id, visit_type, version, definition, active from checklist_templates where active order by visit_type`)).rows,
      notificationTemplates: (await c.query(`select type, language, body, whatsapp_template_name, updated_at from notification_templates order by type, language`)).rows,
      cities: (await c.query(`select * from cities order by name_en`)).rows,
      pods: (await c.query(`select po.*, u.first_name coordinator from pods po left join users u on u.id=po.coordinator_user_id order by po.name`)).rows,
    })));
    r.patch('/admin/settings/config', async (req) => {
      const a = requireCap(req, 'settings.manage');
      const b = parse(z.record(z.unknown()), req.body);
      return d.db.as(a, async (c) => {
        let res;
        try { res = await setConfig(c, b as any, a.userId); } catch (e: any) { throw badRequest(e.message); }
        await audit(c, { actorUserId: a.userId, action: 'settings.config', entityType: 'settings', entityId: 'config', before: res.before, after: res.after });
        return res.after;
      });
    });
    r.put('/admin/plan-prices', async (req) => {
      const a = requireCap(req, 'pricing.manage');
      const b = parse(z.object({ planCode: z.enum(PLAN_CODES), currency: z.enum(CURRENCIES), amount: z.number().int().positive() }), req.body);
      return d.db.as(a, async (c) => {
        const before = (await c.query(`select amount from plan_prices where plan_code=$1 and currency=$2`, [b.planCode, b.currency])).rows[0];
        await c.query(`insert into plan_prices (plan_code, currency, amount) values ($1,$2,$3) on conflict (plan_code, currency) do update set amount=excluded.amount`, [b.planCode, b.currency, b.amount]);
        await audit(c, { actorUserId: a.userId, action: 'pricing.update', entityType: 'plan_price', entityId: `${b.planCode}:${b.currency}`, before, after: b });
        return { ok: true };
      });
    });
    /** Per-family Caregiver price and the admin-applied "founding family" price (only discount in V1). */
    r.put('/admin/parents/:id/custom-price', async (req) => {
      const { id } = parse(idParam, req.params);
      const a = requireCap(req, 'pricing.manage');
      const b = parse(z.object({ kind: z.enum(['caregiver', 'founding']), planCode: z.enum(PLAN_CODES), currency: z.enum(CURRENCIES), amount: z.number().int().positive() }), req.body);
      if (b.kind === 'caregiver' && b.planCode !== 'caregiver') throw badRequest('caregiver_price_is_for_caregiver_plan');
      const key = b.kind === 'caregiver' ? `caregiver_price:${id}:${b.currency}` : `founding_price:${id}:${b.planCode}:${b.currency}`;
      return d.db.as(a, async (c) => {
        await c.query(`insert into settings (key, value, updated_by) values ($1,$2,$3) on conflict (key) do update set value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`, [key, { amount: b.amount }, a.userId]);
        await c.query(`update subscriptions set custom_amount=$2, founding_family=$3 where parent_id=$1 and status <> 'cancelled' and plan_code=$4 and currency=$5`, [id, b.amount, b.kind === 'founding', b.planCode, b.currency]);
        await audit(c, { actorUserId: a.userId, action: `pricing.${b.kind}`, entityType: 'parent', entityId: id, parentId: id, after: b });
        return { ok: true };
      });
    });
    r.put('/admin/checklist-templates', async (req) => {
      const a = requireCap(req, 'settings.manage');
      const b = parse(checklistTemplate.omit({ version: true }), req.body);
      return d.db.as(a, async (c) => {
        const v = (await c.query(`select coalesce(max(version),0)+1 v from checklist_templates where visit_type=$1`, [b.visitType])).rows[0].v;
        await c.query(`update checklist_templates set active=false where visit_type=$1`, [b.visitType]);
        const t = (await c.query(`insert into checklist_templates (visit_type, version, definition, updated_by) values ($1,$2,$3,$4) returning id`, [b.visitType, v, { ...b, version: v }, a.userId])).rows[0];
        await audit(c, { actorUserId: a.userId, action: 'template.checklist', entityType: 'checklist_template', entityId: t.id, after: { ...b, version: v } });
        return { id: t.id, version: v };
      });
    });
    r.put('/admin/notification-templates', async (req) => {
      const a = requireCap(req, 'settings.manage');
      const b = parse(z.object({ type: z.enum(NOTIFICATION_TYPES), language: z.enum(['ar', 'en']), body: z.string().min(3).max(1000), whatsappTemplateName: z.string().max(100).optional() }), req.body);
      return d.db.as(a, async (c) => {
        await c.query(`insert into notification_templates (type, language, body, whatsapp_template_name, updated_by, updated_at) values ($1,$2,$3,$4,$5,now()) on conflict (type, language) do update set body=excluded.body, whatsapp_template_name=excluded.whatsapp_template_name, updated_by=excluded.updated_by, updated_at=now()`, [b.type, b.language, b.body, b.whatsappTemplateName ?? null, a.userId]);
        await audit(c, { actorUserId: a.userId, action: 'template.notification', entityType: 'notification_template', entityId: `${b.type}:${b.language}`, after: b });
        return { ok: true };
      });
    });
    r.post('/admin/cities', async (req) => {
      const a = requireCap(req, 'settings.manage');
      const b = parse(z.object({ nameEn: z.string().min(2), nameAr: z.string().min(2), timezone: z.string().default('Africa/Cairo') }), req.body);
      return d.db.as(a, async (c) => { const x = (await c.query(`insert into cities (name_en, name_ar, timezone) values ($1,$2,$3) returning id`, [b.nameEn, b.nameAr, b.timezone])).rows[0]; await audit(c, { actorUserId: a.userId, action: 'city.create', entityType: 'city', entityId: x.id, after: b }); return x; });
    });
    r.post('/admin/pods', async (req) => {
      const a = requireCap(req, 'settings.manage');
      const b = parse(z.object({ cityId: z.string().uuid(), name: z.string().min(2), coordinatorUserId: z.string().uuid().nullable(), neighborhoods: z.array(z.string()).default([]) }), req.body);
      return d.db.as(a, async (c) => { const x = (await c.query(`insert into pods (city_id, name, coordinator_user_id, neighborhoods) values ($1,$2,$3,$4) returning id`, [b.cityId, b.name, b.coordinatorUserId, b.neighborhoods])).rows[0]; await audit(c, { actorUserId: a.userId, action: 'pod.create', entityType: 'pod', entityId: x.id, after: b }); return x; });
    });

    // ── F16.7 Audit log, jobs view ──
    r.get('/admin/audit', async (req) => {
      const q = parse(z.object({ parentId: z.string().uuid().optional(), actorId: z.string().uuid().optional(), action: z.string().max(60).optional(), beforeId: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query);
      return d.db.as(requireCap(req, 'audit.view'), async (c) => ({
        items: (await c.query(`select a.*, u.first_name actor_name from audit_log a left join users u on u.id=a.actor_user_id where ($1::uuid is null or a.parent_id=$1) and ($2::uuid is null or a.actor_user_id=$2) and ($3::text is null or a.action like $3 || '%') and ($4::bigint is null or a.id < $4) order by a.id desc limit $5`, [q.parentId ?? null, q.actorId ?? null, q.action ?? null, q.beforeId ?? null, q.limit])).rows,
      }));
    });
    r.get('/admin/jobs', async (req) => {
      const q = parse(z.object({ status: z.enum(['queued', 'running', 'done', 'failed', 'dead']).optional(), name: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query);
      return d.db.as(requireCap(req, 'settings.manage'), async (c) => ({
        summary: (await c.query(`select name, status, count(*)::int n from jobs where created_at > $1 group by 1,2 order by 1,2`, [new Date(now().getTime() - 86_400_000)])).rows,
        items: (await c.query(`select id, name, status, run_at, attempts, max_attempts, last_error, created_at, finished_at from jobs where ($1::text is null or status=$1) and ($2::text is null or name=$2) order by id desc limit $3`, [q.status ?? null, q.name ?? null, q.limit])).rows,
      }));
    });
    r.post('/admin/jobs/:id/retry', async (req) => {
      const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
      const a = requireCap(req, 'settings.manage');
      await d.db.as(a, async (c) => { await c.query(`update jobs set status='queued', run_at=$2, attempts=0 where id=$1 and status in ('failed','dead')`, [id, now()]); await audit(c, { actorUserId: a.userId, action: 'job.retry', entityType: 'job', entityId: String(id) }); });
      return { ok: true };
    });
    r.get('/admin/notifications', async (req) => {
      const q = parse(z.object({ parentId: z.string().uuid().optional(), status: z.string().optional(), limit: z.coerce.number().int().max(200).default(100) }), req.query);
      return d.db.as(dash(req), async (c) => ({ items: (await c.query(`select id, type, channel, language, status, error, body, created_at, sent_at, parent_id from notifications where ($1::uuid is null or parent_id=$1) and ($2::text is null or status=$2) order by created_at desc limit $3`, [q.parentId ?? null, q.status ?? null, q.limit])).rows }));
    });

    // ── F18 help line ──
    r.post('/admin/helpline', async (req) => {
      const b = parse(helplineCall, req.body);
      const a = requireCap(req, 'helpline.log');
      return d.db.as(a, async (c) => {
        const p = b.parentId ? (await c.query(`select city_id, pod_id from parents where id=$1`, [b.parentId])).rows[0] : null;
        const call = (await c.query(`insert into helpline_calls (parent_id, city_id, pod_id, caller_name, caller_phone_enc, summary, logged_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [b.parentId, p?.city_id ?? null, p?.pod_id ?? null, b.callerName, d.crypto.encryptNullable(b.callerPhone ? toE164(b.callerPhone, 'EG') ?? b.callerPhone : null), b.summary, a.userId, now()])).rows[0];
        let escalationId: string | null = null;
        if (b.convertToEscalation) {
          if (!b.parentId) throw badRequest('parent_required_for_escalation');
          escalationId = (await createEscalation(c, now(), { parentId: b.parentId, trigger: 'helpline_call', severity: b.severity, createdBy: a.userId, note: b.summary, sourceRef: `call:${call.id}` })).id;
          await c.query(`update helpline_calls set escalation_id=$2 where id=$1`, [call.id, escalationId]);
        }
        await audit(c, { actorUserId: a.userId, action: 'helpline.log', entityType: 'helpline_call', entityId: call.id, parentId: b.parentId });
        return { id: call.id, escalationId };
      });
    });
    r.post('/admin/helpline/:id/escalate', async (req) => {
      const { id } = parse(idParam, req.params);
      const a = requireCap(req, 'helpline.log');
      return d.db.as(a, async (c) => {
        const call = (await c.query(`select * from helpline_calls where id=$1 for update`, [id])).rows[0];
        if (!call?.parent_id) throw badRequest('parent_required_for_escalation');
        if (call.escalation_id) return { escalationId: call.escalation_id };
        const e = await createEscalation(c, now(), { parentId: call.parent_id, trigger: 'helpline_call', severity: 'urgent', createdBy: a.userId, note: call.summary, sourceRef: `call:${id}` });
        await c.query(`update helpline_calls set escalation_id=$2 where id=$1`, [id, e.id]);
        return { escalationId: e.id };
      });
    });
    r.get('/admin/helpline', async (req) => d.db.as(requireCap(req, 'helpline.log'), async (c) => ({ items: (await c.query(`select h.id, h.parent_id, p.name parent_name, h.caller_name, h.summary, h.escalation_id, h.created_at from helpline_calls h left join parents p on p.id=h.parent_id order by h.created_at desc limit 100`)).rows })));

    // ── Concerns / replacement handling ──
    r.post('/admin/concerns/:id', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ status: z.enum(['in_progress', 'resolved']), resolution: z.string().max(2000).optional(), ownerUserId: z.string().uuid().optional() }), req.body);
      await d.db.as(requireCap(req, 'concern.handle'), (c) => updateConcern(c, now(), actor(req), id, b));
      return { ok: true };
    });
    r.post('/admin/replacements/:id/resolve', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ newStaffUserId: z.string().uuid() }), req.body);
      await d.db.as(requireCap(req, 'visit.schedule'), (c) => resolveReplacement(c, now(), actor(req), id, b.newStaffUserId));
      return { ok: true };
    });
    r.get('/admin/assessment-slots', async (req) => d.db.as(dash(req), async (c) => ({ items: (await c.query(`select s.*, p.name parent_name from assessment_slots s left join parents p on p.id=s.booked_parent_id where s.starts_at > $1 order by s.starts_at limit 200`, [now()])).rows })));
    r.post('/admin/assessment-slots', async (req) => {
      const b = parse(z.object({ podId: z.string().uuid(), coordinatorUserId: z.string().uuid(), startsAt: z.string().datetime(), durationMin: z.number().int().min(30).max(180).default(60) }), req.body);
      const a = requireCap(req, 'visit.schedule');
      return d.db.as(a, async (c) => (await c.query(`insert into assessment_slots (pod_id, coordinator_user_id, starts_at, ends_at) values ($1,$2,$3,$4) returning id`, [b.podId, b.coordinatorUserId, b.startsAt, new Date(new Date(b.startsAt).getTime() + b.durationMin * 60000)])).rows[0]);
    });
    /** §14 metrics. */
    r.get('/admin/metrics', async (req) => d.db.as(requireCap(req, 'audit.view'), async (c) => {
      const since = new Date(now().getTime() - 7 * 86_400_000), since30 = new Date(now().getTime() - 30 * 86_400_000);
      const one = async (sql: string, p: unknown[] = [since30]) => (await c.query(sql, p)).rows[0];
      return {
        weeklyEngagement: await one(`select count(distinct p.id)::int active_families, (select count(distinct parent_id) from analytics_events where name in ('timeline_opened','whatsapp_report_opened') and at > $1)::int engaged from parents p where p.status='active'`, [since]),
        reportsWithin24h: await one(`select count(*) filter (where submitted_at - checked_out_at <= interval '24 hours')::int ok, count(*)::int total from visits where status='completed' and scheduled_at > $1`),
        escalationsFamilyTold15m: await one(`select count(*) filter (where family_notified_at - created_at <= interval '15 minutes')::int ok, count(*)::int total from escalations where created_at > $1`),
        missedDosesResolvedSameDay: await one(`select count(*) filter (where confirmed_at is not null and confirmed_at::date = scheduled_at::date)::int ok, count(*) filter (where coordinator_alerted_at is not null)::int total from dose_events where scheduled_at > $1`),
        concernsByDeadline: await one(`select count(*) filter (where resolved_at <= deadline)::int ok, count(*) filter (where status='resolved' or deadline < now())::int total from concerns where created_at > $1`),
        dashboardTimePerFamily: await one(`select coalesce(sum((props->>'seconds')::int),0)::int seconds, count(distinct parent_id)::int families from analytics_events where name='dashboard_family_time' and at > $1`, [since]),
        renewalMonthTwo: await one(`select count(*) filter (where exists (select 1 from payments py where py.subscription_id=s.id and py.kind in ('renewal','retry') and py.status='succeeded'))::int renewed, count(*)::int eligible from subscriptions s where s.created_at < $1`, [since30]),
      };
    }));
  });
}
