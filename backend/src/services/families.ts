import { defaultCarerPreference, toE164, type ParentCreate } from '@barr/shared';
import type { Actor, Sql } from '../db/pool';
import type { Deps } from '../deps';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { audit, track } from './audit';
import { notify, type NVar } from './notifications';
import { getConfig } from './settings';

export async function familiesOf(c: Sql, userId: string): Promise<string[]> {
  return (await c.query(`select family_id from family_members where user_id=$1 and removed_at is null order by joined_at`, [userId])).rows.map((r) => r.family_id);
}

export async function assertFamilyMember(c: Sql, familyId: string, userId: string) {
  const r = await c.query(`select 1 from family_members where family_id=$1 and user_id=$2 and removed_at is null`, [familyId, userId]);
  if (!r.rowCount) throw forbidden('not_family_member');
}

/** Equal-access rule (§5): every change by one member is told to all the others. */
export async function notifySiblings(c: Sql, now: Date, familyId: string, actorUserId: string, change: { en: string; ar: string }, key: string, parentId?: string) {
  const actor = (await c.query(`select coalesce(nullif(first_name,''), display_name) n from users where id=$1`, [actorUserId])).rows[0]?.n || '—';
  const others = (await c.query(`select user_id from family_members where family_id=$1 and removed_at is null and user_id <> $2`, [familyId, actorUserId])).rows.map((r) => r.user_id);
  if (!others.length) return 0;
  return notify(c, now, { type: 'plan_changed_by_sibling', parentId: parentId ?? null, to: { users: others }, vars: { actor, change } as Record<string, NVar>, dedupeKey: key });
}

/** Pick the pod whose neighbourhoods include the parent's; otherwise the first pod of the first city. */
async function choosePod(c: Sql, neighborhood: string | undefined) {
  if (neighborhood) {
    const p = (await c.query(`select id, city_id from pods where $1 = any(neighborhoods) order by created_at limit 1`, [neighborhood])).rows[0];
    if (p) return p;
  }
  const p = (await c.query(`select id, city_id from pods order by created_at limit 1`)).rows[0];
  if (!p) throw new AppError(503, 'no_pods_configured');
  return p;
}

export async function createParent(d: Deps, c: Sql, actor: Actor, input: ParentCreate & { familyId?: string }) {
  const now = d.clock.now();
  let familyId = input.familyId;
  if (familyId) await assertFamilyMember(c, familyId, actor.userId);
  else {
    familyId = (await familiesOf(c, actor.userId))[0];
    if (!familyId) {
      familyId = (await c.query(`insert into families default values returning id`)).rows[0].id as string;
      await c.query(`insert into family_members (family_id, user_id, joined_at) values ($1,$2,$3)`, [familyId, actor.userId, now]);
    }
  }
  const pod = await choosePod(c, input.neighborhood);
  const phone = input.phone ? toE164(input.phone, 'EG') : null;
  if (input.phone && !phone) throw badRequest('invalid_parent_phone');
  const contacts = input.emergencyContacts.map((x) => ({ ...x, phone: toE164(x.phone, 'EG') ?? x.phone }));
  const pref = input.carerGenderPreference && input.carerGenderPreference !== 'same_as_parent' ? input.carerGenderPreference : defaultCarerPreference(input.gender);
  const p = (await c.query(
    `insert into parents (family_id, city_id, pod_id, name, gender, birth_year, phone_enc, address_enc, neighborhood, lat, lng, language, carer_preference,
       emergency_contacts_enc, known_medicines, allergies_has, allergies_text, mobility_notes, photo_key, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20) returning id`,
    [familyId, pod.city_id, pod.id, input.name, input.gender, input.birthYear ?? null, d.crypto.encryptNullable(phone), d.crypto.encrypt(input.address),
      input.neighborhood ?? '', input.location.lat, input.location.lng, input.language, pref, d.crypto.encrypt(JSON.stringify(contacts)),
      JSON.stringify(input.knownMedicines), input.allergies.has, input.allergies.has ? input.allergies.text : '', input.mobilityNotes, input.photoKey ?? null, now],
  )).rows[0];
  await c.query(`insert into chat_threads (parent_id) values ($1)`, [p.id]);
  await audit(c, { actorUserId: actor.userId, action: 'parent.create', entityType: 'parent', entityId: p.id, parentId: p.id, after: redact(input) });
  await track(c, 'parent_added', actor.userId, p.id);
  return { id: p.id as string, familyId };
}

