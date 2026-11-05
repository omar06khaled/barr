import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { activate, api, makeHarness, newFamily, signInPhone, uuid, type Harness } from './harness';

let h: Harness;
// 2026-11-05 05:00 UTC = 07:00 Cairo
beforeEach(async () => { if (h) await h.close(); h = await makeHarness(new Date('2026-11-05T05:00:00Z')); });
afterAll(async () => { await h.close(); });

async function setup() {
  const f = await newFamily(h);
  await activate(h, f.parentId);
  const m = await api(h, h.token('coordinator'), 'POST', '/medications', { parentId: f.parentId, name: 'Amlodipine', doseText: '5 mg tablet', timesOfDay: ['08:00', '20:00'], startDate: '2026-11-01', endDate: null, instructions: 'After breakfast' });
  expect(m.status).toBe(200);
  const doses = (await h.owner.query(`select * from dose_events where parent_id=$1 order by scheduled_at`, [f.parentId])).rows;
  return { f, doses };
}
const tasks = async (kind: string) => (await h.owner.query(`select * from tasks where kind=$1`, [kind])).rows;
const notifs = async (type: string) => (await h.owner.query(`select * from notifications where type=$1`, [type])).rows;

describe('F7 missed-dose flow', () => {
  it('generates today + tomorrow doses idempotently', async () => {
    const { f, doses } = await setup();
    expect(doses.map((d) => d.scheduled_at.toISOString())).toEqual(['2026-11-05T06:00:00.000Z', '2026-11-05T18:00:00.000Z', '2026-11-06T06:00:00.000Z', '2026-11-06T18:00:00.000Z']);
    // Nightly job for the same date creates nothing new.
    await h.owner.query(`insert into jobs (name, payload, run_at) values ('doses.generate_parent', $1, $2)`, [{ parentId: f.parentId, date: '2026-11-06' }, h.clock.now()]);
    await h.worker.drain(h.clock.now());
    expect((await h.owner.query(`select count(*)::int n from dose_events where parent_id=$1`, [f.parentId])).rows[0].n).toBe(4);
  });

  it('unconfirmed at +60 min → coordinator alert (task + push); unresolved at +3 h → family notified', async () => {
    const { f, doses } = await setup();
    const d0 = doses[0];
    h.clock.set(new Date(d0.scheduled_at.getTime() + 59 * 60_000));
    await h.worker.drain(h.clock.now());
    expect(await tasks('missed_dose')).toHaveLength(0);

    h.clock.set(new Date(d0.scheduled_at.getTime() + 60 * 60_000));
    await h.worker.drain(h.clock.now());
    const t = await tasks('missed_dose');
    expect(t).toHaveLength(1);
    expect(t[0].assignee_user_id).toBe(h.ids.coordinator);
    expect((await notifs('missed_dose')).map((n) => n.recipient_user_id)).toEqual([h.ids.coordinator]);
    expect((await h.owner.query(`select status from dose_events where id=$1`, [d0.id])).rows[0].status).toBe('missed');

    h.clock.set(new Date(d0.scheduled_at.getTime() + 180 * 60_000));
    await h.worker.drain(h.clock.now());
    const fam = (await notifs('missed_dose')).filter((n) => n.recipient_user_id === f.userId);
    expect(fam).toHaveLength(1);
    expect(fam[0].body).toContain('Amlodipine');
    await h.relogin();
    const today = await api(h, h.token('admin'), 'GET', '/admin/today');
    expect(today.body.missedDoses.map((x: any) => x.id)).toContain(d0.id);
  });

  it('late confirmation (after coordinator alert, before 3 h) resolves it: no family message; task closed', async () => {
    const { f, doses } = await setup();
    const d0 = doses[0];
    h.clock.set(new Date(d0.scheduled_at.getTime() + 61 * 60_000));
    await h.worker.drain(h.clock.now());
    await h.relogin();
    // Caregiver gets assigned via a shift → can confirm via offline sync op.
    const shift = await api(h, h.token('admin'), 'POST', '/admin/visits', { parentId: f.parentId, type: 'caregiver_shift', staffId: h.ids.caregiver, scheduledAt: h.clock.now().toISOString(), durationMin: 480 });
    expect(shift.status).toBe(200);
    const r = await api(h, h.token('caregiver'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'dose_confirm', payload: { doseId: d0.id, status: 'confirmed', capturedAt: h.clock.now().toISOString(), method: 'parent_phone', note: 'Took it late after breakfast' } }] });
    expect(r.body.results[0].status).toBe('applied');
    expect((await tasks('missed_dose'))[0].status).toBe('done');
    h.clock.set(new Date(d0.scheduled_at.getTime() + 181 * 60_000));
    await h.worker.drain(h.clock.now());
    expect((await notifs('missed_dose')).filter((n) => n.recipient_user_id === f.userId)).toHaveLength(0);
    f.token = (await signInPhone(h.app, '+966501234567')).accessToken;
    const today = await api(h, f.token, 'GET', `/parents/${f.parentId}/doses/today`);
    expect(today.body.items.map((x: any) => x.status)).toEqual(['confirmed', 'scheduled']);
  });

  it('confirmed on time → never alerted; skip requires a note', async () => {
    const { f, doses } = await setup();
    await api(h, h.token('admin'), 'POST', '/admin/visits', { parentId: f.parentId, type: 'nurse', staffId: h.ids.nurse, scheduledAt: h.clock.now().toISOString(), durationMin: 30 });
    const noNote = await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'dose_confirm', payload: { doseId: doses[1].id, status: 'skipped', capturedAt: h.clock.now().toISOString(), method: 'nurse' } }] });
    expect(noNote.body.results[0].error).toBe('skip_note_required');
    await api(h, h.token('nurse'), 'POST', '/field/sync', { ops: [{ opId: uuid(), kind: 'dose_confirm', payload: { doseId: doses[0].id, status: 'confirmed', capturedAt: h.clock.now().toISOString(), method: 'nurse' } }] });
    h.clock.set(new Date(doses[0].scheduled_at.getTime() + 4 * 3_600_000));
    await h.worker.drain(h.clock.now());
    expect(await tasks('missed_dose')).toHaveLength(0);
  });
});
