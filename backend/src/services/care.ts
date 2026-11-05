import { CONCERN_CATEGORIES, canReopen, concernDeadline, concernReference, isSafetyConcern, type ConcernCategory, type VisitRule } from '@barr/shared';
import type { Actor, Sql } from '../db/pool';
import { enqueue } from '../jobs/queue';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { audit, track } from './audit';
import { createTask, notify } from './notifications';
import { getConfig } from './settings';
import { notifySiblings } from './families';

// ── F10 care plans ─────────────────────────────────────────────────────────
export interface CarePlanContent {
  visitRules: (VisitRule & { staffUserId?: string | null })[];
  goals: { en: string; ar: string }[];
  included: { en: string; ar: string }[];
  notIncluded: { en: string; ar: string }[];
  carerPreferences: { gender: 'female' | 'male' | 'any'; languages: string[]; notes?: string };
  medicinesSummary?: string[];
}

/** Publishing creates a NEW version (previous → superseded) that every family member must re-accept. */
export async function publishCarePlan(c: Sql, now: Date, actor: Actor, parentId: string, content: CarePlanContent) {
  const p = (await c.query(`select id, name, family_id, status from parents where id=$1`, [parentId])).rows[0];
  if (!p) throw notFound();
  if (!content.visitRules || !Array.isArray(content.visitRules)) throw badRequest('visit_rules_required');
  const v = (await c.query(`select coalesce(max(version),0)+1 v from care_plans where parent_id=$1`, [parentId])).rows[0].v;
  await c.query(`update care_plans set status='superseded' where parent_id=$1 and status='published'`, [parentId]);
  const cp = (await c.query(`insert into care_plans (parent_id, version, status, content, published_by, published_at) values ($1,$2,'published',$3,$4,$5) returning id`, [parentId, v, content, actor.userId, now])).rows[0];
  await audit(c, { actorUserId: actor.userId, action: 'care_plan.publish', entityType: 'care_plan', entityId: cp.id, parentId, after: { version: v } });
  await notify(c, now, { type: 'plan_changed_by_sibling', parentId, to: { family: p.family_id }, vars: { actor: { en: 'Your coordinator', ar: 'المنسق' }, change: { en: `published care plan version ${v} for ${p.name}. Please review and accept it in the app`, ar: `نشر خطة الرعاية رقم ${v} لـ ${p.name}. يرجى مراجعتها وقبولها في التطبيق` } }, dedupeKey: `careplan:${cp.id}:published` });
  await enqueue(c, 'visits.generate_parent', { parentId }, { runAt: now, dedupeKey: `visits.gen:${parentId}:${cp.id}` });
  return { id: cp.id as string, version: v as number };
}

export async function acceptCarePlan(c: Sql, now: Date, actor: Actor, carePlanId: string) {
  const cp = (await c.query(`select cp.*, p.family_id from care_plans cp join parents p on p.id=cp.parent_id where cp.id=$1`, [carePlanId])).rows[0];
  if (!cp) throw notFound();
  if (cp.status !== 'published') throw new AppError(409, 'not_current_version');
  const member = await c.query(`select 1 from family_members where family_id=$1 and user_id=$2 and removed_at is null`, [cp.family_id, actor.userId]);
  if (!member.rowCount) throw forbidden('not_family_member');
  await c.query(`insert into agreement_acceptances (care_plan_id, parent_id, version, user_id, accepted_at) values ($1,$2,$3,$4,$5) on conflict do nothing`, [carePlanId, cp.parent_id, cp.version, actor.userId, now]);
  await audit(c, { actorUserId: actor.userId, action: 'care_plan.accept', entityType: 'care_plan', entityId: carePlanId, parentId: cp.parent_id, after: { version: cp.version } });
}

export async function carePlans(c: Sql, parentId: string) {
  const plans = (await c.query(`select id, version, status, content, published_at from care_plans where parent_id=$1 order by version desc`, [parentId])).rows;
  const acc = (await c.query(`select a.care_plan_id, a.user_id, a.accepted_at, u.first_name from agreement_acceptances a join users u on u.id=a.user_id where a.parent_id=$1`, [parentId])).rows;
  return plans.map((p) => ({ ...p, acceptances: acc.filter((a) => a.care_plan_id === p.id) }));
}

