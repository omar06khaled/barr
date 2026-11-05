import {
  addDays, dosesForDate, groupRoute, isNoShow, localParts, missedDoseStage, planVisits, translate, churnRisk, zonedTimeToUtc, type VisitRule,
} from '@barr/shared';
import type { Sql } from '../db/pool';
import { enqueue } from '../jobs/queue';
import { createTask, notify } from './notifications';
import { getConfig } from './settings';
import { createEscalation } from './escalations';
import { dailyStatus } from './timeline';
import { ensureAssignment } from './visits';

const fmt = (d: Date, lang: 'ar' | 'en') => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' }).format(d);
const both = (key: string) => ({ en: translate('en', key), ar: translate('ar', key) });

/** Schedule per-visit reminder (−60 min) and no-show check (+grace). Keys include the time, so reschedules get fresh jobs. */
export async function scheduleVisitJobs(c: Sql, visitId: string, scheduledAt: Date, graceMin: number) {
  const iso = scheduledAt.toISOString();
  await enqueue(c, 'visit.reminder', { visitId, scheduledAt: iso }, { runAt: new Date(scheduledAt.getTime() - 3_600_000), dedupeKey: `visit.reminder:${visitId}:${iso}` });
  await enqueue(c, 'visit.no_show_check', { visitId, scheduledAt: iso }, { runAt: new Date(scheduledAt.getTime() + graceMin * 60_000), dedupeKey: `visit.no_show:${visitId}:${iso}` });
}

/** §10 Visit generation for one parent: next 14 days from the published care plan. Idempotent via rule_key. */
export async function generateVisitsForParent(c: Sql, now: Date, parentId: string) {
  const cfg = await getConfig(c);
  const plan = (await c.query(`select id, content from care_plans where parent_id=$1 and status='published' order by version desc limit 1`, [parentId])).rows[0];
  if (!plan) return 0;
  const p = (await c.query(`select id, city_id, pod_id, status from parents where id=$1`, [parentId])).rows[0];
  if (!p || p.status !== 'active') return 0;
  const rules: (VisitRule & { staffUserId?: string | null })[] = plan.content.visitRules ?? [];
  const today = localParts(now, cfg.timezone).date;
  const planned = planVisits(rules, today, 14, cfg.timezone).filter((v) => v.scheduledAt > now);
  // Cancel future, unstarted visits from older plan versions.
  await c.query(`update visits set status='cancelled', updated_at=$3 where parent_id=$1 and source='care_plan' and care_plan_id <> $2 and status='scheduled' and scheduled_at > $3`, [parentId, plan.id, now]);
  let created = 0;
  for (const v of planned) {
    const rule = rules[v.ruleIndex]!;
    let staff = rule.staffUserId ?? null;
    if (staff) {
      const ok = (await c.query(`select staff_is_verified($1) ok`, [staff])).rows[0].ok;
      if (!ok) staff = null; // F4: leave unassigned; dashboard will show it.
    }
    const key = `${plan.id}:${v.ruleIndex}:${v.scheduledAt.toISOString()}`;
    const r = await c.query(
      `insert into visits (parent_id, city_id, pod_id, type, staff_user_id, scheduled_at, duration_min, source, care_plan_id, rule_key)
       values ($1,$2,$3,$4,$5,$6,$7,'care_plan',$8,$9) on conflict (parent_id, rule_key) where rule_key is not null do nothing returning id`,
      [parentId, p.city_id, p.pod_id, v.type, staff, v.scheduledAt, v.durationMin, plan.id, key],
    );
    if (r.rows[0]) {
      created++;
      if (staff) await ensureAssignment(c, parentId, staff);
      await scheduleVisitJobs(c, r.rows[0].id, v.scheduledAt, cfg.noShowGraceMin);
    }
  }
  return created;
}

export async function fanOut(c: Sql, now: Date, job: string, sql: string, params: unknown[], keyPrefix: string, extra: Record<string, unknown> = {}) {
  const ids = (await c.query(sql, params)).rows.map((r) => r.id);
  for (const id of ids) await enqueue(c, job, { parentId: id, ...extra }, { runAt: now, dedupeKey: `${keyPrefix}:${id}` });
  return ids.length;
}

