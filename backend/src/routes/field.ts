import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consentRecord, escalationClose, escalationDecision, groupRoute, localParts, medicationCreate, passThroughCreate, syncBatch, zonedTimeToUtc, addDays } from '@barr/shared';
import type { Deps } from '../deps';
import { actor, assertParentAccess, authHook, parse, requireCap, requireRole } from '../http';
import { applySync, templateFor } from '../services/visits';
import { acknowledge, addFollowUp, closeEscalation, recordDecision } from '../services/escalations';
import { recordPassThrough } from '../services/payments';
import { unreadCounts } from '../services/care';
import { generateDosesForParent } from '../services/automation';
import { audit } from '../services/audit';
import { getConfig } from '../services/settings';
import { notFound } from '../lib/errors';

const idParam = z.object({ id: z.string().uuid() });

export async function fieldRoutes(app: FastifyInstance, d: Deps) {
  app.register(async (r) => {
    r.addHook('preHandler', authHook(d));
    const now = () => d.clock.now();

    /** Visits for a day (default today, Egypt time) for the signed-in staff member, plus the route grouping. */
    r.get('/field/visits', async (req) => {
      const a = requireCap(req, 'visit.perform');
      const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
      return d.db.as(a, async (c) => {
        const cfg = await getConfig(c);
        const date = q.date ?? localParts(now(), cfg.timezone).date;
        const rows = (await c.query(
          `select v.id, v.type, v.status, v.scheduled_at, v.duration_min, v.checked_in_at, v.checked_out_at, p.id parent_id, p.name parent_name, p.neighborhood, p.lat, p.lng,
                  parent_has_photo_consent(p.id) photo_consent, p.allergies_has
           from visits v join parents p on p.id=v.parent_id where v.staff_user_id=$1 and v.scheduled_at >= $2 and v.scheduled_at < $3 and v.status <> 'cancelled' order by v.scheduled_at`,
          [a.userId, zonedTimeToUtc(date, '00:00', cfg.timezone), zonedTimeToUtc(addDays(date, 1), '00:00', cfg.timezone)])).rows;
        const route = groupRoute(rows.map((v) => ({ ...v, neighborhood: v.neighborhood || '—', scheduledAt: v.scheduled_at }))).map((g) => ({ neighborhood: g.neighborhood, visitIds: g.visits.map((v) => v.id) }));
        return { date, items: rows, route, checkInRadiusM: cfg.checkInRadiusM };
      });
    });

    /** Everything needed to perform a visit offline: template, parent essentials (incl. address), consent, today's doses. */
    r.get('/field/visits/:id', async (req) => {
      const { id } = parse(idParam, req.params);
      const a = requireCap(req, 'visit.perform');
      return d.db.as(a, async (c) => {
        const v = (await c.query(`select * from visits where id=$1`, [id])).rows[0];
        if (!v) throw notFound();
        await assertParentAccess(c, v.parent_id);
        const p = (await c.query(`select id, name, gender, address_enc, neighborhood, lat, lng, language, allergies_has, allergies_text, mobility_notes, emergency_contacts_enc from parents where id=$1`, [v.parent_id])).rows[0];
        await audit(c, { actorUserId: a.userId, action: 'parent.read', entityType: 'parent', entityId: p.id, parentId: p.id, meta: { via: 'field_visit', visitId: id } });
        const tpl = await templateFor(c, v.type);
        const consent = (await c.query(`select distinct on (type) type, granted from consents where parent_id=$1 order by type, recorded_at desc`, [p.id])).rows;
        const meds = (await c.query(`select id, name, dose_text, times_of_day, instructions from medications where parent_id=$1 and active`, [p.id])).rows;
        const cfg = await getConfig(c);
        const today = localParts(now(), cfg.timezone).date;
        const doses = (await c.query(`select de.id, de.scheduled_at, de.status, m.name from dose_events de join medications m on m.id=de.medication_id where de.parent_id=$1 and de.scheduled_at >= $2 and de.scheduled_at < $3 order by de.scheduled_at`, [p.id, zonedTimeToUtc(today, '00:00', cfg.timezone), zonedTimeToUtc(addDays(today, 1), '00:00', cfg.timezone)])).rows;
        return {
          visit: { id: v.id, type: v.type, status: v.status, scheduledAt: v.scheduled_at, checkedInAt: v.checked_in_at, checkedOutAt: v.checked_out_at, overrideActive: !!v.check_in_override_reason },
          parent: { id: p.id, name: p.name, gender: p.gender, address: d.crypto.decrypt(p.address_enc), neighborhood: p.neighborhood, location: { lat: p.lat, lng: p.lng }, language: p.language, allergies: { has: p.allergies_has, text: p.allergies_text }, mobilityNotes: p.mobility_notes, emergencyContacts: p.emergency_contacts_enc ? JSON.parse(d.crypto.decrypt(p.emergency_contacts_enc)) : [] },
          template: tpl?.def ?? null,
          consent: Object.fromEntries(consent.map((x) => [x.type, x.granted])),
          medications: meds, doses, checkInRadiusM: cfg.checkInRadiusM, maxPhotos: cfg.maxPhotosPerVisit,
        };
      });
    });

    /** Offline outbox sync (check-in, check-out, report, dose confirmations). */
    r.post('/field/sync', async (req) => {
      const a = requireCap(req, 'visit.perform');
      const b = parse(syncBatch, req.body);
      return applySync(d, a, b.ops);
    });

    // ── Escalations (F8) ──
    r.get('/field/escalations', async (req) => {
      const a = requireRole(req, 'doctor', 'oncall_doctor', 'coordinator', 'admin');
      return d.db.as(a, async (c) => ({ items: (await c.query(`select e.id, e.parent_id, p.name parent_name, e.trigger, e.severity, e.status, e.created_at, e.acknowledged_at, e.note from escalations e join parents p on p.id=e.parent_id where e.status <> 'closed' order by e.severity = 'urgent' desc, e.created_at limit 100`)).rows }));
    });
    r.post('/escalations/:id/acknowledge', async (req) => { const { id } = parse(idParam, req.params); return d.db.as(requireCap(req, 'escalation.acknowledge'), (c) => acknowledge(c, now(), id, actor(req).userId)); });
    r.post('/escalations/:id/decision', async (req) => { const { id } = parse(idParam, req.params); const b = parse(escalationDecision, req.body); await d.db.as(requireCap(req, 'escalation.resolve'), (c) => recordDecision(c, now(), id, actor(req).userId, b.decision, b.note)); return { ok: true }; });
    r.post('/escalations/:id/follow-up', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(z.object({ note: z.string().min(2).max(2000), visibleToFamily: z.boolean().default(true) }), req.body);
      const a = requireRole(req, 'coordinator', 'doctor', 'oncall_doctor', 'admin');
      await d.db.as(a, (c) => addFollowUp(c, now(), id, a.userId, b.note, b.visibleToFamily));
      return { ok: true };
    });
    r.post('/escalations/:id/close', async (req) => {
      const { id } = parse(idParam, req.params);
      const b = parse(escalationClose, req.body);
      const a = requireRole(req, 'coordinator', 'doctor', 'oncall_doctor', 'admin');
      await d.db.as(a, (c) => closeEscalation(c, now(), id, a.userId, b.note));
      return { ok: true };
    });

    // ── Medicines (F7) ──
    r.post('/medications', async (req) => {
      const b = parse(medicationCreate, req.body);
      const a = requireCap(req, 'medication.manage');
      return d.db.as(a, async (c) => {
        await assertParentAccess(c, b.parentId);
        const m = (await c.query(`insert into medications (parent_id, name, dose_text, times_of_day, start_date, end_date, instructions, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [
          b.parentId, b.name, b.doseText, b.timesOfDay, b.startDate, b.endDate, b.instructions, a.userId])).rows[0];
        const cfg = await getConfig(c);
        const today = localParts(now(), cfg.timezone).date;
        await generateDosesForParent(c, b.parentId, today);
        await generateDosesForParent(c, b.parentId, addDays(today, 1));
        await audit(c, { actorUserId: a.userId, action: 'medication.create', entityType: 'medication', entityId: m.id, parentId: b.parentId, after: b });
        return { id: m.id };
      });
    });
    r.post('/medications/:id/stop', async (req) => {
      const { id } = parse(idParam, req.params);
      const a = requireCap(req, 'medication.manage');
      return d.db.as(a, async (c) => {
        const m = (await c.query(`update medications set active=false, end_date=coalesce(end_date, current_date) where id=$1 returning parent_id`, [id])).rows[0];
        if (!m) throw notFound();
        await c.query(`update dose_events set status='skipped', note='medication stopped' where medication_id=$1 and status='scheduled' and scheduled_at > $2`, [id, now()]);
        await audit(c, { actorUserId: a.userId, action: 'medication.stop', entityType: 'medication', entityId: id, parentId: m.parent_id });
        return { ok: true };
      });
    });

    // ── Consent (F15) ──
    r.post('/consents', async (req) => {
      const b = parse(consentRecord, req.body);
      const a = requireRole(req, 'coordinator', 'nurse', 'doctor', 'admin');
      return d.db.as(a, async (c) => {
        await assertParentAccess(c, b.parentId);
        const p = (await c.query(`select city_id, pod_id from parents where id=$1`, [b.parentId])).rows[0];
        for (const x of b.consents) {
          await c.query(`insert into consents (parent_id, city_id, pod_id, type, granted, shared_with, recorded_by, document_ref) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [b.parentId, p.city_id, p.pod_id, x.type, x.granted, b.sharedWithUserIds, a.userId, b.documentKey]);
        }
        await audit(c, { actorUserId: a.userId, action: 'consent.record', entityType: 'parent', entityId: b.parentId, parentId: b.parentId, after: b.consents });
        return { ok: true };
      });
    });

    // ── Pass-through costs (F9) ──
    r.post('/pass-through-charges', async (req) => { const b = parse(passThroughCreate, req.body); return d.db.as(requireCap(req, 'passthrough.record'), async (c) => { await assertParentAccess(c, b.parentId); return recordPassThrough(d, c, actor(req), b); }); });

    // ── Coordinator inbox ──
    r.get('/field/tasks', async (req) => {
      const a = requireRole(req, 'coordinator', 'admin', 'nurse', 'doctor', 'caregiver');
      return d.db.as(a, async (c) => ({ items: (await c.query(`select t.id, t.kind, t.title, t.parent_id, t.due_at, t.created_at, t.ref_type, t.ref_id from tasks t where t.assignee_user_id=$1 and t.status='open' order by t.due_at nulls last limit 200`, [a.userId])).rows }));
    });
    r.post('/tasks/:id/done', async (req) => {
      const { id } = parse(idParam, req.params);
      const a = actor(req);
      return d.db.as(a, async (c) => {
        const t = (await c.query(`update tasks set status='done', done_at=$2, done_by=$3 where id=$1 and status='open' and (assignee_user_id=$3 or $4) returning id`, [id, now(), a.userId, a.roles.includes('admin')])).rows[0];
        if (!t) throw notFound();
        return { ok: true };
      });
    });
    r.get('/field/chats', async (req) => { const a = requireCap(req, 'chat.use'); return d.db.as(a, async (c) => ({ items: await unreadCounts(c, a.userId) })); });
  });
}
