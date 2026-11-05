import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { activate, api, makeHarness, newFamily, type Harness } from './harness';

let h: Harness;
beforeEach(async () => { if (h) await h.close(); h = await makeHarness(); });
afterAll(async () => { await h.close(); });

const esc = async (id: string) => (await h.owner.query(`select * from escalations where id=$1`, [id])).rows[0];
const events = async (id: string) => (await h.owner.query(`select kind from escalation_events where escalation_id=$1 order by at, kind`, [id])).rows.map((r) => r.kind);
const notifs = async (type: string) => (await h.owner.query(`select n.*, u.first_name from notifications n join users u on u.id=n.recipient_user_id where type=$1 order by created_at`, [type])).rows;

describe('F8 escalation timers (2 min / 15 min) — enforced by the job queue', () => {
  it('family "Get help now": doctor + coordinator paged at once; unacknowledged at 2 min → phone call + backup paged', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const r = await api(h, f.token, 'POST', '/escalations', { parentId: f.parentId, severity: 'urgent', note: 'Mum fell in the bathroom' });
    expect(r.status).toBe(200);
    const id = r.body.id;
    const e0 = await esc(id);
    expect(e0.trigger).toBe('family_help');
    expect(e0.family_notified_at).not.toBeNull(); // immediate confirmation to family

    await h.worker.drain(h.clock.now());
    const paged = await notifs('escalation_page_staff');
    expect(new Set(paged.map((n) => n.first_name))).toEqual(new Set(['doctor', 'coordinator']));
    expect(paged.every((n) => n.status === 'sent')).toBe(true);
    expect(h.calls.sent).toHaveLength(0);

    // 1 min 59 s: nothing more happens.
    h.clock.advanceMs(119_000);
    await h.worker.drain(h.clock.now());
    expect(h.calls.sent).toHaveLength(0);
    expect((await esc(id)).backup_paged_at).toBeNull();

    // 2 min: call the on-call doctor and page backup.
    h.clock.advanceMs(1_000);
    await h.worker.drain(h.clock.now());
    expect(h.calls.sent).toHaveLength(1);
    expect(h.calls.sent[0]!.to).toBe('+201000000004');
    const backup = (await notifs('escalation_page_staff')).filter((n) => n.first_name === 'backupDoctor');
    expect(backup.map((n) => n.channel).sort()).toEqual(['push', 'sms', 'whatsapp']);
    expect((await esc(id)).backup_paged_at).not.toBeNull();
    expect(await events(id)).toEqual(expect.arrayContaining(['created', 'staff_paged', 'family_notified', 'call_placed', 'backup_paged']));

    // Running the 2-min job again (retry) must not page twice.
    await h.owner.query(`update jobs set status='queued' where name='escalation.ack_check'`);
    await h.worker.drain(h.clock.now());
    expect(h.calls.sent).toHaveLength(1);
  });

  it('acknowledged within 2 min → no backup paging; family still told by 15 min for staff-raised escalations', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const r = await api(h, h.token('nurse'), 'POST', '/escalations', { parentId: f.parentId, severity: 'urgent' });
    // nurse has no assignment for this parent yet → forbidden
    expect(r.status).toBe(403);
    const r2 = await api(h, h.token('coordinator'), 'POST', '/escalations', { parentId: f.parentId, severity: 'urgent', note: 'Confused and agitated' });
    expect(r2.status).toBe(200);
    const id = r2.body.id;
    expect((await esc(id)).family_notified_at).toBeNull();

    h.clock.advanceMs(60_000);
    expect((await api(h, h.token('nurse'), 'POST', `/escalations/${id}/acknowledge`)).status).toBe(403); // nurses cannot acknowledge
    const ack = await api(h, h.token('doctor'), 'POST', `/escalations/${id}/acknowledge`);
    expect(ack.status).toBe(200);
    // Acknowledgement update counts as telling the family.
    expect((await esc(id)).family_notified_at).not.toBeNull();

    h.clock.advanceMs(120_000);
    await h.worker.drain(h.clock.now());
    expect(h.calls.sent).toHaveLength(0);
    expect((await esc(id)).backup_paged_at).toBeNull();
  });

  it('15-minute family notification fires automatically if nobody has updated the family', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const t0 = h.clock.now();
    const r = await api(h, h.token('coordinator'), 'POST', '/escalations', { parentId: f.parentId, severity: 'urgent' });
    const id = r.body.id;
    h.clock.advanceMs(14 * 60_000 + 59_000);
    await h.worker.drain(h.clock.now());
    expect((await esc(id)).family_notified_at).toBeNull();
    expect(await notifs('escalation_family_15min')).toHaveLength(0);
    h.clock.advanceMs(1_000);
    await h.worker.drain(h.clock.now());
    const e = await esc(id);
    expect(e.family_notified_at.getTime() - t0.getTime()).toBeLessThanOrEqual(15 * 60_000);
    const n = await notifs('escalation_family_15min');
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain('Fatma');
    expect(n[0].language).toBe('ar');
  });

  it('full flow: decision → follow-up → close requires a note; family sees live card; audit trail exists', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    const id = (await api(h, f.token, 'POST', '/escalations', { parentId: f.parentId })).body.id;
    expect((await api(h, h.token('doctor'), 'POST', `/escalations/${id}/decision`, { decision: 'nurse_dispatched', note: 'Check BP and bruising' })).status).toBe(200);
    expect((await api(h, h.token('coordinator'), 'POST', `/escalations/${id}/follow-up`, { note: 'Nurse arrived 11:20', visibleToFamily: true })).status).toBe(200);
    expect((await api(h, h.token('coordinator'), 'POST', `/escalations/${id}/close`, { note: '' })).status).toBe(400);
    expect((await api(h, h.token('coordinator'), 'POST', `/escalations/${id}/close`, { note: 'Minor bruise, BP normal. Rails to be installed.' })).status).toBe(200);
    const card = await api(h, f.token, 'GET', `/escalations/${id}`);
    expect(card.status).toBe(200);
    expect(card.body.status).toBe('closed');
    expect(card.body.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['created', 'acknowledged', 'decision', 'follow_up', 'closed']));
    expect(card.body.events.map((e: any) => e.kind)).not.toContain('backup_paged'); // internal events hidden from family
    const audit = (await h.owner.query(`select action from audit_log where entity_id=$1 order by id`, [id])).rows.map((r) => r.action);
    expect(audit).toEqual(['escalation.create', 'escalation.decision', 'escalation.close']);
    // Status card goes back from alert.
    const st = await api(h, f.token, 'GET', `/parents/${f.parentId}/status`);
    expect(st.body.status).not.toBe('alert');
  });

  it('open escalation turns daily status red ("Alert open") and shows on top of dashboard with age', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    await api(h, f.token, 'POST', '/escalations', { parentId: f.parentId });
    expect((await api(h, f.token, 'GET', `/parents/${f.parentId}/status`)).body.status).toBe('alert');
    h.clock.advanceMs(5 * 60_000);
    const today = await api(h, h.token('admin'), 'GET', '/admin/today');
    expect(today.body.openEscalations).toHaveLength(1);
    expect(today.body.openEscalations[0].age_s).toBe(300);
  });

  it('push failure to staff falls back to SMS', async () => {
    const f = await newFamily(h);
    await activate(h, f.parentId);
    await h.owner.query(`delete from push_tokens where user_id=$1`, [h.ids.doctor]);
    await api(h, f.token, 'POST', '/escalations', { parentId: f.parentId });
    await h.worker.drain(h.clock.now());
    const doc = (await notifs('escalation_page_staff')).filter((n) => n.first_name === 'doctor');
    expect(doc.find((n) => n.channel === 'push')?.status).toBe('failed');
    expect(doc.find((n) => n.channel === 'sms')?.status).toBe('sent');
  });
});
