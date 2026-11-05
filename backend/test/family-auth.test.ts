import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { activate, api, makeHarness, newFamily, signInPhone, type Harness } from './harness';

let h: Harness;
beforeEach(async () => { if (h) await h.close(); h = await makeHarness(); });
afterAll(async () => { await h.close(); });

describe('§5/§6 sibling invites and equal access', () => {
  it('invite by phone → sibling signs in → equal access; every change is audited and told to the others', async () => {
    const sara = await newFamily(h, '+966501111111');
    await h.owner.query(`update users set first_name='Sara' where id=$1`, [sara.userId]);
    const inv = await api(h, sara.token, 'POST', `/families/${sara.familyId}/invites`, { phone: '+971 50 222 2222' });
    expect(inv.status).toBe(200);
    expect(new Date(inv.body.expiresAt).getTime() - h.clock.now().getTime()).toBe(7 * 86_400_000);
    expect(h.sms.sent.at(-1)!.to).toBe('+971502222222');

    const ahmed = await signInPhone(h.app, '+971502222222');
    await h.owner.query(`update users set first_name='Ahmed' where id=$1`, [ahmed.user.id]);
    // Ahmed now has the same access as Sara.
    expect((await api(h, ahmed.accessToken, 'GET', `/parents/${sara.parentId}`)).status).toBe(200);
    const members = await api(h, ahmed.accessToken, 'GET', `/families/${sara.familyId}/members`);
    expect(members.body.members).toHaveLength(2);

    // Ahmed subscribes, Sara changes the plan: both allowed; the other is notified; audit has it.
    const s = await api(h, ahmed.accessToken, 'POST', '/subscriptions', { parentId: sara.parentId, planCode: 'visit', currency: 'USD' });
    await h.owner.query(`update subscriptions set status='active', current_period_start=$2, current_period_end=$3 where id=$1`, [s.body.subscriptionId, h.clock.now(), new Date(h.clock.now().getTime() + 30 * 86_400_000)]);
    expect((await api(h, sara.token, 'POST', `/subscriptions/${s.body.subscriptionId}/plan`, { planCode: 'plus' })).status).toBe(200);
    const note = (await h.owner.query(`select * from notifications where type='plan_changed_by_sibling' and recipient_user_id=$1`, [ahmed.user.id])).rows;
    expect(note.map((n) => n.body).join('\n')).toMatch(/Sara غيّر الباقة إلى بلس/);
    expect((await h.owner.query(`select count(*)::int n from audit_log where action='subscription.change_plan' and actor_user_id=$1`, [sara.userId])).rows[0].n).toBe(1);

    // Profile edit by Ahmed → Sara told.
    await api(h, ahmed.accessToken, 'PATCH', `/parents/${sara.parentId}`, { mobilityNotes: 'Now uses a walker' });
    const toSara = (await h.owner.query(`select body from notifications where type='plan_changed_by_sibling' and recipient_user_id=$1`, [sara.userId])).rows;
    expect(toSara.some((n) => n.body.includes('Ahmed'))).toBe(true);
    const edit = (await h.owner.query(`select before, after from audit_log where action='parent.update'`)).rows[0];
    expect(edit.after).toEqual({ mobilityNotes: 'Now uses a walker' });
    expect(edit.before).toEqual({ mobilityNotes: 'Uses a cane' });

    // Remove a member; cannot remove the last one.
    expect((await api(h, sara.token, 'DELETE', `/families/${sara.familyId}/members/${ahmed.user.id}`)).status).toBe(200);
    expect((await api(h, ahmed.accessToken, 'GET', `/parents/${sara.parentId}`)).status).toBe(403);
    expect((await api(h, sara.token, 'DELETE', `/families/${sara.familyId}/members/${sara.userId}`)).status).toBe(409);
  });

  it('invites expire after 7 days', async () => {
    const sara = await newFamily(h, '+966501111111');
    await api(h, sara.token, 'POST', `/families/${sara.familyId}/invites`, { phone: '+971502222222' });
    h.clock.advanceMs(7 * 86_400_000 + 1000);
    const late = await signInPhone(h.app, '+971502222222');
    expect((await api(h, late.accessToken, 'GET', `/parents/${sara.parentId}`)).status).toBe(403);
  });

  it('a family member can follow several parents (both parents)', async () => {
    const f = await newFamily(h);
    const dad = await api(h, f.token, 'POST', '/parents', { name: 'Mahmoud', gender: 'male', address: 'Dokki, Giza', neighborhood: 'Dokki', location: { lat: 30.04, lng: 31.21 }, language: 'ar', emergencyContacts: [], allergies: { has: false, text: '' } });
    expect(dad.status).toBe(200);
    expect(dad.body.familyId).toBe(f.familyId);
    const list = await api(h, f.token, 'GET', '/parents');
    expect(list.body.items).toHaveLength(2);
    expect((await api(h, f.token, 'GET', `/parents/${dad.body.id}`)).body.carerPreference).toBe('male');
  });
});

