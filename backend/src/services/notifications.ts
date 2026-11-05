import { CRITICAL_TYPES, notificationTemplates, renderTemplate, type NotificationType } from '@barr/shared';
import type { Sql } from '../db/pool';
import type { Deps } from '../deps';
import { enqueue } from '../jobs/queue';

/** A var can be a plain value or per-language values. */
export type NVar = string | number | { en: string; ar: string };
export type Recipients = { family: string } | { users: string[] };

export interface NotifyArgs {
  type: NotificationType;
  parentId?: string | null;
  to: Recipients;
  vars: Record<string, NVar>;
  channels?: ('push' | 'whatsapp' | 'sms')[];
  /** Makes the call idempotent per recipient+channel. */
  dedupeKey: string;
  data?: Record<string, string>;
}

const resolveVars = (vars: Record<string, NVar>, lang: 'ar' | 'en') =>
  Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === 'object' ? v[lang] : v]));

async function templateBody(c: Sql, type: NotificationType, lang: 'ar' | 'en') {
  const r = await c.query(`select body from notification_templates where type=$1 and language=$2`, [type, lang]);
  return (r.rows[0]?.body as string | undefined) ?? notificationTemplates[type][lang];
}

/**
 * Creates one notification row per recipient per channel and a send job for each.
 * Family members: push always; WhatsApp only with recorded opt-in. Staff: push (+ WhatsApp if opted).
 * Non-critical types honour per-user preferences; critical types cannot be turned off.
 */
export async function notify(c: Sql, now: Date, a: NotifyArgs): Promise<number> {
  const critical = CRITICAL_TYPES.includes(a.type);
  const recipients =
    'family' in a.to
      ? (await c.query(
          `select u.id, u.language, fm.whatsapp_opt_in from family_members fm join users u on u.id = fm.user_id
           where fm.family_id = $1 and fm.removed_at is null and u.deleted_at is null`, [a.to.family])).rows
      : (await c.query(`select u.id, u.language, false as whatsapp_opt_in from users u where u.id = any($1) and u.deleted_at is null`, [a.to.users])).rows;
  let created = 0;
  for (const r of recipients) {
    if (!critical) {
      const pref = await c.query(`select enabled from notification_prefs where user_id=$1 and type=$2`, [r.id, a.type]);
      if (pref.rows[0] && pref.rows[0].enabled === false) continue;
    }
    const lang = r.language as 'ar' | 'en';
    const vars = resolveVars(a.vars, lang);
    const body = renderTemplate(await templateBody(c, a.type, lang), vars);
    const channels = a.channels ?? (r.whatsapp_opt_in ? ['push', 'whatsapp'] : ['push']);
    for (const ch of channels) {
      if (ch === 'whatsapp' && !r.whatsapp_opt_in && 'family' in a.to) continue;
      const ins = await c.query(
        `insert into notifications (type, channel, language, recipient_user_id, parent_id, vars, body, dedupe_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (dedupe_key) do nothing returning id`,
        [a.type, ch, lang, r.id, a.parentId ?? null, { ...vars, _data: a.data ?? {} }, body, `${a.dedupeKey}:${r.id}:${ch}`],
      );
      if (ins.rows[0]) {
        created++;
        await enqueue(c, 'notification.send', { id: ins.rows[0].id }, { runAt: now, dedupeKey: `notif:${ins.rows[0].id}`, maxAttempts: 4 });
      }
    }
  }
  return created;
}

/** Job: deliver a single notification. Escalation pages to staff fall back to SMS when push fails (F17). */
export async function sendNotification(deps: Deps, c: Sql, id: string, now: Date) {
  const n = (await c.query(`select n.*, u.phone_enc from notifications n join users u on u.id = n.recipient_user_id where n.id=$1`, [id])).rows[0];
  if (!n || n.status !== 'queued') return; // idempotent
  const phone = deps.crypto.decryptNullable(n.phone_enc);
  let result: { status: 'sent' | 'failed'; providerRef: string; error?: string };
  if (n.channel === 'push') {
    const tokens = (await c.query(`select token from push_tokens where user_id=$1`, [n.recipient_user_id])).rows.map((r) => r.token);
    result = tokens.length
      ? await deps.push.send({ tokens, title: n.language === 'ar' ? 'بر' : 'Barr', body: n.body, data: { type: n.type, ...(n.parent_id ? { parentId: n.parent_id } : {}), ...(n.vars?._data ?? {}) } })
      : { status: 'failed', providerRef: '', error: 'no_push_token' };
  } else if (n.channel === 'whatsapp') {
    if (!phone) result = { status: 'failed', providerRef: '', error: 'no_phone' };
    else {
      const params = Object.entries(n.vars).filter(([k]) => k !== '_data').map(([, v]) => String(v));
      result = await deps.whatsapp.sendTemplate({ to: phone, template: `barr_${n.type}`, language: n.language, params, preview: n.body });
    }
  } else {
    result = phone ? await deps.sms.send(phone, n.body) : { status: 'failed', providerRef: '', error: 'no_phone' };
  }
  await c.query(`update notifications set status=$2, provider_ref=$3, error=$4, sent_at=$5, updated_at=$5 where id=$1`, [id, result.status, result.providerRef || null, result.error ?? null, now]);
  if (result.status === 'failed' && n.channel === 'push' && n.type === 'escalation_page_staff') {
    const ins = await c.query(
      `insert into notifications (type, channel, language, recipient_user_id, parent_id, vars, body, dedupe_key)
       values ($1,'sms',$2,$3,$4,$5,$6,$7) on conflict (dedupe_key) do nothing returning id`,
      [n.type, n.language, n.recipient_user_id, n.parent_id, n.vars, n.body, `${n.dedupe_key}:smsfallback`],
    );
    if (ins.rows[0]) await enqueue(c, 'notification.send', { id: ins.rows[0].id }, { runAt: now, dedupeKey: `notif:${ins.rows[0].id}` });
  }
}

/** Coordinator task (idempotent by dedupe key). */
export async function createTask(c: Sql, t: { kind: string; parentId?: string | null; assigneeUserId?: string | null; title: string; refType?: string; refId?: string; dueAt?: Date | null; dedupeKey: string }) {
  let cityId = null, podId = null, assignee = t.assigneeUserId ?? null;
  if (t.parentId) {
    const p = (await c.query(`select p.city_id, p.pod_id, po.coordinator_user_id from parents p join pods po on po.id = p.pod_id where p.id=$1`, [t.parentId])).rows[0];
    if (p) { cityId = p.city_id; podId = p.pod_id; assignee = assignee ?? p.coordinator_user_id; }
  }
  const r = await c.query(
    `insert into tasks (kind, parent_id, city_id, pod_id, assignee_user_id, title, ref_type, ref_id, due_at, dedupe_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (dedupe_key) do nothing returning id`,
    [t.kind, t.parentId ?? null, cityId, podId, assignee, t.title, t.refType ?? null, t.refId ?? null, t.dueAt ?? null, t.dedupeKey],
  );
  return r.rows[0]?.id as string | undefined;
}