const SENSITIVE = ['phone', 'address', 'emergencyContacts'];
function redact(o: Record<string, any>) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SENSITIVE.includes(k) ? '[encrypted]' : v]));
}

export async function getParent(d: Deps, c: Sql, actor: Actor, parentId: string) {
  const p = (await c.query(`select * from parents where id=$1 and deleted_at is null`, [parentId])).rows[0];
  if (!p) throw notFound('parent_not_found');
  // §8: audit every staff read of a parent's record.
  if (actor.roles.some((r) => r !== 'family')) await audit(c, { actorUserId: actor.userId, action: 'parent.read', entityType: 'parent', entityId: parentId, parentId });
  const photoConsent = (await c.query(`select parent_has_photo_consent($1) ok`, [parentId])).rows[0].ok;
  return {
    id: p.id, familyId: p.family_id, cityId: p.city_id, podId: p.pod_id, name: p.name, gender: p.gender, birthYear: p.birth_year,
    phone: d.crypto.decryptNullable(p.phone_enc), address: d.crypto.decrypt(p.address_enc), neighborhood: p.neighborhood,
    location: { lat: p.lat, lng: p.lng }, language: p.language, carerPreference: p.carer_preference,
    emergencyContacts: p.emergency_contacts_enc ? JSON.parse(d.crypto.decrypt(p.emergency_contacts_enc)) : [],
    knownMedicines: p.known_medicines, allergies: { has: p.allergies_has, text: p.allergies_text }, mobilityNotes: p.mobility_notes,
    photoKey: p.photo_key, status: p.status, photoConsent,
  };
}

