import { canTransition, escalationTimerPlan, validateClose, type EscalationDecision, type EscalationSeverity, type EscalationStatus, type EscalationTrigger } from '@barr/shared';
import type { Sql } from '../db/pool';
import type { Deps } from '../deps';
import { enqueue } from '../jobs/queue';
import { AppError, badRequest, notFound } from '../lib/errors';
import { audit, track } from './audit';
import { createTask, notify } from './notifications';
import { getConfig } from './settings';

const triggerLabel: Record<EscalationTrigger, { en: string; ar: string }> = {
  family_help: { en: 'family asked for help', ar: 'طلب مساعدة من العائلة' },
  staff: { en: 'raised by staff', ar: 'من فريق العمل' },
  helpline_call: { en: 'call to the Barr line', ar: 'اتصال بخط بر' },
  critical_vitals: { en: 'critical vital signs', ar: 'مؤشرات حيوية حرجة' },
  caregiver_no_show: { en: 'caregiver did not arrive', ar: 'لم يحضر المرافق' },
};
export const statusLabel: Record<EscalationStatus, { en: string; ar: string }> = {
  open: { en: 'our on-call doctor is being contacted', ar: 'يتم التواصل مع الطبيب المناوب' },
  acknowledged: { en: 'a doctor is responding', ar: 'الطبيب يستجيب' },
  in_progress: { en: 'the team is handling it', ar: 'الفريق يتعامل مع الحالة' },
  closed: { en: 'closed', ar: 'مغلق' },
};
const decisionLabel: Record<EscalationDecision, { en: string; ar: string }> = {
  phone_advice: { en: 'the doctor gave advice by phone', ar: 'قدم الطبيب نصيحة بالهاتف' },
  nurse_dispatched: { en: 'a nurse is on the way to the home', ar: 'ممرض/ة في الطريق إلى المنزل' },
  ambulance_called: { en: 'an ambulance has been called', ar: 'تم طلب الإسعاف' },
  hospital_transfer: { en: 'transfer to hospital is being arranged', ar: 'يتم ترتيب النقل إلى المستشفى' },
};

const fmtCairo = (d: Date, lang: 'ar' | 'en') =>
  new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' }).format(d);

async function event(c: Sql, e: { escalationId: string; parentId: string; at: Date; kind: string; actor?: string | null; data?: object; visible?: boolean }) {
  await c.query(`insert into escalation_events (escalation_id, parent_id, at, kind, actor_user_id, data, visible_to_family) values ($1,$2,$3,$4,$5,$6,$7)`, [
    e.escalationId, e.parentId, e.at, e.kind, e.actor ?? null, e.data ?? {}, e.visible ?? true,
  ]);
}

/** On-call staff for a city at an instant (rota in dashboard). */
export async function onCall(c: Sql, cityId: string, tier: 'primary' | 'backup', at: Date): Promise<string[]> {
  return (await c.query(`select user_id from oncall_rota where city_id=$1 and tier=$2 and starts_at <= $3 and ends_at > $3`, [cityId, tier, at])).rows.map((r) => r.user_id);
}

/**
 * F8 step 1–2: create escalation, start response clock, page on-call doctor + pod coordinator,
 * and schedule the 2-minute acknowledge check and 15-minute family notification in the SAME transaction.
 */