export async function visitReminder(c: Sql, now: Date, visitId: string, scheduledAtIso: string) {
  const v = (await c.query(`select v.*, p.name from visits v join parents p on p.id=v.parent_id where v.id=$1`, [visitId])).rows[0];
  if (!v || v.status !== 'scheduled' || v.scheduled_at.toISOString() !== scheduledAtIso || !v.staff_user_id) return;
  await notify(c, now, { type: 'visit_reminder', parentId: v.parent_id, to: { users: [v.staff_user_id] }, channels: ['push'], vars: { visitType: both(`visitType.${v.type}`), parent: v.name, time: { en: fmt(v.scheduled_at, 'en'), ar: fmt(v.scheduled_at, 'ar') } }, dedupeKey: `visit:${visitId}:reminder:${scheduledAtIso}` });
}

/** §10 No-show: task to coordinator; caregiver shift no-show also escalates (F8 automatic trigger). */
export async function noShowCheck(c: Sql, now: Date, visitId: string, scheduledAtIso: string) {
  const cfg = await getConfig(c);
  const v = (await c.query(`select v.*, p.name, p.family_id from visits v join parents p on p.id=v.parent_id where v.id=$1 for update of v`, [visitId])).rows[0];
  if (!v || v.scheduled_at.toISOString() !== scheduledAtIso || !isNoShow({ status: v.status, scheduledAt: v.scheduled_at }, now, cfg.noShowGraceMin) || v.no_show_flagged_at) return;
  await c.query(`update visits set no_show_flagged_at=$2 where id=$1`, [visitId, now]);
  await createTask(c, { kind: 'no_show', parentId: v.parent_id, title: `No-show: ${v.type} for ${v.name} at ${fmt(v.scheduled_at, 'en')}`, refType: 'visit', refId: v.id, dueAt: new Date(now.getTime() + cfg.noShowFamilyMin * 60_000), dedupeKey: `noshow:${v.id}:${scheduledAtIso}` });
  if (v.type === 'caregiver_shift') {
    await createEscalation(c, now, { parentId: v.parent_id, trigger: 'caregiver_no_show', severity: 'urgent', createdBy: null, sourceRef: `visit:${v.id}` });
  }
  await enqueue(c, 'visit.no_show_family', { visitId, scheduledAt: scheduledAtIso }, { runAt: new Date(now.getTime() + cfg.noShowFamilyMin * 60_000), dedupeKey: `visit.no_show_family:${visitId}:${scheduledAtIso}` });
}

export async function noShowFamily(c: Sql, now: Date, visitId: string, scheduledAtIso: string) {
  const v = (await c.query(`select v.*, p.name, p.family_id from visits v join parents p on p.id=v.parent_id where v.id=$1`, [visitId])).rows[0];
  if (!v || v.checked_in_at || v.status !== 'scheduled' || v.scheduled_at.toISOString() !== scheduledAtIso) return;
  await notify(c, now, { type: 'no_show', parentId: v.parent_id, to: { family: v.family_id }, vars: { visitType: both(`visitType.${v.type}`), parent: v.name, time: { en: fmt(v.scheduled_at, 'en'), ar: fmt(v.scheduled_at, 'ar') } }, dedupeKey: `visit:${visitId}:noshow_family` });
}

/** §10 Dose generation for one parent and date; schedules missed-dose checks. */
export async function generateDosesForParent(c: Sql, parentId: string, date: string) {
  const cfg = await getConfig(c);
  const p = (await c.query(`select city_id, pod_id from parents where id=$1`, [parentId])).rows[0];
  if (!p) return 0;
  const meds = (await c.query(`select id, times_of_day, to_char(start_date,'YYYY-MM-DD') start_date, to_char(end_date,'YYYY-MM-DD') end_date, active from medications where parent_id=$1 and active`, [parentId])).rows;
  let n = 0;
  for (const m of meds) {
    for (const dose of dosesForDate({ id: m.id, timesOfDay: m.times_of_day, startDate: m.start_date, endDate: m.end_date, active: m.active }, date, cfg.timezone)) {
      const r = await c.query(
        `insert into dose_events (medication_id, parent_id, city_id, pod_id, scheduled_at) values ($1,$2,$3,$4,$5) on conflict (medication_id, scheduled_at) do nothing returning id`,
        [m.id, parentId, p.city_id, p.pod_id, dose.scheduledAt],
      );
      const id = r.rows[0]?.id;
      if (id) {
        n++;
        await enqueue(c, 'dose.missed_check', { doseId: id }, { runAt: new Date(dose.scheduledAt.getTime() + cfg.missedDoseAlertMin * 60_000), dedupeKey: `dose.missed:${id}` });
        await enqueue(c, 'dose.family_check', { doseId: id }, { runAt: new Date(dose.scheduledAt.getTime() + cfg.missedDoseFamilyMin * 60_000), dedupeKey: `dose.family:${id}` });
      }
    }
  }
  return n;
}

