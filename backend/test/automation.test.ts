import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cronSpecs } from '../src/jobs/register';
import { NEAR, activate, api, makeHarness, makeVisit, newFamily, signInPhone, uuid, type Harness } from './harness';

let h: Harness;
// Thursday 2026-11-05 07:00 Cairo
beforeEach(async () => { if (h) await h.close(); h = await makeHarness(new Date('2026-11-05T05:00:00Z')); });
afterAll(async () => { await h.close(); });

const carePlan = (staff: Record<string, string>) => ({
  visitRules: [
    { type: 'nurse', freq: 'weekly', weekdays: [0, 3], time: '10:00', durationMin: 45, staffUserId: staff.nurse },
    { type: 'coordinator', freq: 'biweekly', weekday: 4, anchorDate: '2026-11-05', time: '16:00', durationMin: 60, staffUserId: staff.coordinator },
    { type: 'doctor', freq: 'monthly', dayOfMonth: 15, time: '12:00', durationMin: 30, staffUserId: staff.doctor },
  ],
  goals: [{ en: 'Keep blood pressure under 140/90', ar: 'الحفاظ على ضغط الدم أقل من 140/90' }],
  included: [{ en: 'Weekly nurse visit', ar: 'زيارة تمريض أسبوعية' }],
  notIncluded: [{ en: 'Hospital costs', ar: 'تكاليف المستشفى' }],
  carerPreferences: { gender: 'female', languages: ['ar'] },
});

describe('F10 care plan → §10 visit generation', () => {
  it('publishing creates a version needing acceptance; visits for 14 days generated idempotently with reminders and no-show checks', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const pub = await api(h, h.token('coordinator'), 'POST', `/admin/parents/${f.parentId}/care-plans`, { content: carePlan(h.ids) });
    expect(pub.status).toBe(200);
    expect(pub.body.version).toBe(1);
    await h.worker.drain(h.clock.now());
    const visits = (await h.owner.query(`select type, scheduled_at, staff_user_id from visits where parent_id=$1 and status='scheduled' order by scheduled_at`, [f.parentId])).rows;
    // nurse: Sun 8, Wed 11, Sun 15, Wed 18 ; coordinator: Thu 5 16:00 ; doctor: 15th
    expect(visits.filter((v) => v.type === 'nurse')).toHaveLength(4);
    expect(visits.filter((v) => v.type === 'coordinator').map((v) => v.scheduled_at.toISOString())).toEqual(['2026-11-05T14:00:00.000Z']);
    expect(visits.filter((v) => v.type === 'doctor')).toHaveLength(1);
    expect(visits.every((v) => v.staff_user_id)).toBe(true);
    const reminders = (await h.owner.query(`select count(*)::int n from jobs where name='visit.reminder'`)).rows[0].n;
    expect(reminders).toBe(visits.length);
    // Nightly regeneration doesn't duplicate.
    await h.worker.tickCron(new Date('2026-11-05T23:30:00Z'), cronSpecs(h.d).filter((s) => s.name === 'visits.generate_all'));
    await h.worker.drain(new Date('2026-11-05T23:30:00Z'));
    const after = (await h.owner.query(`select count(*)::int n from visits where parent_id=$1 and status='scheduled'`, [f.parentId])).rows[0].n;
    expect(after).toBeGreaterThanOrEqual(visits.length - 1); // one may now be in the past; none duplicated
    expect((await h.owner.query(`select count(*)::int n from (select scheduled_at, type from visits where parent_id=$1 group by 1,2 having count(*) > 1) x`, [f.parentId])).rows[0].n).toBe(0);

    // Family accepts v1; publishing v2 requires re-acceptance; v1 stays viewable.
    expect((await api(h, f.token, 'POST', `/care-plans/${pub.body.id}/accept`)).status).toBe(200);
    const pub2 = await api(h, h.token('coordinator'), 'POST', `/admin/parents/${f.parentId}/care-plans`, { content: { ...carePlan(h.ids), visitRules: carePlan(h.ids).visitRules.slice(0, 1) } });
    const plans = await api(h, f.token, 'GET', `/parents/${f.parentId}/care-plans`);
    expect(plans.body.items.map((p: any) => [p.version, p.status, p.acceptances.length])).toEqual([[2, 'published', 0], [1, 'superseded', 1]]);
    expect((await api(h, f.token, 'POST', `/care-plans/${pub.body.id}/accept`)).status).toBe(409);
    await h.worker.drain(h.clock.now());
    // v1-only visits (coordinator/doctor) cancelled when v2 drops them.
    const live = (await h.owner.query(`select distinct type from visits where parent_id=$1 and status='scheduled'`, [f.parentId])).rows.map((r) => r.type);
    expect(live).toEqual(['nurse']);
    expect(pub2.body.version).toBe(2);
  });
});

