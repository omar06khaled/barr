import { SignJWT, jwtVerify } from 'jose';
import { toE164, type Role } from '@barr/shared';
import type { Deps } from '../deps';
import type { Sql } from '../db/pool';
import { randomToken, safeEqual, sha256, sixDigitCode } from '../lib/crypto';
import { AppError, badRequest, unauthorized } from '../lib/errors';
import { audit, track } from './audit';

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_DAYS = 60;
const OTP_TTL_MS = 10 * 60_000;

export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; user: { id: string; roles: Role[]; language: string; displayName: string } }

const key = (d: Deps) => new TextEncoder().encode(d.env.JWT_SECRET);

export async function issueSession(d: Deps, c: Sql, userId: string, deviceName?: string): Promise<Tokens> {
  const u = (await c.query(`select id, roles, language, display_name from users where id=$1`, [userId])).rows[0];
  const refresh = randomToken();
  const now = d.clock.now();
  const s = (await c.query(
    `insert into sessions (user_id, refresh_hash, device_name, created_at, last_used_at, expires_at) values ($1,$2,$3,$4,$4,$5) returning id`,
    [userId, sha256(refresh), deviceName ?? null, now, new Date(now.getTime() + REFRESH_TTL_DAYS * 86_400_000)],
  )).rows[0];
  const accessToken = await new SignJWT({ roles: u.roles, sid: s.id })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + ACCESS_TTL_S).sign(key(d));
  return { accessToken, refreshToken: `${s.id}.${refresh}`, expiresIn: ACCESS_TTL_S, user: { id: u.id, roles: u.roles, language: u.language, displayName: u.display_name } };
}

/** Verifies the access token AND that the session is not revoked (immediate offboarding, §6). */
export async function authenticate(d: Deps, bearer: string | undefined): Promise<{ userId: string; roles: Role[]; sessionId: string }> {
  if (!bearer?.startsWith('Bearer ')) throw unauthorized();
  let payload;
  try {
    ({ payload } = await jwtVerify(bearer.slice(7), key(d), { currentDate: d.clock.now() }));
  } catch {
    throw unauthorized('invalid_token');
  }
  const sid = String(payload.sid);
  const s = await d.db.system(async (c) => (await c.query(
    `select s.revoked_at, u.roles, u.deleted_at from sessions s join users u on u.id = s.user_id where s.id=$1 and s.user_id=$2`, [sid, payload.sub])).rows[0]);
  if (!s || s.revoked_at || s.deleted_at) throw unauthorized('session_revoked');
  return { userId: String(payload.sub), roles: s.roles as Role[], sessionId: sid };
}

export async function refresh(d: Deps, token: string): Promise<Tokens> {
  const [sid, secret] = token.split('.');
  if (!sid || !secret) throw unauthorized('invalid_refresh');
  return d.db.system(async (c) => {
    const s = (await c.query(`select * from sessions where id=$1 for update`, [sid])).rows[0];
    if (!s || s.revoked_at || s.expires_at < d.clock.now()) throw unauthorized('invalid_refresh');
    if (!safeEqual(s.refresh_hash, sha256(secret))) {
      // Reuse of a rotated token → revoke the session (token theft protection).
      await c.query(`update sessions set revoked_at=$2, revoked_reason='refresh_reuse' where id=$1`, [sid, d.clock.now()]);
      throw unauthorized('invalid_refresh');
    }
    await c.query(`update sessions set revoked_at=$2, revoked_reason='rotated' where id=$1`, [sid, d.clock.now()]);
    return issueSession(d, c, s.user_id, s.device_name);
  });
}

export async function requestOtp(d: Deps, rawPhone: string) {
  const phone = toE164(rawPhone);
  if (!phone) throw badRequest('invalid_phone');
  const ph = d.crypto.blindIndex(phone);
  const now = d.clock.now();
  await d.db.system(async (c) => {
    const recent = (await c.query(`select count(*)::int n from otp_codes where phone_hash=$1 and created_at > $2`, [ph, new Date(now.getTime() - 3_600_000)])).rows[0].n;
    if (recent >= 5) throw new AppError(429, 'too_many_codes');
    const code = d.env.DEV_FIXED_OTP ?? sixDigitCode();
    await c.query(`insert into otp_codes (phone_hash, code_hash, expires_at, created_at) values ($1,$2,$3,$4)`, [ph, sha256(ph + code), new Date(now.getTime() + OTP_TTL_MS), now]);
    const u = (await c.query(`select language from users where phone_hash=$1`, [ph])).rows[0];
    const ar = (u?.language ?? (phone.startsWith('+20') ? 'ar' : 'en')) === 'ar';
    await d.sms.send(phone, ar ? `رمز بر الخاص بك هو ${code}. تنتهي صلاحيته خلال 10 دقائق.` : `Your Barr code is ${code}. It expires in 10 minutes.`);
  });
  return { sent: true };
}