/** F7: not confirmed within 60 min → mark missed + coordinator alert (task + push). */
export async function doseMissedCheck(c: Sql, now: Date, doseId: string) {
  const cfg = await getConfig(c);
  const d = (await c.query(`select de.*, m.name med, p.name parent, po.coordinator_user_id from dose_events de join medications m on m.id=de.medication_id join parents p on p.id=de.parent_id join pods po on po.id=p.pod_id where de.id=$1 for update of de`, [doseId])).rows[0];
  if (!d || d.coordinator_alerted_at) return;
  if (missedDoseStage({ status: d.status, scheduledAt: d.scheduled_at }, now, cfg) === 'none') return;
  await c.query(`update dose_events set status='missed', coordinator_alerted_at=$2 where id=$1`, [doseId, now]);
  await createTask(c, { kind: 'missed_dose', parentId: d.parent_id, title: `Missed dose: ${d.med} for ${d.parent} at ${fmt(d.scheduled_at, 'en')}`, refType: 'dose', refId: doseId, dueAt: new Date(d.scheduled_at.getTime() + cfg.missedDoseFamilyMin * 60_000), dedupeKey: `dose:${doseId}:missed` });
  if (d.coordinator_user_id) {
    await notify(c, now, { type: 'missed_dose', parentId: d.parent_id, to: { users: [d.coordinator_user_id] }, channels: ['push'], vars: { parent: d.parent, medicine: d.med, time: { en: fmt(d.scheduled_at, 'en'), ar: fmt(d.scheduled_at, 'ar') } }, dedupeKey: `dose:${doseId}:coord` });
  }
}

/** F7: still unresolved after 3 h → notify family. */
export async function doseFamilyCheck(c: Sql, now: Date, doseId: string) {
  const cfg = await getConfig(c);
  const d = (await c.query(`select de.*, m.name med, p.name parent, p.family_id from dose_events de join medications m on m.id=de.medication_id join parents p on p.id=de.parent_id where de.id=$1 for update of de`, [doseId])).rows[0];
  if (!d || d.family_notified_at) return;
  if (missedDoseStage({ status: d.status, scheduledAt: d.scheduled_at }, now, cfg) !== 'notify_family') return;
  await c.query(`update dose_events set status='missed', family_notified_at=$2 where id=$1`, [doseId, now]);
  await notify(c, now, { type: 'missed_dose', parentId: d.parent_id, to: { family: d.family_id }, vars: { parent: d.parent, medicine: d.med, time: { en: fmt(d.scheduled_at, 'en'), ar: fmt(d.scheduled_at, 'ar') } }, dedupeKey: `dose:${doseId}:family` });
}

/** F3 daily status + summary (18:00). Amber creates a coordinator task. */
export async function dailyStatusForParent(c: Sql, now: Date, parentId: string) {
  const cfg = await getConfig(c);
  const date = localParts(now, cfg.timezone).date;
  const p = (await c.query(`select id, name, family_id from parents where id=$1`, [parentId])).rows[0];
  if (!p) return;
  const s = await dailyStatus(c, parentId, now);
  if (s.status === 'no_contact') {
    await createTask(c, { kind: 'no_contact', parentId, title: `No contact today with ${p.name}`, dueAt: new Date(now.getTime() + 2 * 3_600_000), dedupeKey: `nocontact:${parentId}:${date}` });
  }
  await notify(c, now, { type: 'daily_status', parentId, to: { family: p.family_id }, vars: { parent: p.name, status: both(`status.${s.status}`) }, dedupeKey: `daily:${parentId}:${date}` });
}

