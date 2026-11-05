import { computeDailyStatus, localParts, zonedTimeToUtc, addDays, type DailyStatusCode } from '@barr/shared';
import type { Sql } from '../db/pool';
import type { Deps } from '../deps';
import { decodeCursor, encodeCursor } from '../http';
import { getConfig } from './settings';

export type TimelineFilter = 'all' | 'visits' | 'medicines' | 'alerts' | 'concerns';

/**
 * F2 timeline: reverse-chronological, keyset-paginated union of visits (completed reports),
 * dose events, escalations and concerns. Indexed on (parent_id, time desc) per source.
 */
export async function timeline(d: Deps, c: Sql, parentId: string, filter: TimelineFilter, cursor: string | undefined, limit: number, lang: 'ar' | 'en') {
  const cur = decodeCursor(cursor);
  const at = cur?.at ?? new Date('9999-01-01');
  const id = cur?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const parts: string[] = [];
  if (filter === 'all' || filter === 'visits')
    parts.push(`select 'visit' kind, v.id, coalesce(v.checked_in_at, v.scheduled_at) at from visits v where v.parent_id=$1 and v.status in ('completed','missed')`);
  if (filter === 'all' || filter === 'medicines')
    parts.push(`select 'dose' kind, de.id, de.scheduled_at at from dose_events de where de.parent_id=$1 and de.status <> 'scheduled'`);
  if (filter === 'all' || filter === 'alerts')
    parts.push(`select 'escalation' kind, e.id, e.created_at at from escalations e where e.parent_id=$1`);
  if (filter === 'all' || filter === 'concerns')
    parts.push(`select 'concern' kind, cn.id, cn.created_at at from concerns cn where cn.parent_id=$1`);
  const rows = (await c.query(
    `select * from (${parts.join(' union all ')}) t where (t.at, t.id) < ($2, $3::uuid) order by t.at desc, t.id desc limit $4`,
    [parentId, at, id, limit + 1],
  )).rows;
  const page = rows.slice(0, limit);
  const items = [];
  for (const r of page) items.push(await hydrate(d, c, r.kind, r.id, lang));
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.at, last.id) : null };
}

async function hydrate(d: Deps, c: Sql, kind: string, id: string, lang: 'ar' | 'en') {
  const cfg = await getConfig(c);
  if (kind === 'visit') {
    const v = (await c.query(
      `select v.id, v.type, v.status, v.scheduled_at, v.checked_in_at, coalesce(v.checked_out_at, v.submitted_at) checked_out_at, v.offline_captured, v.staff_user_id,
              u.first_name staff_name, u.photo_key staff_photo, s.role staff_role, r.rendered_ar, r.rendered_en, r.structured_payload, n.note
       from visits v left join users u on u.id=v.staff_user_id left join staff s on s.user_id=v.staff_user_id
       left join reports r on r.visit_id=v.id left join visit_notes n on n.visit_id=v.id where v.id=$1`, [id])).rows[0];
    const photos = (await c.query(`select storage_key from visit_photos where visit_id=$1 order by created_at`, [id])).rows;
    const photoUrls = await Promise.all(photos.map((p) => d.storage.signDownload(p.storage_key, cfg.signedUrlTtlS)));
    const durationMin = v.checked_in_at && v.checked_out_at ? Math.round((v.checked_out_at - v.checked_in_at) / 60000) : null;
    return {
      kind, id, at: v.checked_in_at ?? v.scheduled_at, type: v.type, status: v.status,
      staff: v.staff_user_id ? { id: v.staff_user_id, firstName: v.staff_name, role: v.staff_role, photoUrl: v.staff_photo ? await d.storage.signDownload(v.staff_photo, cfg.signedUrlTtlS) : null } : null,
      arrivedAt: v.checked_in_at, leftAt: v.checked_out_at, durationMin, report: v.rendered_en ? (lang === 'ar' ? v.rendered_ar : v.rendered_en) : null,
      vitals: v.structured_payload?.vitals ?? [], observations: v.structured_payload?.observations ?? {}, flags: v.structured_payload?.flags ?? null,
      note: v.note ?? null, photoUrls,
    };
  }
  if (kind === 'dose') {
    const x = (await c.query(`select de.id, de.scheduled_at, de.status, de.confirmed_at, de.method, m.name, m.dose_text from dose_events de join medications m on m.id=de.medication_id where de.id=$1`, [id])).rows[0];
    return { kind, id, at: x.scheduled_at, medicine: x.name, dose: x.dose_text, status: x.status, confirmedAt: x.confirmed_at, method: x.method };
  }
  if (kind === 'escalation') {
    const e = (await c.query(`select id, created_at, status, severity, trigger, decision, closed_at, closing_note from escalations where id=$1`, [id])).rows[0];
    return { kind, id, at: e.created_at, ...e };
  }
  const cn = (await c.query(`select id, ref, created_at, category, status, deadline, resolution from concerns where id=$1`, [id])).rows[0];
  return { kind, id, at: cn.created_at, ...cn };
}

/** F3: daily status for one parent. */
export async function dailyStatus(c: Sql, parentId: string, now: Date): Promise<{ status: DailyStatusCode; lastContactAt: Date | null; openEscalationId: string | null }> {
  const cfg = await getConfig(c);
  const today = localParts(now, cfg.timezone).date;
  const from = zonedTimeToUtc(today, '00:00', cfg.timezone);
  const to = zonedTimeToUtc(addDays(today, 1), '00:00', cfg.timezone);
  const contacts = (await c.query(
    `select max(t) t from (
       select checked_in_at t from visits where parent_id=$1 and checked_in_at >= $2 and checked_in_at < $3
       union all select confirmed_at from dose_events where parent_id=$1 and status='confirmed' and confirmed_at >= $2 and confirmed_at < $3 and method in ('caregiver','nurse','parent_phone','parent_whatsapp')
       union all select created_at from helpline_calls where parent_id=$1 and created_at >= $2 and created_at < $3
     ) x`, [parentId, from, to])).rows[0]?.t as Date | null;
  const esc = (await c.query(`select id from escalations where parent_id=$1 and status <> 'closed' order by created_at desc limit 1`, [parentId])).rows[0];
  const status = computeDailyStatus({ now, timezone: cfg.timezone, noContactAfter: cfg.noContactAfter, contactTimes: contacts ? [contacts] : [], openEscalation: !!esc });
  return { status, lastContactAt: contacts ?? null, openEscalationId: esc?.id ?? null };
}

export async function dosesToday(c: Sql, parentId: string, now: Date) {
  const cfg = await getConfig(c);
  const today = localParts(now, cfg.timezone).date;
  const from = zonedTimeToUtc(today, '00:00', cfg.timezone);
  const to = zonedTimeToUtc(addDays(today, 1), '00:00', cfg.timezone);
  return (await c.query(
    `select de.id, de.scheduled_at, de.status, de.confirmed_at, de.method, m.name, m.dose_text, m.instructions
     from dose_events de join medications m on m.id=de.medication_id where de.parent_id=$1 and de.scheduled_at >= $2 and de.scheduled_at < $3 order by de.scheduled_at`,
    [parentId, from, to])).rows;
}