export async function verifyOtp(d: Deps, rawPhone: string, code: string, deviceName?: string): Promise<Tokens & { isNew: boolean }> {
  const phone = toE164(rawPhone);
  if (!phone) throw badRequest('invalid_phone');
  const ph = d.crypto.blindIndex(phone);
  const now = d.clock.now();
  return d.db.system(async (c) => {
    const otp = (await c.query(`select * from otp_codes where phone_hash=$1 and consumed_at is null and expires_at > $2 order by created_at desc limit 1 for update`, [ph, now])).rows[0];
    if (!otp || otp.attempts >= 5) throw unauthorized('invalid_code');
    if (!safeEqual(otp.code_hash, sha256(ph + code))) {
      await c.query(`update otp_codes set attempts = attempts + 1 where id=$1`, [otp.id]);
      throw unauthorized('invalid_code');
    }
    await c.query(`update otp_codes set consumed_at=$2 where id=$1`, [otp.id, now]);
    let user = (await c.query(`select u.*, s.active as staff_active from users u left join staff s on s.user_id = u.id where u.phone_hash=$1 and u.deleted_at is null`, [ph])).rows[0];
    let isNew = false;
    if (user && user.staff_active === false) throw new AppError(403, 'staff_inactive');
    if (!user) {
      // Self-registration creates FAMILY accounts only. Staff are created by an admin (§6).
      user = (await c.query(`insert into users (phone_enc, phone_hash, roles, language, phone_verified_at) values ($1,$2,'{family}',$3,$4) returning *`, [
        d.crypto.encrypt(phone), ph, 'ar', now])).rows[0];
      isNew = true;
      await track(c, 'signup', user.id, null, { method: 'phone' });
    } else if (!user.phone_verified_at) {
      await c.query(`update users set phone_verified_at=$2 where id=$1`, [user.id, now]);
    }
    await acceptPendingInvites(c, user.id, ph, now);
    await audit(c, { actorUserId: user.id, action: 'auth.sign_in', entityType: 'user', entityId: user.id, meta: { method: 'phone' } });
    return { ...(await issueSession(d, c, user.id, deviceName)), isNew };
  });
}

export async function oauthSignIn(d: Deps, provider: 'google' | 'apple', idToken: string, nonce: string | undefined, linkToUserId?: string) {
  const ident = await d.oauth.verify(provider, idToken, nonce).catch(() => { throw unauthorized('invalid_id_token'); });
  return d.db.system(async (c) => {
    const existing = (await c.query(`select user_id from auth_identities where provider=$1 and subject=$2`, [provider, ident.subject])).rows[0];
    if (linkToUserId) {
      if (existing && existing.user_id !== linkToUserId) throw new AppError(409, 'identity_linked_to_other_account');
      await c.query(`insert into auth_identities (user_id, provider, subject, email) values ($1,$2,$3,$4) on conflict (provider, subject) do nothing`, [linkToUserId, provider, ident.subject, ident.email ?? null]);
      await audit(c, { actorUserId: linkToUserId, action: 'auth.link', entityType: 'user', entityId: linkToUserId, meta: { provider } });
      return { linked: true as const };
    }
    let userId = existing?.user_id as string | undefined;
    let isNew = false;
    if (!userId) {
      userId = (await c.query(`insert into users (email, roles) values ($1,'{family}') returning id`, [ident.email ?? null])).rows[0].id as string;
      await c.query(`insert into auth_identities (user_id, provider, subject, email) values ($1,$2,$3,$4)`, [userId, provider, ident.subject, ident.email ?? null]);
      isNew = true;
      await track(c, 'signup', userId, null, { method: provider });
    }
    const u = (await c.query(`select u.deleted_at, s.active from users u left join staff s on s.user_id=u.id where u.id=$1`, [userId])).rows[0];
    if (u.deleted_at) throw unauthorized('account_deleted');
    if (u.active === false) throw new AppError(403, 'staff_inactive');
    await audit(c, { actorUserId: userId, action: 'auth.sign_in', entityType: 'user', entityId: userId, meta: { method: provider } });
    return { ...(await issueSession(d, c, userId)), isNew };
  });
}

export async function acceptPendingInvites(c: Sql, userId: string, phoneHash: string, now: Date) {
  const invites = (await c.query(`select * from family_invites where phone_hash=$1 and accepted_at is null and revoked_at is null and expires_at > $2`, [phoneHash, now])).rows;
  for (const inv of invites) {
    await c.query(
      `insert into family_members (family_id, user_id, invited_by, joined_at) values ($1,$2,$3,$4)
       on conflict (family_id, user_id) do update set removed_at = null, joined_at = excluded.joined_at`,
      [inv.family_id, userId, inv.invited_by, now],
    );
    await c.query(`update family_invites set accepted_at=$2, accepted_by=$3 where id=$1`, [inv.id, now, userId]);
    await audit(c, { actorUserId: userId, action: 'family.invite_accepted', entityType: 'family', entityId: inv.family_id, meta: { inviteId: inv.id } });
  }
  return invites.length;
}

export async function revokeUserSessions(c: Sql, userId: string, now: Date, reason: string) {
  const r = await c.query(`update sessions set revoked_at=$2, revoked_reason=$3 where user_id=$1 and revoked_at is null`, [userId, now, reason]);
  return r.rowCount ?? 0;
}