/** F11 continuous: mark overdue and notify owner + admins once. */
export async function concernDeadlines(c: Sql, now: Date) {
  const rows = (await c.query(`select id, ref, parent_id, owner_user_id from concerns where status <> 'resolved' and deadline < $1 and overdue_notified_at is null for update skip locked`, [now])).rows;
  const admins = (await c.query(`select user_id from staff where role='admin' and active`)).rows.map((r) => r.user_id);
  for (const r of rows) {
    await c.query(`update concerns set overdue_notified_at=$2 where id=$1`, [r.id, now]);
    await createTask(c, { kind: 'concern_overdue', parentId: r.parent_id, assigneeUserId: r.owner_user_id, title: `Concern ${r.ref} is overdue`, refType: 'concern', refId: r.id, dueAt: now, dedupeKey: `concern:${r.id}:overdue` });
    await notify(c, now, { type: 'concern_update', parentId: r.parent_id, to: { users: [...new Set([r.owner_user_id, ...admins].filter(Boolean))] }, channels: ['push'], vars: { ref: r.ref, status: { en: 'OVERDUE', ar: 'متأخرة' } }, dedupeKey: `concern:${r.id}:overdue` });
  }
  return rows.length;
}

/** §10 Daily routes 06:00: group each staff member's visits by neighbourhood and push. */
export async function dailyRoutes(c: Sql, now: Date, date: string) {
  const cfg = await getConfig(c);
  const from = zonedTimeToUtc(date, '00:00', cfg.timezone), to = zonedTimeToUtc(addDays(date, 1), '00:00', cfg.timezone);
  const rows = (await c.query(`select v.id, v.staff_user_id, v.scheduled_at, p.neighborhood from visits v join parents p on p.id=v.parent_id where v.scheduled_at >= $1 and v.scheduled_at < $2 and v.status='scheduled' and v.staff_user_id is not null`, [from, to])).rows;
  const byStaff = new Map<string, typeof rows>();
  for (const r of rows) byStaff.set(r.staff_user_id, [...(byStaff.get(r.staff_user_id) ?? []), r]);
  for (const [staff, vs] of byStaff) {
    const groups = groupRoute(vs.map((v) => ({ ...v, neighborhood: v.neighborhood || '—', scheduledAt: v.scheduled_at })));
    await notify(c, now, { type: 'daily_route', to: { users: [staff] }, channels: ['push'], vars: { count: vs.length, areas: groups.map((g) => g.neighborhood).join(', ') }, dedupeKey: `route:${staff}:${date}` });
  }
  return byStaff.size;
}

/** §10 churn-risk flags (daily). */
export async function churnFlags(c: Sql, now: Date) {
  const since30 = new Date(now.getTime() - 30 * 86_400_000), since14 = new Date(now.getTime() - 14 * 86_400_000);
  const rows = (await c.query(
    `select p.id,
       (select count(*) from visits v where v.parent_id=p.id and v.no_show_flagged_at > $1)::int missed,
       (select count(*) from concerns cn where cn.parent_id=p.id and cn.status <> 'resolved' and cn.deadline < $3)::int overdue,
       (select count(*) from payments py where py.parent_id=p.id and py.status='failed' and py.created_at > $1)::int failed,
       (select count(*) from analytics_events ae where ae.parent_id=p.id and ae.name in ('timeline_opened','whatsapp_report_opened') and ae.at > $2)::int opens
     from parents p where p.status in ('active','paused') and p.deleted_at is null`, [since30, since14, now])).rows;
  for (const r of rows) {
    const f = churnRisk({ missedVisits30d: r.missed, overdueConcerns: r.overdue, failedPayments: r.failed, appOpens14d: r.opens });
    await c.query(`insert into parent_flags (parent_id, churn_risk, reasons, computed_at) values ($1,$2,$3,$4) on conflict (parent_id) do update set churn_risk=excluded.churn_risk, reasons=excluded.reasons, computed_at=excluded.computed_at`, [r.id, f.flagged, f.reasons, now]);
  }
  return rows.length;
}