describe('§10 no-show', () => {
  it('scheduled + 30 min without check-in → coordinator task; family told after CONFIG time; caregiver no-show escalates', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const at = new Date('2026-11-05T06:00:00Z');
    const visitId = await makeVisit(h, f.parentId, 'caregiver', 'caregiver_shift', at);
    h.clock.set(new Date(at.getTime() + 29 * 60_000));
    await h.worker.drain(h.clock.now());
    expect((await h.owner.query(`select count(*)::int n from tasks where kind='no_show'`)).rows[0].n).toBe(0);
    h.clock.set(new Date(at.getTime() + 30 * 60_000));
    await h.worker.drain(h.clock.now());
    expect((await h.owner.query(`select count(*)::int n from tasks where kind='no_show'`)).rows[0].n).toBe(1);
    const esc = (await h.owner.query(`select trigger from escalations where parent_id=$1`, [f.parentId])).rows;
    expect(esc.map((e) => e.trigger)).toEqual(['caregiver_no_show']);
    h.clock.set(new Date(at.getTime() + 90 * 60_000));
    await h.worker.drain(h.clock.now());
    expect((await h.owner.query(`select count(*)::int n from notifications where type='no_show' and recipient_user_id=$1`, [f.userId])).rows[0].n).toBeGreaterThan(0);
    expect(visitId).toBeTruthy();
  });

  it('check-in within grace → no task', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const at = new Date('2026-11-05T06:00:00Z');
    const visitId = await makeVisit(h, f.parentId, 'nurse', 'nurse', at);
    h.clock.set(new Date(at.getTime() + 10 * 60_000));
    await h.relogin();
    await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'check_in', payload: { visitId, capturedAt: h.clock.now().toISOString(), location: NEAR, offline: false } }] });
    h.clock.set(new Date(at.getTime() + 60 * 60_000));
    await h.worker.drain(h.clock.now());
    expect((await h.owner.query(`select count(*)::int n from tasks where kind='no_show'`)).rows[0].n).toBe(0);
  });
});

