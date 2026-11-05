import {
  assessVital, checkInDecision, templateVisitReportGenerator, type ChecklistTemplate, type SyncOp, type VisitReportSubmission,
} from '@barr/shared';
import type { Actor, Sql } from '../db/pool';
import type { Deps } from '../deps';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { audit, track } from './audit';
import { createTask, notify } from './notifications';
import { getConfig } from './settings';
import { createEscalation } from './escalations';

async function loadVisitForStaff(c: Sql, visitId: string, actor: Actor, lock = true) {
  const v = (await c.query(`select v.*, p.lat, p.lng, p.name as parent_name, p.family_id from visits v join parents p on p.id = v.parent_id where v.id=$1 ${lock ? 'for update of v' : ''}`, [visitId])).rows[0];
  if (!v) throw notFound('visit_not_found');
  if (v.staff_user_id !== actor.userId && !actor.roles.includes('admin')) throw forbidden('not_assigned_to_visit');
  return v;
}

/** Assign staff (F4: DB trigger rejects unverified staff) and record continuity (F13). */
export async function assignStaff(c: Sql, visitId: string, staffUserId: string | null, byUserId: string) {
  const v = (await c.query(`select id, parent_id, staff_user_id, status from visits where id=$1 for update`, [visitId])).rows[0];
  if (!v) throw notFound();
  if (v.status !== 'scheduled') throw new AppError(409, 'visit_not_reassignable');
  try {
    await c.query(`update visits set staff_user_id=$2, updated_at=now() where id=$1`, [visitId, staffUserId]);
  } catch (e: any) {
    if (e?.message === 'staff_not_verified') throw new AppError(422, 'staff_not_verified');
    throw e;
  }
  if (staffUserId) await ensureAssignment(c, v.parent_id, staffUserId);
  await audit(c, { actorUserId: byUserId, action: 'visit.assign', entityType: 'visit', entityId: visitId, parentId: v.parent_id, before: { staff: v.staff_user_id }, after: { staff: staffUserId } });
}

export async function ensureAssignment(c: Sql, parentId: string, userId: string) {
  const role = (await c.query(`select role from staff where user_id=$1`, [userId])).rows[0]?.role ?? 'staff';
  await c.query(
    `insert into staff_assignments (parent_id, user_id, role) select $1,$2,$3
     where not exists (select 1 from staff_assignments where parent_id=$1 and user_id=$2 and ended_at is null)`,
    [parentId, userId, role],
  );
}

/** F5 check-in. Offline captures keep the location and timestamp from capture time. */
export async function checkIn(c: Sql, now: Date, actor: Actor, p: { visitId: string; capturedAt: string; location: { lat: number; lng: number; accuracyM?: number } | null; offline: boolean }) {
  const v = await loadVisitForStaff(c, p.visitId, actor);
  if (v.checked_in_at) return { status: 'already_checked_in' as const, checkedInAt: v.checked_in_at };
  if (v.status === 'cancelled') throw new AppError(409, 'visit_cancelled');
  const cfg = await getConfig(c);
  const decision = checkInDecision({ staff: p.location, home: { lat: v.lat, lng: v.lng }, radiusM: cfg.checkInRadiusM, adminOverrideReason: v.check_in_override_reason });
  if (!decision.allowed) {
    // Audited by applySync in a separate transaction (this one rolls back).
    throw new AppError(422, decision.reason, decision.reason, { distanceM: Math.round(decision.distanceM), radiusM: cfg.checkInRadiusM });
  }
  const capturedAt = new Date(p.capturedAt);
  if (capturedAt.getTime() > now.getTime() + 5 * 60_000) throw badRequest('captured_in_future');
  await c.query(
    `update visits set checked_in_at=$2, check_in_lat=$3, check_in_lng=$4, check_in_accuracy_m=$5, check_in_distance_m=$6, status='in_progress',
       offline_captured = offline_captured or $7, synced_at=$8, updated_at=$8 where id=$1`,
    [v.id, capturedAt, p.location?.lat ?? null, p.location?.lng ?? null, p.location?.accuracyM ?? null, decision.distanceM >= 0 ? decision.distanceM : null, p.offline, now],
  );
  await audit(c, { actorUserId: actor.userId, action: 'visit.check_in', entityType: 'visit', entityId: v.id, parentId: v.parent_id, meta: { distanceM: Math.round(decision.distanceM), overridden: decision.overridden, offline: p.offline } });
  // Close any no-show task for this visit.
  await c.query(`update tasks set status='done', done_at=$2 where ref_type='visit' and ref_id=$1 and kind='no_show' and status='open'`, [v.id, now]);
  return { status: 'checked_in' as const, checkedInAt: capturedAt, distanceM: Math.round(decision.distanceM) };
}

