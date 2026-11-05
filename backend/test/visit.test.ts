import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FAR, NEAR, activate, api, makeHarness, makeVisit, newFamily, signInPhone, uuid, type Harness } from './harness';

let h: Harness;
beforeEach(async () => { if (h) await h.close(); h = await makeHarness(); });
afterAll(async () => { await h.close(); });

const report = (visitId: string, at: string, extra: Record<string, unknown> = {}) => ({
  visitId, submittedAt: at, offline: true,
  observations: { mood: 4, appetite: 'good', pain: { score: 2, location: 'joints' }, hydration: 'ok', mobility: 'with_aid', medicineAdherence: 'ok', fallsSinceLastVisit: 0 },
  vitals: [{ kind: 'bp_systolic', value: 132, recordedAt: at }, { kind: 'bp_diastolic', value: 84, recordedAt: at }, { kind: 'pulse', value: 76, recordedAt: at }],
  tasksDone: ['meds_reviewed'], note: 'Walked to the balcony with her cane. In good spirits.', photoKeys: [], ...extra,
});

describe('M1: offline nurse visit → sync → family timeline', () => {
  it('captured offline (check-in, report, check-out), synced later, visible to family immediately after sync, idempotent on retry', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const visitId = await makeVisit(h, f.parentId);
    // Nurse can load the visit package before going offline.
    const pkg = await api(h, h.token('nurse'), 'GET', `/field/visits/${visitId}`);
    expect(pkg.status).toBe(200);
    expect(pkg.body.template.vitals).toContain('bp_systolic');
    expect(pkg.body.consent.photos).toBe(true);

    const tIn = new Date(h.clock.now().getTime() + 30 * 60_000).toISOString();
    const tRep = new Date(h.clock.now().getTime() + 62 * 60_000).toISOString();
    const tOut = new Date(h.clock.now().getTime() + 65 * 60_000).toISOString();
    // Upload one photo (signed URL) before/after — key must be under the visit.
    const up = await api(h, h.token('nurse'), 'POST', '/uploads', { purpose: 'visit_photo', parentId: f.parentId, visitId, contentType: 'image/jpeg' });
    expect(up.status).toBe(200);
    expect(new Date(up.body.expiresAt).getTime() - h.clock.now().getTime()).toBeLessThanOrEqual(15 * 60_000);
    const ops = [
      { opId: uuid(), kind: 'check_in', payload: { visitId, capturedAt: tIn, location: NEAR, offline: true } },
      { opId: uuid(), kind: 'report', payload: report(visitId, tRep, { photoKeys: [up.body.key] }) },
      { opId: uuid(), kind: 'check_out', payload: { visitId, capturedAt: tOut, location: NEAR, offline: true } },
    ];
    // Connectivity returns 3 hours later.
    h.clock.advanceMs(3 * 3_600_000);
    // Access tokens live 15 min; the app refreshes. Here: sign in again.
    h.tokens.nurse = (await signInPhone(h.app, '+201000000003')).accessToken;
    h.tokens.coordinator = (await signInPhone(h.app, '+201000000002')).accessToken;
    f.token = (await signInPhone(h.app, '+966501234567')).accessToken;
    const s1 = await api(h, h.token('nurse'), 'POST', '/field/sync', { ops });
    expect(s1.status).toBe(200);
    expect(s1.body.results.map((r: any) => r.status)).toEqual(['applied', 'applied', 'applied']);

    // Check-in time is the CAPTURE time, not the sync time.
    const v = (await h.owner.query(`select * from visits where id=$1`, [visitId])).rows[0];
    expect(v.checked_in_at.toISOString()).toBe(tIn);
    expect(v.offline_captured).toBe(true);
    expect(v.status).toBe('completed');

    // Family timeline: available right after sync (well within 1 minute).
    const tl = await api(h, f.token, 'GET', `/parents/${f.parentId}/timeline?lang=en`);
    expect(tl.status).toBe(200);
    const card = tl.body.items[0];
    expect(card.kind).toBe('visit');
    expect(card.staff.firstName).toBe('nurse');
    expect(card.arrivedAt).toBe(tIn);
    expect(card.durationMin).toBe(35);
    expect(card.report).toContain('Nurse visit');
    expect(card.vitals.map((x: any) => x.kind)).toEqual(['bp_systolic', 'bp_diastolic', 'pulse']);
    expect(card.photoUrls).toHaveLength(1);
    const ar = await api(h, f.token, 'GET', `/parents/${f.parentId}/timeline?lang=ar`);
    expect(ar.body.items[0].report).toContain('زيارة تمريض');

    // Push "visit report ready" queued for the family member.
    await h.worker.drain(h.clock.now());
    const n = (await h.owner.query(`select * from notifications where type='visit_report_ready'`)).rows;
    expect(n).toHaveLength(1);
    expect(n[0].recipient_user_id).toBe(f.userId);

    // Retrying the same batch (flaky network) applies nothing twice.
    const s2 = await api(h, h.token('nurse'), 'POST', '/field/sync', { ops });
    expect(s2.body.results.map((r: any) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect((await h.owner.query(`select count(*)::int n from reports where visit_id=$1`, [visitId])).rows[0].n).toBe(1);

    // A second, different report from another device is a conflict (server copy wins).
    const s3 = await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'report', payload: report(visitId, tRep) }] });
    expect(s3.body.results[0]).toMatchObject({ status: 'conflict', error: 'already_submitted' });

    // Daily status is green for today.
    h.clock.set(new Date(tOut));
    expect((await api(h, f.token, 'GET', `/parents/${f.parentId}/status`)).body.status).toBe('checked');
  });

  it('F5: check-in outside 150 m is blocked with distance; admin override with reason allows it', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const visitId = await makeVisit(h, f.parentId);
    const at = h.clock.now().toISOString();
    const r = await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'check_in', payload: { visitId, capturedAt: at, location: FAR, offline: false } }] });
    expect(r.body.results[0].status).toBe('rejected');
    expect(r.body.results[0].error).toBe('outside_radius');
    expect(r.body.results[0].details.distanceM).toBeGreaterThan(1500);
    expect(r.body.results[0].details.radiusM).toBe(150);
    // No location at all is also blocked.
    const r0 = await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'check_in', payload: { visitId, capturedAt: at, location: null, offline: false } }] });
    expect(r0.body.results[0].error).toBe('no_location');
    // Coordinators cannot override, admins can (with reason, logged).
    expect((await api(h, h.token('coordinator'), 'POST', `/admin/visits/${visitId}/check-in-override`, { reason: 'GPS drift in tower' })).status).toBe(403);
    expect((await api(h, h.token('admin'), 'POST', `/admin/visits/${visitId}/check-in-override`, { reason: 'GPS drift in tower' })).status).toBe(200);
    const r2 = await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'check_in', payload: { visitId, capturedAt: at, location: FAR, offline: false } }] });
    expect(r2.body.results[0].status).toBe('applied');
    const logged = (await h.owner.query(`select action, meta from audit_log where entity_id=$1 order by id`, [visitId])).rows.map((x) => x.action);
    expect(logged).toEqual(expect.arrayContaining(['visit.check_in_blocked', 'visit.check_in_override', 'visit.check_in']));
  });

  it('F15: without photo consent, photo upload and report-with-photos are refused; report without photos is fine', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId, false);
    const visitId = await makeVisit(h, f.parentId);
    expect((await api(h, h.token('nurse'), 'GET', `/field/visits/${visitId}`)).body.consent.photos).toBe(false);
    const up = await api(h, h.token('nurse'), 'POST', '/uploads', { purpose: 'visit_photo', parentId: f.parentId, visitId, contentType: 'image/jpeg' });
    expect(up.status).toBe(422);
    expect(up.body.error).toBe('no_photo_consent');
    const at = h.clock.now().toISOString();
    await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'check_in', payload: { visitId, capturedAt: at, location: NEAR, offline: false } }] });
    const bad = await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'report', payload: report(visitId, at, { photoKeys: [`visits/${visitId}/x.jpg`] }) }] });
    expect(bad.body.results[0].error).toBe('no_photo_consent');
    // Even a direct DB insert is blocked by the trigger.
    await expect(h.owner.query(`insert into visit_photos (visit_id, parent_id, storage_key) values ($1,$2,'k')`, [visitId, f.parentId])).rejects.toThrow('no_photo_consent');
    const ok = await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'report', payload: report(visitId, at) }] });
    expect(ok.body.results[0].status).toBe('applied');
  });

  it('F6: implausible vitals rejected; out-of-range → coordinator task; critical → automatic escalation', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const visitId = await makeVisit(h, f.parentId);
    const at = h.clock.now().toISOString();
    await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'check_in', payload: { visitId, capturedAt: at, location: NEAR, offline: false } }] });
    const typo = await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'report', payload: report(visitId, at, { vitals: [{ kind: 'pulse', value: 720, recordedAt: at }] }) }] });
    expect(typo.body.results[0].error).toBe('implausible_vitals');
    const crit = await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'report', payload: report(visitId, at, { vitals: [{ kind: 'bp_systolic', value: 195, recordedAt: at }, { kind: 'spo2', value: 95, recordedAt: at }] }) }] });
    expect(crit.body.results[0].status).toBe('applied');
    const task = (await h.owner.query(`select * from tasks where kind='visit_follow_up'`)).rows[0];
    expect(task.assignee_user_id).toBe(h.ids.coordinator);
    const e = (await h.owner.query(`select * from escalations where parent_id=$1`, [f.parentId])).rows;
    expect(e).toHaveLength(1);
    expect(e[0].trigger).toBe('critical_vitals');
    expect(e[0].note).toContain('bp_systolic=195');
  });

  it('F4: unverified staff cannot be assigned to visits', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const r = await api(h, h.token('admin'), 'POST', '/admin/visits', { parentId: f.parentId, type: 'nurse', staffId: h.ids.unverifiedNurse, scheduledAt: new Date(h.clock.now().getTime() + 3_600_000).toISOString(), durationMin: 45 });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('staff_not_verified');
    // Families see verification on the profile but never phone/ID numbers.
    const visitId = await makeVisit(h, f.parentId);
    const prof = await api(h, f.token, 'GET', `/parents/${f.parentId}/staff/${h.ids.nurse}`);
    expect(prof.body.verified).toBe(true);
    expect(prof.body.verification).toHaveLength(4);
    expect(JSON.stringify(prof.body)).not.toMatch(/\+20|phone/);
    expect(visitId).toBeTruthy();
  });

  it('RLS: staff only see assigned families; families only their own', async () => {
    const a = await newFamily(h, '+966500000001');
    const b = await newFamily(h, '+971500000002');
    await activate(h, a.parentId);
    await activate(h, b.parentId);
    expect((await api(h, a.token, 'GET', `/parents/${b.parentId}`)).status).toBe(403);
    expect((await api(h, a.token, 'GET', `/parents/${b.parentId}/timeline`)).status).toBe(403);
    expect((await api(h, h.token('otherNurse'), 'GET', `/parents/${a.parentId}`)).status).toBe(403);
    await makeVisit(h, a.parentId, 'otherNurse');
    expect((await api(h, h.token('otherNurse'), 'GET', `/parents/${a.parentId}`)).status).toBe(200);
    expect((await api(h, h.token('otherNurse'), 'GET', `/parents/${b.parentId}`)).status).toBe(403);
    // Listing is filtered by RLS too.
    const list = await api(h, a.token, 'GET', '/parents');
    expect(list.body.items.map((x: any) => x.id)).toEqual([a.parentId]);
    // Staff reads are audited.
    const reads = (await h.owner.query(`select count(*)::int n from audit_log where action='parent.read' and actor_user_id=$1`, [h.ids.otherNurse])).rows[0].n;
    expect(reads).toBe(1);
  });
});