describe('F3 daily status at 18:00 Egypt time', () => {
  it('no contact → amber + coordinator task + daily summary; contact → green', async () => {
    const a = await newFamily(h, '+966500000011');
    const b = await newFamily(h, '+966500000022');
    await activate(h, a.parentId);
    await activate(h, b.parentId);
    // b gets a visit check-in today.
    const v = await makeVisit(h, b.parentId, 'nurse', 'nurse', new Date('2026-11-05T08:00:00Z'));
    h.clock.set(new Date('2026-11-05T08:05:00Z'));
    await h.relogin();
    a.token = (await signInPhone(h.app, '+966500000011')).accessToken;
    await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'check_in', payload: { visitId: v, capturedAt: h.clock.now().toISOString(), location: NEAR, offline: false } }] });
    expect((await api(h, a.token, 'GET', `/parents/${a.parentId}/status`)).body.status).toBe('pending');

    const six = new Date('2026-11-05T16:00:00Z'); // 18:00 Cairo (UTC+2 in November)
    h.clock.set(six);
    await h.worker.tickCron(six, cronSpecs(h.d).filter((s) => s.name === 'status.daily_all'));
    await h.worker.drain(six);
    const ta = (await signInPhone(h.app, '+966500000011')).accessToken;
    expect((await api(h, ta, 'GET', `/parents/${a.parentId}/status`)).body.status).toBe('no_contact');
    const tasks = (await h.owner.query(`select parent_id, assignee_user_id from tasks where kind='no_contact'`)).rows;
    expect(tasks).toEqual([{ parent_id: a.parentId, assignee_user_id: h.ids.coordinator }]);
    const summaries = (await h.owner.query(`select recipient_user_id, body from notifications where type='daily_status' order by body`)).rows;
    expect(summaries).toHaveLength(2);
    expect(summaries.find((s) => s.recipient_user_id === a.userId)!.body).toContain('لا يوجد تواصل بعد');
    expect(summaries.find((s) => s.recipient_user_id === b.userId)!.body).toContain('تمت الاطمئنان اليوم');
    // Cron tick again the same day → no duplicates.
    await h.worker.tickCron(new Date('2026-11-05T17:00:00Z'), cronSpecs(h.d).filter((s) => s.name === 'status.daily_all'));
    await h.worker.drain(new Date('2026-11-05T17:00:00Z'));
    expect((await h.owner.query(`select count(*)::int n from notifications where type='daily_status'`)).rows[0].n).toBe(2);
  });
});

describe('F11 concerns', () => {
  it('reference + deadline; staff conduct → safety flag + admin alerted now; overdue surfaced; resolve + reopen within 7 days', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const c1 = await api(h, f.token, 'POST', '/concerns', { parentId: f.parentId, category: 'staff_conduct', text: 'Carer was on the phone the whole visit' });
    expect(c1.status).toBe(200);
    expect(c1.body.ref).toMatch(/^C-2611-/);
    expect(c1.body.safety).toBe(true);
    expect(new Date(c1.body.deadline).getTime() - h.clock.now().getTime()).toBe(4 * 3_600_000);
    await h.worker.drain(h.clock.now());
    const adminAlert = (await h.owner.query(`select * from notifications where type='concern_update' and recipient_user_id=$1`, [h.ids.admin])).rows;
    expect(adminAlert.length).toBeGreaterThan(0);

    h.clock.advanceMs(4 * 3_600_000 + 60_000);
    await h.worker.tickCron(h.clock.now(), cronSpecs(h.d).filter((s) => s.name === 'concerns.deadlines'));
    await h.worker.drain(h.clock.now());
    expect((await h.owner.query(`select overdue_notified_at from concerns where id=$1`, [c1.body.id])).rows[0].overdue_notified_at).not.toBeNull();
    await h.relogin();
    const today = await api(h, h.token('admin'), 'GET', '/admin/today');
    expect(today.body.concerns[0]).toMatchObject({ id: c1.body.id, overdue: true });

    expect((await api(h, h.token('coordinator'), 'POST', `/admin/concerns/${c1.body.id}`, { status: 'resolved' })).status).toBe(400);
    expect((await api(h, h.token('coordinator'), 'POST', `/admin/concerns/${c1.body.id}`, { status: 'resolved', resolution: 'Spoke with carer; replaced for future visits' })).status).toBe(200);
    h.clock.advanceMs(6 * 86_400_000);
    const ft = (await signInPhone(h.app, '+966501234567')).accessToken;
    expect((await api(h, ft, 'POST', `/concerns/${c1.body.id}/reopen`, { reason: 'Same carer came again' })).status).toBe(200);
    expect((await api(h, h.token('coordinator'), 'GET', `/parents/${f.parentId}`)).status).toBeLessThan(500);
  });
});