export async function checkOut(c: Sql, now: Date, actor: Actor, p: { visitId: string; capturedAt: string; location: { lat: number; lng: number } | null; offline: boolean }) {
  const v = await loadVisitForStaff(c, p.visitId, actor);
  if (!v.checked_in_at) throw new AppError(409, 'not_checked_in');
  if (v.checked_out_at) return { status: 'already_checked_out' as const };
  const at = new Date(p.capturedAt);
  if (at < v.checked_in_at) throw badRequest('checkout_before_checkin');
  await c.query(`update visits set checked_out_at=$2, check_out_lat=$3, check_out_lng=$4, offline_captured = offline_captured or $5, synced_at=$6, updated_at=$6 where id=$1`, [
    v.id, at, p.location?.lat ?? null, p.location?.lng ?? null, p.offline, now,
  ]);
  await audit(c, { actorUserId: actor.userId, action: 'visit.check_out', entityType: 'visit', entityId: v.id, parentId: v.parent_id });
  return { status: 'checked_out' as const };
}

export async function templateFor(c: Sql, visitType: string): Promise<{ id: string; def: ChecklistTemplate } | null> {
  const t = (await c.query(`select id, definition from checklist_templates where visit_type=$1 and active order by version desc limit 1`, [visitType])).rows[0];
  return t ? { id: t.id, def: t.definition } : null;
}

/**
 * F6 structured report → template generator v1 → family timeline.
 * Idempotent: a visit gets exactly one report; resubmits of a completed visit are a conflict.
 */