describe('§6 authentication and sessions', () => {
  it('unknown number signs up as FAMILY only (staff cannot self-register); invalid code rejected', async () => {
    const r1 = await h.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+201099999999' } });
    expect(r1.statusCode).toBe(200);
    const bad = await h.app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: '+201099999999', code: '000000' } });
    expect(bad.statusCode).toBe(401);
    const s = await signInPhone(h.app, '+201099999999');
    expect(s.isNew).toBe(true);
    expect(s.user.roles ?? (await api(h, s.accessToken, 'GET', '/me')).body.roles).toEqual(['family']);
    expect((await api(h, s.accessToken, 'GET', '/admin/today')).status).toBe(403);
    // Stored phone is E.164 and encrypted.
    const u = (await h.owner.query(`select phone_enc from users where id=$1`, [s.user.id])).rows[0];
    expect(h.d.crypto.decrypt(u.phone_enc)).toBe('+201099999999');
  });

  it('refresh rotates; reusing an old refresh token revokes the session', async () => {
    const s = await signInPhone(h.app, '+966503333333');
    const r1 = await h.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: s.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const reuse = await h.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: s.refreshToken } });
    expect(reuse.statusCode).toBe(401);
  });

  it('admin revokes a staff member immediately (offboarding): existing access token stops working', async () => {
    const before = await api(h, h.token('nurse'), 'GET', '/field/visits');
    expect(before.status).toBe(200);
    const r = await api(h, h.token('admin'), 'POST', `/admin/staff/${h.ids.nurse}/deactivate`);
    expect(r.status).toBe(200);
    expect(r.body.sessionsRevoked).toBeGreaterThan(0);
    expect((await api(h, h.token('nurse'), 'GET', '/field/visits')).status).toBe(401);
    const again = await h.app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone: '+201000000003', code: '123456' } });
    expect(again.statusCode).not.toBe(200);
  });

  it('Google / Apple sign-in and linking to an existing phone account', async () => {
    const g = await h.app.inject({ method: 'POST', url: '/v1/auth/oauth', payload: { provider: 'google', idToken: 'google:sub-123:mona@example.com' } });
    expect(g.statusCode).toBe(200);
    expect(g.json().isNew).toBe(true);
    const phoneUser = await signInPhone(h.app, '+966504444444');
    const link = await api(h, phoneUser.accessToken, 'POST', '/auth/link', { provider: 'apple', idToken: 'apple:apple-sub-9:x@privaterelay.appleid.com' });
    expect(link.body).toEqual({ linked: true });
    const a = await h.app.inject({ method: 'POST', url: '/v1/auth/oauth', payload: { provider: 'apple', idToken: 'apple:apple-sub-9:x@privaterelay.appleid.com' } });
    expect(a.json().user.id).toBe(phoneUser.user.id);
    // Linking an identity owned by someone else is refused.
    const steal = await api(h, phoneUser.accessToken, 'POST', '/auth/link', { provider: 'google', idToken: 'google:sub-123:mona@example.com' });
    expect(steal.status).toBe(409);
  });

  it('account deletion removes family-member PII but keeps the parent care record', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const del = await api(h, f.token, 'DELETE', '/me');
    expect(del.body).toEqual({ deleted: true });
    const u = (await h.owner.query(`select phone_enc, phone_hash, email, display_name, deleted_at from users where id=$1`, [f.userId])).rows[0];
    expect(u).toMatchObject({ phone_enc: null, phone_hash: null, email: null, display_name: 'Deleted user' });
    expect(u.deleted_at).not.toBeNull();
    expect((await api(h, f.token, 'GET', '/me')).status).toBe(401);
    expect((await h.owner.query(`select count(*)::int n from parents where id=$1`, [f.parentId])).rows[0].n).toBe(1);
  });
});