describe('F14 monthly report, F18 help line, F13 replacement', () => {
  it('monthly report on the 1st for previous month, bilingual, notified', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const v = await makeVisit(h, f.parentId, 'nurse', 'nurse', new Date('2026-11-05T08:00:00Z'));
    h.clock.set(new Date('2026-11-05T08:01:00Z'));
    await h.relogin();
    const at = h.clock.now().toISOString();
    await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [
      { opId: uuid(), kind: 'check_in', payload: { visitId: v, capturedAt: at, location: NEAR, offline: false } },
      { opId: uuid(), kind: 'report', payload: { visitId: v, submittedAt: at, observations: { mood: 4 }, vitals: [{ kind: 'pulse', value: 72, recordedAt: at }], tasksDone: [], note: '', photoKeys: [] } },
    ] });
    const first = new Date('2026-12-01T06:30:00Z'); // 08:30 Cairo on the 1st
    h.clock.set(first);
    await h.worker.tickCron(first, cronSpecs(h.d).filter((s) => s.name === 'reports.monthly_all'));
    await h.worker.drain(first);
    const reps = (await h.owner.query(`select * from reports where type='monthly'`)).rows;
    expect(reps).toHaveLength(1);
    expect(reps[0].period_start).toBe('2026-11-01');
    expect(reps[0].generator).toBe('template_v1');
    expect(reps[0].structured_input.visitsCompleted).toBe(1);
    expect(reps[0].rendered_en).toContain('Visits: 1 of 1');
    expect(reps[0].rendered_ar).toContain('الزيارات');
    expect((await h.owner.query(`select count(*)::int n from notifications where type='monthly_report'`)).rows[0].n).toBe(1);
  });

  it('help line: desk logs a call and converts it to an escalation in one click', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const r = await api(h, h.token('coordinator'), 'POST', '/admin/helpline', { parentId: f.parentId, callerName: 'Neighbour Hoda', summary: 'Heard a fall, no answer at door', convertToEscalation: true });
    expect(r.status).toBe(200);
    expect(r.body.escalationId).toBeTruthy();
    const again = await api(h, h.token('coordinator'), 'POST', `/admin/helpline/${r.body.id}/escalate`);
    expect(again.body.escalationId).toBe(r.body.escalationId);
  });

  it('replacement request → coordinator task with 48 h target → resolve swaps carer, history kept', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    await makeVisit(h, f.parentId, 'nurse');
    const rr = await api(h, f.token, 'POST', `/parents/${f.parentId}/replacement-requests`, { staffUserId: h.ids.nurse, reason: 'Language mismatch' });
    expect(rr.status).toBe(200);
    expect(new Date(rr.body.targetAt).getTime() - h.clock.now().getTime()).toBe(48 * 3_600_000);
    expect((await h.owner.query(`select count(*)::int n from tasks where kind='replacement'`)).rows[0].n).toBe(1);
    expect((await api(h, h.token('coordinator'), 'POST', `/admin/replacements/${rr.body.id}/resolve`, { newStaffUserId: h.ids.otherNurse })).status).toBe(200);
    const team = await api(h, f.token, 'GET', `/parents/${f.parentId}/care-team`);
    const nurse = team.body.items.find((x: any) => x.user_id === h.ids.nurse);
    expect(nurse.ended_at).not.toBeNull();
    expect(team.body.items.find((x: any) => x.user_id === h.ids.otherNurse).ended_at).toBeNull();
  });
});

describe('jobs view and audit log (dashboard)', () => {
  it('admin sees job summary and audit log; coordinators cannot read audit', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    await api(h, f.token, 'POST', '/escalations', { parentId: f.parentId });
    await h.worker.drain(h.clock.now());
    const jobs = await api(h, h.token('admin'), 'GET', '/admin/jobs');
    expect(jobs.status).toBe(200);
    expect(jobs.body.items.length).toBeGreaterThan(0);
    expect((await api(h, h.token('coordinator'), 'GET', '/admin/audit')).status).toBe(403);
    const audit = await api(h, h.token('admin'), 'GET', `/admin/audit?parentId=${f.parentId}`);
    expect(audit.body.items.map((x: any) => x.action)).toEqual(expect.arrayContaining(['parent.create', 'consent.record']));
    // The app DB role cannot rewrite history.
    await expect(h.d.db.system((c) => c.query(`delete from audit_log`))).rejects.toThrow();
  });
});