export async function createEscalation(c: Sql, now: Date, a: { parentId: string; trigger: EscalationTrigger; severity: EscalationSeverity; createdBy: string | null; note?: string | null; sourceRef?: string | null }) {
  const p = (await c.query(`select p.id, p.name, p.family_id, p.city_id, p.pod_id, po.coordinator_user_id from parents p join pods po on po.id=p.pod_id where p.id=$1`, [a.parentId])).rows[0];
  if (!p) throw notFound('parent_not_found');
  // De-duplicate automatic triggers: one open escalation per parent+trigger+source.
  if (a.sourceRef) {
    const dup = (await c.query(`select id from escalations where parent_id=$1 and source_ref=$2 and status <> 'closed'`, [a.parentId, a.sourceRef])).rows[0];
    if (dup) return { id: dup.id as string, deduplicated: true };
  }
  const e = (await c.query(
    `insert into escalations (parent_id, city_id, pod_id, trigger, severity, created_by, note, source_ref, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [p.id, p.city_id, p.pod_id, a.trigger, a.severity, a.createdBy, a.note ?? null, a.sourceRef ?? null, now],
  )).rows[0];
  await event(c, { escalationId: e.id, parentId: p.id, at: now, kind: 'created', actor: a.createdBy, data: { trigger: a.trigger, severity: a.severity } });
  const cfg = await getConfig(c);
  for (const t of escalationTimerPlan(now, cfg)) {
    await enqueue(c, t.job, { escalationId: e.id }, { runAt: t.runAt, dedupeKey: `${t.job}:${e.id}`, maxAttempts: 10 });
  }
  const primary = await onCall(c, p.city_id, 'primary', now);
  const staffTo = [...new Set([...primary, p.coordinator_user_id].filter(Boolean))] as string[];
  await notify(c, now, {
    type: 'escalation_page_staff', parentId: p.id, to: { users: staffTo }, channels: ['push', 'whatsapp'],
    vars: { parent: p.name, trigger: triggerLabel[a.trigger] }, dedupeKey: `esc:${e.id}:page_primary`, data: { escalationId: e.id },
  });
  await event(c, { escalationId: e.id, parentId: p.id, at: now, kind: 'staff_paged', data: { tier: 'primary', users: staffTo.length }, visible: false });
  if (a.trigger === 'family_help') {
    // Immediate confirmation to the family counts as "family told" (it states what is being done).
    await notify(c, now, { type: 'escalation_created', parentId: p.id, to: { family: p.family_id }, vars: { parent: p.name }, dedupeKey: `esc:${e.id}:family_created` });
    await c.query(`update escalations set family_notified_at=$2 where id=$1`, [e.id, now]);
    await event(c, { escalationId: e.id, parentId: p.id, at: now, kind: 'family_notified', data: { reason: 'confirmation' } });
  }
  await audit(c, { actorUserId: a.createdBy, action: 'escalation.create', entityType: 'escalation', entityId: e.id, parentId: p.id, after: a });
  await track(c, 'escalation_created', a.createdBy, p.id, { trigger: a.trigger, severity: a.severity });
  return { id: e.id as string, deduplicated: false };
}

/** Job at +2 min (step 2–3): if not acknowledged → phone call to on-call doctor + page backup on-call. Idempotent. */
export async function escalationAckCheck(d: Deps, c: Sql, now: Date, escalationId: string) {
  const e = (await c.query(`select e.*, p.name from escalations e join parents p on p.id=e.parent_id where e.id=$1 for update of e`, [escalationId])).rows[0];
  if (!e || e.acknowledged_at || e.status === 'closed' || e.backup_paged_at) return;
  const primary = await onCall(c, e.city_id, 'primary', now);
  for (const uid of primary) {
    const u = (await c.query(`select phone_enc, language from users where id=$1`, [uid])).rows[0];
    const phone = d.crypto.decryptNullable(u?.phone_enc);
    if (phone) {
      const msg = u.language === 'en' ? `Urgent Barr escalation for ${e.name}. Open the Barr field app to acknowledge.` : `تصعيد عاجل من بر بخصوص ${e.name}. افتح تطبيق بر للاستجابة.`;
      const r = await d.calls.placeCall({ to: phone, message: msg, language: u.language });
      await event(c, { escalationId: e.id, parentId: e.parent_id, at: now, kind: 'call_placed', data: { status: r.status, ref: r.providerRef }, visible: false });
    }
  }
  const backup = await onCall(c, e.city_id, 'backup', now);
  await notify(c, now, {
    type: 'escalation_page_staff', parentId: e.parent_id, to: { users: backup }, channels: ['push', 'whatsapp', 'sms'],
    vars: { parent: e.name, trigger: triggerLabel[e.trigger as EscalationTrigger] }, dedupeKey: `esc:${e.id}:page_backup`, data: { escalationId: e.id },
  });
  await c.query(`update escalations set backup_paged_at=$2, call_placed_at=$2 where id=$1`, [e.id, now]);
  await event(c, { escalationId: e.id, parentId: e.parent_id, at: now, kind: 'backup_paged', data: { users: backup.length }, visible: false });
  if (backup.length === 0) {
    await createTask(c, { kind: 'escalation_no_backup', parentId: e.parent_id, title: 'Escalation not acknowledged and no backup on-call in rota', refType: 'escalation', refId: e.id, dueAt: now, dedupeKey: `esc:${e.id}:nobackup` });
  }
}

/** Job at +15 min (step 4): family must have been told. Idempotent. */
export async function escalationFamilyNotify(c: Sql, now: Date, escalationId: string) {
  const e = (await c.query(`select e.*, p.name, p.family_id from escalations e join parents p on p.id=e.parent_id where e.id=$1 for update of e`, [escalationId])).rows[0];
  if (!e || e.family_notified_at) return;
  await notify(c, now, {
    type: 'escalation_family_15min', parentId: e.parent_id, to: { family: e.family_id },
    vars: { parent: e.name, time: { en: fmtCairo(e.created_at, 'en'), ar: fmtCairo(e.created_at, 'ar') }, status: statusLabel[e.status as EscalationStatus] },
    dedupeKey: `esc:${e.id}:family_15`,
  });
  await c.query(`update escalations set family_notified_at=$2 where id=$1`, [e.id, now]);
  await event(c, { escalationId: e.id, parentId: e.parent_id, at: now, kind: 'family_notified', data: { reason: '15min' } });
}

async function load(c: Sql, id: string) {
  const e = (await c.query(`select e.*, p.name, p.family_id from escalations e join parents p on p.id=e.parent_id where e.id=$1 for update of e`, [id])).rows[0];
  if (!e) throw notFound('escalation_not_found');
  return e;
}

async function familyUpdate(c: Sql, now: Date, e: any, update: { en: string; ar: string }, key: string) {
  await notify(c, now, { type: 'escalation_update', parentId: e.parent_id, to: { family: e.family_id }, vars: { parent: e.name, update }, dedupeKey: `esc:${e.id}:${key}` });
  if (!e.family_notified_at) {
    await c.query(`update escalations set family_notified_at=$2 where id=$1`, [e.id, now]);
    await event(c, { escalationId: e.id, parentId: e.parent_id, at: now, kind: 'family_notified', data: { reason: key } });
  }
}

export async function acknowledge(c: Sql, now: Date, id: string, userId: string) {
  const e = await load(c, id);
  if (e.acknowledged_at) return { already: true };
  if (!canTransition(e.status, 'acknowledged')) throw new AppError(409, 'invalid_transition');
  await c.query(`update escalations set status='acknowledged', acknowledged_at=$2, acknowledged_by=$3 where id=$1`, [id, now, userId]);
  await event(c, { escalationId: id, parentId: e.parent_id, at: now, kind: 'acknowledged', actor: userId, data: { secondsToAck: Math.round((now.getTime() - e.created_at.getTime()) / 1000) } });
  await familyUpdate(c, now, e, statusLabel.acknowledged, 'ack');
  await audit(c, { actorUserId: userId, action: 'escalation.acknowledge', entityType: 'escalation', entityId: id, parentId: e.parent_id });
  return { already: false };
}

export async function recordDecision(c: Sql, now: Date, id: string, userId: string, decision: EscalationDecision, note?: string) {
  const e = await load(c, id);
  if (e.status === 'closed') throw new AppError(409, 'escalation_closed');
  if (!e.acknowledged_at) {
    await c.query(`update escalations set acknowledged_at=$2, acknowledged_by=$3 where id=$1`, [id, now, userId]);
    await event(c, { escalationId: id, parentId: e.parent_id, at: now, kind: 'acknowledged', actor: userId });
  }
  await c.query(`update escalations set status='in_progress', decision=$2, decision_by=$3, decision_at=$4 where id=$1`, [id, decision, userId, now]);
  await event(c, { escalationId: id, parentId: e.parent_id, at: now, kind: 'decision', actor: userId, data: { decision, note: note ?? null } });
  await familyUpdate(c, now, e, decisionLabel[decision], `decision:${decision}`);
  await audit(c, { actorUserId: userId, action: 'escalation.decision', entityType: 'escalation', entityId: id, parentId: e.parent_id, after: { decision, note } });
}

export async function addFollowUp(c: Sql, now: Date, id: string, userId: string, note: string, visibleToFamily: boolean) {
  const e = await load(c, id);
  if (e.status === 'closed') throw new AppError(409, 'escalation_closed');
  if (e.status === 'acknowledged') await c.query(`update escalations set status='in_progress' where id=$1`, [id]);
  await event(c, { escalationId: id, parentId: e.parent_id, at: now, kind: 'follow_up', actor: userId, data: { note }, visible: visibleToFamily });
}

export async function closeEscalation(c: Sql, now: Date, id: string, userId: string, note: string) {
  const err = validateClose(note);
  if (err) throw badRequest(err);
  const e = await load(c, id);
  if (e.status === 'closed') return;
  await c.query(`update escalations set status='closed', closed_at=$2, closed_by=$3, closing_note=$4 where id=$1`, [id, now, userId, note]);
  await event(c, { escalationId: id, parentId: e.parent_id, at: now, kind: 'closed', actor: userId, data: { note } });
  await familyUpdate(c, now, e, { en: `the alert is closed — ${note}`, ar: `تم إغلاق التنبيه — ${note}` }, 'closed');
  await audit(c, { actorUserId: userId, action: 'escalation.close', entityType: 'escalation', entityId: id, parentId: e.parent_id, after: { note } });
}

export async function escalationWithTimeline(c: Sql, id: string, forFamily: boolean) {
  const e = (await c.query(`select id, parent_id, trigger, severity, status, created_at, acknowledged_at, family_notified_at, decision, decision_at, closed_at, closing_note from escalations where id=$1`, [id])).rows[0];
  if (!e) throw notFound();
  const events = (await c.query(`select at, kind, data from escalation_events where escalation_id=$1 ${forFamily ? 'and visible_to_family' : ''} order by at`, [id])).rows;
  return { ...e, events };
}