// ── F11 concerns ───────────────────────────────────────────────────────────
export async function raiseConcern(c: Sql, now: Date, actor: Actor, a: { parentId: string; category: ConcernCategory; urgency: 'urgent' | 'normal'; text: string; photoKey?: string }) {
  if (!CONCERN_CATEGORIES.includes(a.category)) throw badRequest('invalid_category');
  const p = (await c.query(`select p.id, p.family_id, p.city_id, p.pod_id, p.name, po.coordinator_user_id from parents p join pods po on po.id=p.pod_id where p.id=$1`, [a.parentId])).rows[0];
  if (!p) throw notFound();
  const cfg = await getConfig(c);
  const safety = isSafetyConcern(a.category);
  const deadline = concernDeadline(now, a.urgency, safety, cfg);
  const seq = (await c.query(`select nextval('concern_seq') n`)).rows[0].n;
  const ref = concernReference(now, seq);
  const owner = p.coordinator_user_id;
  const r = (await c.query(
    `insert into concerns (ref, parent_id, family_id, city_id, pod_id, raised_by, category, urgency, safety_flag, text, photo_key, owner_user_id, deadline, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [ref, p.id, p.family_id, p.city_id, p.pod_id, actor.userId, a.category, a.urgency, safety, a.text, a.photoKey ?? null, owner, deadline, now],
  )).rows[0];
  await createTask(c, { kind: safety ? 'concern_safety' : 'concern', parentId: p.id, assigneeUserId: owner, title: `Concern ${ref} (${a.category})`, refType: 'concern', refId: r.id, dueAt: deadline, dedupeKey: `concern:${r.id}` });
  if (safety) {
    const admins = (await c.query(`select user_id from staff where role='admin' and active`)).rows.map((x) => x.user_id);
    await notify(c, now, { type: 'concern_update', parentId: p.id, to: { users: admins }, channels: ['push', 'whatsapp'], vars: { ref, status: { en: 'SAFETY concern raised — review now', ar: 'ملاحظة تتعلق بالسلامة — راجعها الآن' } }, dedupeKey: `concern:${r.id}:safety` });
  }
  await notifySiblings(c, now, p.family_id, actor.userId, { en: `raised concern ${ref} about ${p.name}`, ar: `أرسل ملاحظة ${ref} بخصوص ${p.name}` }, `concern:${r.id}:siblings`, p.id);
  await audit(c, { actorUserId: actor.userId, action: 'concern.raise', entityType: 'concern', entityId: r.id, parentId: p.id, meta: { safety } });
  await track(c, 'concern_raised', actor.userId, p.id, { category: a.category, safety });
  return { id: r.id as string, ref, deadline, safety };
}

export async function updateConcern(c: Sql, now: Date, actor: Actor, id: string, a: { status: 'in_progress' | 'resolved'; resolution?: string; ownerUserId?: string }) {
  const cn = (await c.query(`select * from concerns where id=$1 for update`, [id])).rows[0];
  if (!cn) throw notFound();
  if (a.status === 'resolved' && !a.resolution?.trim()) throw badRequest('resolution_note_required');
  await c.query(
    `update concerns set status=$2, resolution=coalesce($3, resolution), resolved_at=case when $2='resolved' then $4::timestamptz else null end,
       first_reply_at=coalesce(first_reply_at, $4), owner_user_id=coalesce($5, owner_user_id), updated_at=$4 where id=$1`,
    [id, a.status, a.resolution ?? null, now, a.ownerUserId ?? null],
  );
  if (a.status === 'resolved') await c.query(`update tasks set status='done', done_at=$2, done_by=$3 where ref_type='concern' and ref_id=$1 and status='open'`, [id, now, actor.userId]);
  await notify(c, now, { type: 'concern_update', parentId: cn.parent_id, to: { family: cn.family_id }, vars: { ref: cn.ref, status: a.status === 'resolved' ? { en: 'Resolved', ar: 'تم الحل' } : { en: 'In progress', ar: 'قيد المتابعة' } }, dedupeKey: `concern:${id}:${a.status}:${now.getTime()}` });
  await audit(c, { actorUserId: actor.userId, action: 'concern.update', entityType: 'concern', entityId: id, parentId: cn.parent_id, before: { status: cn.status }, after: a });
}

export async function reopenConcern(c: Sql, now: Date, actor: Actor, id: string, reason: string) {
  const cn = (await c.query(`select * from concerns where id=$1 for update`, [id])).rows[0];
  if (!cn) throw notFound();
  const cfg = await getConfig(c);
  if (!canReopen({ status: cn.status, resolvedAt: cn.resolved_at }, now, cfg.concernReopenDays)) throw new AppError(409, 'reopen_window_closed');
  const deadline = concernDeadline(now, cn.urgency, cn.safety_flag, cfg);
  await c.query(`update concerns set status='open', resolved_at=null, reopened_count=reopened_count+1, deadline=$2, overdue_notified_at=null, updated_at=$3 where id=$1`, [id, deadline, now]);
  await createTask(c, { kind: 'concern_reopened', parentId: cn.parent_id, assigneeUserId: cn.owner_user_id, title: `Concern ${cn.ref} reopened: ${reason}`, refType: 'concern', refId: id, dueAt: deadline, dedupeKey: `concern:${id}:reopen:${cn.reopened_count + 1}` });
  await audit(c, { actorUserId: actor.userId, action: 'concern.reopen', entityType: 'concern', entityId: id, parentId: cn.parent_id, meta: { reason } });
}

// ── F13 continuity ─────────────────────────────────────────────────────────
export async function careTeamHistory(c: Sql, parentId: string) {
  return (await c.query(
    `select sa.user_id, u.first_name, u.photo_key, sa.role, sa.started_at, sa.ended_at,
       (select count(*) from visits v where v.parent_id=sa.parent_id and v.staff_user_id=sa.user_id and v.status='completed')::int visits
     from staff_assignments sa join users u on u.id=sa.user_id where sa.parent_id=$1 order by sa.ended_at nulls first, sa.started_at desc`, [parentId])).rows;
}

export async function requestReplacement(c: Sql, now: Date, actor: Actor, a: { parentId: string; staffUserId?: string | null; reason: string }) {
  const p = (await c.query(`select id, family_id, city_id, pod_id, name from parents where id=$1`, [a.parentId])).rows[0];
  if (!p) throw notFound();
  const cfg = await getConfig(c);
  const target = new Date(now.getTime() + cfg.replacementTargetH * 3_600_000);
  const r = (await c.query(`insert into replacement_requests (parent_id, city_id, pod_id, requested_by, staff_user_id, reason, target_at, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [
    p.id, p.city_id, p.pod_id, actor.userId, a.staffUserId ?? null, a.reason, target, now])).rows[0];
  await createTask(c, { kind: 'replacement', parentId: p.id, title: `Replacement requested for ${p.name}: ${a.reason}`, refType: 'replacement', refId: r.id, dueAt: target, dedupeKey: `replacement:${r.id}` });
  await notifySiblings(c, now, p.family_id, actor.userId, { en: `requested a carer replacement for ${p.name}`, ar: `طلب استبدال مقدم الرعاية لـ ${p.name}` }, `replacement:${r.id}`, p.id);
  await audit(c, { actorUserId: actor.userId, action: 'replacement.request', entityType: 'replacement', entityId: r.id, parentId: p.id, meta: { reason: a.reason } });
  await track(c, 'replacement_requested', actor.userId, p.id);
  return { id: r.id as string, targetAt: target };
}

/** Resolve a replacement: end the old assignment, start the new one; time-to-replace is (resolved_at − created_at). */
export async function resolveReplacement(c: Sql, now: Date, actor: Actor, id: string, newStaffUserId: string) {
  const r = (await c.query(`select * from replacement_requests where id=$1 for update`, [id])).rows[0];
  if (!r || r.resolved_at) throw notFound();
  const verified = (await c.query(`select staff_is_verified($1) ok`, [newStaffUserId])).rows[0].ok;
  if (!verified) throw new AppError(422, 'staff_not_verified');
  if (r.staff_user_id) {
    await c.query(`update staff_assignments set ended_at=$3, end_reason='replaced' where parent_id=$1 and user_id=$2 and ended_at is null`, [r.parent_id, r.staff_user_id, now]);
    await c.query(`update visits set staff_user_id=$3 where parent_id=$1 and staff_user_id=$2 and status='scheduled' and scheduled_at > $4`, [r.parent_id, r.staff_user_id, newStaffUserId, now]);
  }
  await c.query(`insert into staff_assignments (parent_id, user_id, role) select $1,$2,role from staff where user_id=$2`, [r.parent_id, newStaffUserId]);
  await c.query(`update replacement_requests set resolved_at=$2, new_staff_user_id=$3 where id=$1`, [id, now, newStaffUserId]);
  await c.query(`update tasks set status='done', done_at=$2, done_by=$3 where ref_type='replacement' and ref_id=$1`, [id, now, actor.userId]);
  await audit(c, { actorUserId: actor.userId, action: 'replacement.resolve', entityType: 'replacement', entityId: id, parentId: r.parent_id, after: { newStaffUserId } });
}

// ── F12 chat ───────────────────────────────────────────────────────────────
export async function postMessage(c: Sql, now: Date, actor: Actor, a: { parentId: string; kind: 'text' | 'photo' | 'voice'; body: string; mediaKey?: string; clientId?: string }) {
  const t = (await c.query(`select id from chat_threads where parent_id=$1`, [a.parentId])).rows[0] ?? (await c.query(`insert into chat_threads (parent_id) values ($1) returning id`, [a.parentId])).rows[0];
  const m = (await c.query(
    `insert into chat_messages (thread_id, parent_id, sender_id, kind, body, media_key, client_id, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (client_id) do update set client_id = excluded.client_id returning id, created_at`,
    [t.id, a.parentId, actor.userId, a.kind, a.body, a.mediaKey ?? null, a.clientId ?? null, now],
  )).rows[0];
  await c.query(`insert into chat_reads (thread_id, user_id, last_read_at) values ($1,$2,$3) on conflict (thread_id, user_id) do update set last_read_at=excluded.last_read_at`, [t.id, actor.userId, now]);
  if (actor.roles.includes('family')) await track(c, 'chat_family_message', actor.userId, a.parentId);
  else await track(c, 'chat_staff_message', actor.userId, a.parentId);
  return m;
}

export async function messages(c: Sql, actor: Actor, parentId: string, before: Date | null, limit: number) {
  const t = (await c.query(`select id from chat_threads where parent_id=$1`, [parentId])).rows[0];
  if (!t) return { items: [] };
  const items = (await c.query(
    `select m.id, m.sender_id, u.first_name sender_name, m.kind, m.body, m.media_key, m.created_at from chat_messages m join users u on u.id=m.sender_id
     where m.thread_id=$1 and m.created_at < $2 order by m.created_at desc limit $3`, [t.id, before ?? new Date('9999-01-01'), limit])).rows;
  await c.query(`insert into chat_reads (thread_id, user_id, last_read_at) values ($1,$2,now()) on conflict (thread_id, user_id) do update set last_read_at=excluded.last_read_at`, [t.id, actor.userId]);
  return { items };
}

/** Coordinator view: unread counts per family thread. */
export async function unreadCounts(c: Sql, userId: string) {
  return (await c.query(
    `select t.parent_id, p.name, count(m.id)::int unread, max(m.created_at) last_at
     from chat_threads t join parents p on p.id=t.parent_id
     left join chat_reads r on r.thread_id=t.id and r.user_id=$1
     left join chat_messages m on m.thread_id=t.id and m.sender_id <> $1 and m.created_at > coalesce(r.last_read_at, 'epoch')
     group by t.parent_id, p.name order by unread desc, last_at desc nulls last limit 200`, [userId])).rows;
}