export async function updateParent(d: Deps, c: Sql, actor: Actor, parentId: string, patch: Partial<ParentCreate>) {
  const now = d.clock.now();
  const before = await getParent(d, c, actor, parentId);
  const sets: string[] = [];
  const vals: unknown[] = [parentId];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (patch.name !== undefined) set('name', patch.name);
  if (patch.gender !== undefined) set('gender', patch.gender);
  if (patch.birthYear !== undefined) set('birth_year', patch.birthYear);
  if (patch.phone !== undefined) { const ph = patch.phone ? toE164(patch.phone, 'EG') : null; if (patch.phone && !ph) throw badRequest('invalid_parent_phone'); set('phone_enc', d.crypto.encryptNullable(ph)); }
  if (patch.address !== undefined) set('address_enc', d.crypto.encrypt(patch.address));
  if (patch.neighborhood !== undefined) set('neighborhood', patch.neighborhood);
  if (patch.location) { set('lat', patch.location.lat); set('lng', patch.location.lng); }
  if (patch.language !== undefined) set('language', patch.language);
  if (patch.carerGenderPreference !== undefined) set('carer_preference', patch.carerGenderPreference === 'same_as_parent' ? defaultCarerPreference(patch.gender ?? before.gender) : patch.carerGenderPreference);
  if (patch.emergencyContacts) set('emergency_contacts_enc', d.crypto.encrypt(JSON.stringify(patch.emergencyContacts)));
  if (patch.knownMedicines) set('known_medicines', JSON.stringify(patch.knownMedicines));
  if (patch.allergies) { set('allergies_has', patch.allergies.has); set('allergies_text', patch.allergies.has ? patch.allergies.text : ''); }
  if (patch.mobilityNotes !== undefined) set('mobility_notes', patch.mobilityNotes);
  if (patch.photoKey !== undefined) set('photo_key', patch.photoKey);
  if (!sets.length) return before;
  vals.push(now);
  await c.query(`update parents set ${sets.join(', ')}, updated_at=$${vals.length} where id=$1`, vals);
  const changed = Object.keys(patch);
  await audit(c, { actorUserId: actor.userId, action: 'parent.update', entityType: 'parent', entityId: parentId, parentId, before: redact(pick(before, changed)), after: redact(patch) });
  if (actor.roles.includes('family')) {
    await notifySiblings(c, now, before.familyId, actor.userId, { en: `updated ${before.name}'s profile (${changed.join(', ')})`, ar: `حدّث ملف ${before.name} (${changed.join('، ')})` }, `parent:${parentId}:update:${now.getTime()}`, parentId);
  }
  return getParent(d, c, actor, parentId);
}
const pick = (o: Record<string, any>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

export async function inviteMember(d: Deps, c: Sql, actor: Actor, familyId: string, rawPhone: string) {
  await assertFamilyMember(c, familyId, actor.userId);
  const phone = toE164(rawPhone, 'SA');
  if (!phone) throw badRequest('invalid_phone');
  const now = d.clock.now();
  const cfg = await getConfig(c);
  const ph = d.crypto.blindIndex(phone);
  const existingMember = (await c.query(`select 1 from family_members fm join users u on u.id=fm.user_id where fm.family_id=$1 and u.phone_hash=$2 and fm.removed_at is null`, [familyId, ph])).rowCount;
  if (existingMember) throw new AppError(409, 'already_member');
  const inv = (await c.query(
    `insert into family_invites (family_id, phone_hash, phone_enc, invited_by, expires_at, created_at) values ($1,$2,$3,$4,$5,$6) returning id, expires_at`,
    [familyId, ph, d.crypto.encrypt(phone), actor.userId, new Date(now.getTime() + cfg.inviteExpiryDays * 86_400_000), now],
  )).rows[0];
  const who = (await c.query(`select coalesce(nullif(first_name,''), display_name) n, language from users where id=$1`, [actor.userId])).rows[0];
  const parentName = (await c.query(`select string_agg(name, ' & ') n from parents where family_id=$1 and deleted_at is null`, [familyId])).rows[0]?.n ?? '';
  const lang = phone.startsWith('+20') ? 'ar' : who?.language ?? 'ar';
  await d.sms.send(phone, lang === 'ar'
    ? `دعاك ${who?.n || ''} لمتابعة رعاية ${parentName} على بر. حمّل التطبيق وسجّل الدخول بهذا الرقم. تنتهي الدعوة خلال 7 أيام.`
    : `${who?.n || ''} invited you to follow ${parentName}'s care on Barr. Download the app and sign in with this number. Expires in 7 days.`);
  await audit(c, { actorUserId: actor.userId, action: 'family.invite', entityType: 'family', entityId: familyId, meta: { inviteId: inv.id } });
  await notifySiblings(c, now, familyId, actor.userId, { en: 'invited a new family member', ar: 'دعا فردًا جديدًا من العائلة' }, `invite:${inv.id}`);
  return { id: inv.id as string, expiresAt: inv.expires_at as Date };
}

export async function removeMember(d: Deps, c: Sql, actor: Actor, familyId: string, userId: string) {
  await assertFamilyMember(c, familyId, actor.userId);
  const now = d.clock.now();
  const r = await c.query(`update family_members set removed_at=$3 where family_id=$1 and user_id=$2 and removed_at is null`, [familyId, userId, now]);
  if (!r.rowCount) throw notFound('member_not_found');
  const remaining = (await c.query(`select count(*)::int n from family_members where family_id=$1 and removed_at is null`, [familyId])).rows[0].n;
  if (remaining === 0) throw new AppError(409, 'cannot_remove_last_member');
  await audit(c, { actorUserId: actor.userId, action: 'family.remove_member', entityType: 'family', entityId: familyId, meta: { removed: userId } });
  const name = (await c.query(`select coalesce(nullif(first_name,''), display_name, '') n from users where id=$1`, [userId])).rows[0]?.n ?? '';
  await notifySiblings(c, now, familyId, actor.userId, { en: `removed ${name} from the family`, ar: `أزال ${name} من العائلة` }, `remove:${familyId}:${userId}:${now.getTime()}`);
}

/** §6 / §8 account deletion: removes the member's PII; parent care records are kept per retention policy. */
export async function deleteAccount(c: Sql, now: Date, userId: string) {
  await c.query(`update family_members set removed_at=$2 where user_id=$1 and removed_at is null`, [userId, now]);
  await c.query(`delete from auth_identities where user_id=$1`, [userId]);
  await c.query(`delete from push_tokens where user_id=$1`, [userId]);
  await c.query(`update sessions set revoked_at=$2, revoked_reason='account_deleted' where user_id=$1 and revoked_at is null`, [userId, now]);
  await c.query(`update users set phone_enc=null, phone_hash=null, email=null, display_name='Deleted user', first_name='', photo_key=null, deleted_at=$2 where id=$1`, [userId, now]);
  await audit(c, { actorUserId: userId, action: 'account.delete', entityType: 'user', entityId: userId });
}