export async function submitReport(d: Deps, c: Sql, now: Date, actor: Actor, s: VisitReportSubmission) {
  const v = await loadVisitForStaff(c, s.visitId, actor);
  if (v.status === 'completed') throw new AppError(409, 'already_submitted');
  if (!v.checked_in_at) throw new AppError(409, 'not_checked_in');
  const cfg = await getConfig(c);
  if (s.photoKeys.length > cfg.maxPhotosPerVisit) throw badRequest('too_many_photos');
  if (s.photoKeys.length > 0) {
    const ok = (await c.query(`select parent_has_photo_consent($1) ok`, [v.parent_id])).rows[0].ok;
    if (!ok) throw new AppError(422, 'no_photo_consent'); // F15
    if (s.photoKeys.some((k) => !k.startsWith(`visits/${v.id}/`))) throw badRequest('invalid_photo_key');
  }
  const tpl = await templateFor(c, v.type);
  if (tpl) {
    const allowedObs = new Set(tpl.def.observations);
    const extra = Object.keys(s.observations).filter((k) => !allowedObs.has(k as any));
    if (extra.length) throw badRequest('observation_not_in_template', extra);
    const allowedVitals = new Set(tpl.def.vitals);
    if (s.vitals.some((x) => !allowedVitals.has(x.kind))) throw badRequest('vital_not_in_template');
  }
  const assessed = s.vitals.map((x) => ({ ...x, a: assessVital(x.kind, x.value, cfg.vitalsCritical) }));
  const implausible = assessed.filter((x) => !x.a.plausible);
  if (implausible.length) throw badRequest('implausible_vitals', implausible.map((x) => ({ kind: x.kind, value: x.value })));

  const submittedAt = new Date(s.submittedAt);
  await c.query(`insert into visit_observations (visit_id, parent_id, data, tasks_done, recorded_by, recorded_at) values ($1,$2,$3,$4,$5,$6)`, [v.id, v.parent_id, s.observations, s.tasksDone, actor.userId, submittedAt]);
  for (const x of assessed) {
    await c.query(`insert into vital_readings (visit_id, parent_id, kind, value, out_of_range, critical, recorded_at, recorded_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      v.id, v.parent_id, x.kind, x.value, x.a.outOfRange, x.a.critical, new Date(x.recordedAt), actor.userId,
    ]);
  }
  for (const k of s.photoKeys) await c.query(`insert into visit_photos (visit_id, parent_id, storage_key) values ($1,$2,$3) on conflict (storage_key) do nothing`, [v.id, v.parent_id, k]);
  if (s.note.trim()) await c.query(`insert into visit_notes (visit_id, parent_id, note, author_id) values ($1,$2,$3,$4)`, [v.id, v.parent_id, s.note.trim(), actor.userId]);

  const staff = (await c.query(`select first_name, display_name from users where id=$1`, [v.staff_user_id ?? actor.userId])).rows[0];
  // The explicit check-out (possibly synced after the report) is authoritative; fall back to submission time.
  const checkedOutAt = v.checked_out_at ?? submittedAt;
  const tasksDone = (tpl?.def.tasks ?? []).filter((t) => s.tasksDone.includes(t.code));
  const input = {
    parentName: v.parent_name, staffName: staff?.first_name || staff?.display_name || '', visitType: v.type,
    checkedInAt: v.checked_in_at.toISOString(), checkedOutAt: new Date(checkedOutAt).toISOString(),
    observations: s.observations, vitals: s.vitals.map((x) => ({ kind: x.kind, value: x.value })), tasksDone, note: s.note, photoCount: s.photoKeys.length,
  };
  const day = v.checked_in_at.toISOString().slice(0, 10);
  const rep = templateVisitReportGenerator.generate(v.parent_id, { from: day, to: day }, input);
  await c.query(
    `insert into reports (type, parent_id, visit_id, period_start, period_end, generator, structured_input, structured_payload, rendered_ar, rendered_en) values ('visit',$1,$2,$3,$3,$4,$5,$6,$7,$8)`,
    [v.parent_id, v.id, day, rep.generator, input, rep.payload, rep.text_ar, rep.text_en],
  );
  await c.query(`update visits set status='completed', submitted_at=$2, synced_at=$3, offline_captured = offline_captured or $4, updated_at=$3 where id=$1`, [v.id, submittedAt, now, s.offline]);

  await notify(c, now, { type: 'visit_report_ready', parentId: v.parent_id, to: { family: v.family_id }, vars: { staff: input.staffName, parent: v.parent_name }, dedupeKey: `visit:${v.id}:report`, data: { visitId: v.id } });
  if (rep.payload.flags.outOfRangeVitals || rep.payload.flags.concerns.length) {
    await createTask(c, { kind: 'visit_follow_up', parentId: v.parent_id, title: `Review visit flags: ${[...(rep.payload.flags.outOfRangeVitals ? ['out-of-range vitals'] : []), ...rep.payload.flags.concerns].join(', ')}`, refType: 'visit', refId: v.id, dueAt: new Date(now.getTime() + 24 * 3_600_000), dedupeKey: `visit:${v.id}:flags` });
  }
  if (rep.payload.flags.criticalVitals) {
    await createEscalation(c, now, { parentId: v.parent_id, trigger: 'critical_vitals', severity: 'urgent', createdBy: actor.userId, note: rep.payload.vitals.filter((x) => x.critical).map((x) => `${x.kind}=${x.value}`).join(', '), sourceRef: `visit:${v.id}` });
  }
  await audit(c, { actorUserId: actor.userId, action: 'visit.report_submit', entityType: 'visit', entityId: v.id, parentId: v.parent_id, meta: { offline: s.offline } });
  await track(c, 'visit_report_submitted', actor.userId, v.parent_id, { delayS: Math.round((now.getTime() - submittedAt.getTime()) / 1000), offline: s.offline });
  return { status: 'completed' as const, flags: rep.payload.flags };
}

export async function confirmDose(c: Sql, now: Date, actor: Actor, p: { doseId: string; status: 'confirmed' | 'skipped'; capturedAt: string; method: string; note?: string }) {
  const dose = (await c.query(`select * from dose_events where id=$1 for update`, [p.doseId])).rows[0];
  if (!dose) throw notFound('dose_not_found');
  if (dose.status === 'confirmed' || dose.status === 'skipped') return { status: 'already' as const };
  if (p.status === 'skipped' && !p.note?.trim()) throw badRequest('skip_note_required');
  await c.query(`update dose_events set status=$2, confirmed_at=$3, confirmed_by=$4, method=$5, note=$6 where id=$1`, [p.doseId, p.status, new Date(p.capturedAt), actor.userId, p.method, p.note ?? null]);
  await c.query(`update tasks set status='done', done_at=$2, done_by=$3 where ref_type='dose' and ref_id=$1 and status='open'`, [p.doseId, now, actor.userId]);
  await audit(c, { actorUserId: actor.userId, action: 'dose.' + p.status, entityType: 'dose', entityId: p.doseId, parentId: dose.parent_id, meta: { method: p.method, late: dose.status === 'missed' } });
  return { status: p.status };
}

/**
 * Offline sync (§4.3). Ops are applied in order, each in its own transaction, and recorded by opId,
 * so a retried batch never double-applies. Conflicts (e.g. report already submitted from another device)
 * are reported per-op; the server copy wins and the client shows the conflict.
 */
export async function applySync(d: Deps, actor: Actor, ops: SyncOp[]) {
  const results: { opId: string; status: 'applied' | 'duplicate' | 'rejected' | 'conflict'; error?: string; details?: unknown }[] = [];
  for (const op of ops) {
    const prior = await d.db.as(actor, async (c) => (await c.query(`select status, result from sync_ops where op_id=$1`, [op.opId])).rows[0]);
    if (prior) { results.push({ opId: op.opId, status: 'duplicate' }); continue; }
    try {
      const now = d.clock.now();
      await d.db.as(actor, async (c) => {
        if (op.kind === 'check_in') await checkIn(c, now, actor, op.payload);
        else if (op.kind === 'check_out') await checkOut(c, now, actor, op.payload);
        else if (op.kind === 'report') await submitReport(d, c, now, actor, op.payload);
        else if (op.kind === 'dose_confirm') await confirmDose(c, now, actor, op.payload);
        await c.query(`insert into sync_ops (op_id, user_id, kind, status) values ($1,$2,$3,'applied')`, [op.opId, actor.userId, op.kind]);
      });
      results.push({ opId: op.opId, status: 'applied' });
    } catch (e: any) {
      const status = e instanceof AppError && e.status === 409 ? 'conflict' : 'rejected';
      const error = e instanceof AppError ? e.code : 'internal_error';
      if (!(e instanceof AppError)) {
        // Transient/unexpected: don't record, so the client retries the same op later.
        console.error('sync op failed', op.kind, e);
        results.push({ opId: op.opId, status: 'rejected', error: 'retry_later' });
        continue;
      }
      await d.db.as(actor, async (c) => {
        await c.query(`insert into sync_ops (op_id, user_id, kind, status, result) values ($1,$2,$3,$4,$5) on conflict do nothing`, [op.opId, actor.userId, op.kind, status, { error, details: e?.details ?? null }]);
        if (op.kind === 'check_in' && (error === 'outside_radius' || error === 'no_location')) {
          const pid = (await c.query(`select parent_id from visits where id=$1`, [op.payload.visitId])).rows[0]?.parent_id ?? null;
          await audit(c, { actorUserId: actor.userId, action: 'visit.check_in_blocked', entityType: 'visit', entityId: op.payload.visitId, parentId: pid, meta: { reason: error, ...(e.details ?? {}) } });
        }
      });
      results.push({ opId: op.opId, status, error, details: e?.details });
    }
  }
  return { results };
}
