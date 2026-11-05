import { describe, expect, it } from 'vitest';
import {
  computeDailyStatus, checkInDecision, distanceM, assessVital, defaultConfig, can, toE164, escalationTimerPlan, canTransition,
  validateClose, concernDeadline, isSafetyConcern, canReopen, dosesForDate, missedDoseStage, adherenceRate, planVisits,
  groupRoute, isNoShow, subscriptionPrice, buildInvoiceLines, invoiceTotal, retrySchedule, statusAfterFailedAttempt, addMonth,
  zonedTimeToUtc, localParts, churnRisk, templateVisitReportGenerator, templateMonthlyReportGenerator, translate, en, ar,
  notificationTemplates, NOTIFICATION_TYPES, isOverdue,
} from '../src';

const TZ = 'Africa/Cairo';
const cairo = (date: string, hhmm: string) => zonedTimeToUtc(date, hhmm, TZ);

describe('time', () => {
  it('converts Cairo local time to UTC, both standard and DST', () => {
    expect(cairo('2026-01-15', '18:00').toISOString()).toBe('2026-01-15T16:00:00.000Z'); // UTC+2
    expect(cairo('2026-07-15', '18:00').toISOString()).toBe('2026-07-15T15:00:00.000Z'); // UTC+3 (DST)
    expect(localParts(new Date('2026-01-15T22:30:00Z'), TZ).date).toBe('2026-01-16');
  });
});

describe('F3 daily status', () => {
  const base = { timezone: TZ, noContactAfter: '18:00', contactTimes: [] as Date[], openEscalation: false };
  it('is pending before 18:00 with no contact, amber after', () => {
    expect(computeDailyStatus({ ...base, now: cairo('2026-11-05', '17:59') })).toBe('pending');
    expect(computeDailyStatus({ ...base, now: cairo('2026-11-05', '18:00') })).toBe('no_contact');
  });
  it('is checked when contact happened today (local date)', () => {
    expect(computeDailyStatus({ ...base, now: cairo('2026-11-05', '19:00'), contactTimes: [cairo('2026-11-05', '09:00')] })).toBe('checked');
    // yesterday's contact doesn't count
    expect(computeDailyStatus({ ...base, now: cairo('2026-11-05', '19:00'), contactTimes: [cairo('2026-11-04', '23:30')] })).toBe('no_contact');
  });
  it('alert overrides everything', () => {
    expect(computeDailyStatus({ ...base, now: cairo('2026-11-05', '10:00'), contactTimes: [cairo('2026-11-05', '09:00')], openEscalation: true })).toBe('alert');
  });
});

describe('F5 geofence', () => {
  const home = { lat: 30.0444, lng: 31.2357 };
  it('allows within 150 m and blocks outside', () => {
    expect(checkInDecision({ staff: { lat: 30.0450, lng: 31.2360 }, home, radiusM: 150 }).allowed).toBe(true);
    const far = checkInDecision({ staff: { lat: 30.06, lng: 31.2357 }, home, radiusM: 150 });
    expect(far.allowed).toBe(false);
    expect(far.allowed === false && far.reason).toBe('outside_radius');
  });
  it('blocks without location; admin override with reason allows', () => {
    expect(checkInDecision({ staff: null, home, radiusM: 150 }).allowed).toBe(false);
    const o = checkInDecision({ staff: { lat: 31, lng: 31 }, home, radiusM: 150, adminOverrideReason: 'GPS drift in tower block' });
    expect(o.allowed && o.overridden).toBe(true);
    expect(checkInDecision({ staff: { lat: 31, lng: 31 }, home, radiusM: 150, adminOverrideReason: '  ' }).allowed).toBe(false);
  });
  it('haversine sanity', () => {
    expect(Math.round(distanceM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) / 1000)).toBe(111);
  });
});

describe('F6 vitals', () => {
  const c = defaultConfig.vitalsCritical;
  it('flags implausible, out of range and critical', () => {
    expect(assessVital('pulse', 500, c).plausible).toBe(false);
    expect(assessVital('pulse', 72, c)).toMatchObject({ plausible: true, outOfRange: false, critical: false });
    expect(assessVital('bp_systolic', 165, c)).toMatchObject({ outOfRange: true, critical: false });
    expect(assessVital('bp_systolic', 190, c)).toMatchObject({ outOfRange: true, critical: true });
    expect(assessVital('spo2', 86, c).critical).toBe(true);
    expect(assessVital('glucose', 50, c).critical).toBe(true);
  });
});

describe('roles/permissions', () => {
  it('family members have equal plan/payment/invite rights', () => {
    expect(can(['family'], 'plan.manage')).toBe(true);
    expect(can(['family'], 'payment.manage')).toBe(true);
    expect(can(['family'], 'family.invite')).toBe(true);
    expect(can(['family'], 'refund.issue')).toBe(false);
  });
  it('only doctors and admins acknowledge escalations; refunds admin only', () => {
    expect(can(['nurse'], 'escalation.acknowledge')).toBe(false);
    expect(can(['oncall_doctor'], 'escalation.acknowledge')).toBe(true);
    expect(can(['coordinator'], 'refund.issue')).toBe(false);
    expect(can(['admin'], 'refund.issue')).toBe(true);
    expect(can(['caregiver'], 'timeline.view')).toBe(false);
  });
});

describe('phone E.164', () => {
  it('normalises Gulf and Egyptian numbers', () => {
    expect(toE164('+966 50 123 4567')).toBe('+966501234567');
    expect(toE164('00971501234567')).toBe('+971501234567');
    expect(toE164('+965 5123 4567')).toBe('+96551234567');
    expect(toE164('01012345678', 'EG')).toBe('+201012345678');
    expect(toE164('123')).toBeNull();
  });
});

describe('F8 escalation', () => {
  it('plans 2-min and 15-min timers', () => {
    const t0 = new Date('2026-11-05T10:00:00Z');
    const plan = escalationTimerPlan(t0, defaultConfig);
    expect(plan[0]).toEqual({ job: 'escalation.ack_check', runAt: new Date('2026-11-05T10:02:00Z') });
    expect(plan[1]).toEqual({ job: 'escalation.family_notify', runAt: new Date('2026-11-05T10:15:00Z') });
  });
  it('state machine and closing note', () => {
    expect(canTransition('open', 'acknowledged')).toBe(true);
    expect(canTransition('closed', 'open')).toBe(false);
    expect(validateClose('')).toBe('closing_note_required');
    expect(validateClose('Doctor advised rest; stable')).toBeNull();
  });
});

describe('F11 concerns', () => {
  const t0 = new Date('2026-11-05T10:00:00Z');
  it('deadlines: urgent 4h, normal 24h, safety treated urgent', () => {
    expect(concernDeadline(t0, 'urgent', false, defaultConfig).toISOString()).toBe('2026-11-05T14:00:00.000Z');
    expect(concernDeadline(t0, 'normal', false, defaultConfig).toISOString()).toBe('2026-11-06T10:00:00.000Z');
    expect(isSafetyConcern('staff_conduct')).toBe(true);
    expect(concernDeadline(t0, 'normal', true, defaultConfig).toISOString()).toBe('2026-11-05T14:00:00.000Z');
  });
  it('overdue and reopen within 7 days', () => {
    expect(isOverdue({ status: 'open', deadline: t0 }, new Date(t0.getTime() + 1))).toBe(true);
    expect(isOverdue({ status: 'resolved', deadline: t0 }, new Date(t0.getTime() + 1))).toBe(false);
    expect(canReopen({ status: 'resolved', resolvedAt: t0 }, new Date(t0.getTime() + 6 * 86400000), 7)).toBe(true);
    expect(canReopen({ status: 'resolved', resolvedAt: t0 }, new Date(t0.getTime() + 8 * 86400000), 7)).toBe(false);
  });
});

describe('F7 doses', () => {
  const med = { id: 'm1', timesOfDay: ['20:00', '08:00', '08:00'], startDate: '2026-11-01', endDate: '2026-11-30', active: true };
  it('generates deduplicated, sorted doses within date range', () => {
    const d = dosesForDate(med, '2026-11-05', TZ);
    expect(d.map((x) => x.scheduledAt.toISOString())).toEqual(['2026-11-05T06:00:00.000Z', '2026-11-05T18:00:00.000Z']);
    expect(dosesForDate(med, '2026-12-01', TZ)).toEqual([]);
    expect(dosesForDate({ ...med, active: false }, '2026-11-05', TZ)).toEqual([]);
  });
  it('missed-dose stages at 60 min and 3 h', () => {
    const s = new Date('2026-11-05T06:00:00Z');
    const at = (m: number) => new Date(s.getTime() + m * 60000);
    expect(missedDoseStage({ status: 'scheduled', scheduledAt: s }, at(59), defaultConfig)).toBe('none');
    expect(missedDoseStage({ status: 'scheduled', scheduledAt: s }, at(60), defaultConfig)).toBe('alert_coordinator');
    expect(missedDoseStage({ status: 'missed', scheduledAt: s }, at(180), defaultConfig)).toBe('notify_family');
    expect(missedDoseStage({ status: 'confirmed', scheduledAt: s }, at(500), defaultConfig)).toBe('none');
  });
  it('adherence', () => {
    expect(adherenceRate([{ status: 'confirmed' }, { status: 'missed' }, { status: 'scheduled' }])).toBe(0.5);
    expect(adherenceRate([])).toBeNull();
  });
});

describe('§10 visit generation and routes', () => {
  it('plans weekly, biweekly, monthly visits for 14 days', () => {
    // 2026-11-05 is a Thursday (4)
    const v = planVisits(
      [
        { type: 'nurse', freq: 'weekly', weekdays: [0], time: '10:00', durationMin: 45 },
        { type: 'coordinator', freq: 'biweekly', weekday: 4, anchorDate: '2026-11-05', time: '12:00', durationMin: 60 },
        { type: 'doctor', freq: 'monthly', dayOfMonth: 10, time: '16:00', durationMin: 30 },
      ],
      '2026-11-05', 14, TZ,
    );
    expect(v.filter((x) => x.type === 'nurse')).toHaveLength(2); // Nov 8, 15
    expect(v.filter((x) => x.type === 'coordinator').map((x) => x.scheduledAt.toISOString())).toEqual(['2026-11-05T10:00:00.000Z']);
    expect(v.filter((x) => x.type === 'doctor')).toHaveLength(1);
  });
  it('groups routes by neighbourhood in time order', () => {
    const r = groupRoute([
      { id: 1, neighborhood: 'Zamalek', scheduledAt: new Date('2026-11-05T09:00:00Z') },
      { id: 2, neighborhood: 'Dokki', scheduledAt: new Date('2026-11-05T08:00:00Z') },
      { id: 3, neighborhood: 'Zamalek', scheduledAt: new Date('2026-11-05T11:00:00Z') },
    ]);
    expect(r.map((g) => g.neighborhood)).toEqual(['Dokki', 'Zamalek']);
    expect(r[1]!.visits.map((v) => v.id)).toEqual([1, 3]);
  });
  it('no-show after grace', () => {
    const s = new Date('2026-11-05T09:00:00Z');
    expect(isNoShow({ status: 'scheduled', scheduledAt: s }, new Date('2026-11-05T09:29:00Z'), 30)).toBe(false);
    expect(isNoShow({ status: 'scheduled', scheduledAt: s }, new Date('2026-11-05T09:30:00Z'), 30)).toBe(true);
    expect(isNoShow({ status: 'in_progress', scheduledAt: s }, new Date('2026-11-05T10:30:00Z'), 30)).toBe(false);
  });
});

describe('F9 billing', () => {
  const prices = [{ planCode: 'visit' as const, currency: 'USD' as const, amount: 5900 }, { planCode: 'plus' as const, currency: 'SAR' as const, amount: 55900 }];
  it('prices plans per currency; caregiver needs per-family price', () => {
    expect(subscriptionPrice({ planCode: 'visit', currency: 'USD', prices })).toEqual({ amount: 5900, currency: 'USD' });
    expect(() => subscriptionPrice({ planCode: 'caregiver', currency: 'USD', prices })).toThrow('caregiver_price_must_be_set_per_family');
    expect(subscriptionPrice({ planCode: 'caregiver', currency: 'USD', prices, customAmount: 42000 }).amount).toBe(42000);
    expect(() => subscriptionPrice({ planCode: 'plus', currency: 'USD', prices })).toThrow('price_not_configured');
  });
  it('itemises pass-throughs at cost with separate handling fee line', () => {
    const lines = buildInvoiceLines({
      currency: 'USD',
      subscription: { planCode: 'visit', price: { amount: 5900, currency: 'USD' }, periodLabel: '2026-11' },
      passThroughs: [
        { id: 'p1', category: 'medicine', description: 'Metformin 500mg x60', amount: 1250, currency: 'USD', handlingFee: 200 },
        { id: 'p2', category: 'lab', description: 'CBC', amount: 900, currency: 'USD', handlingFee: null },
      ],
    });
    expect(lines.map((l) => l.kind)).toEqual(['subscription', 'pass_through', 'handling_fee', 'pass_through']);
    expect(lines.filter((l) => l.kind === 'pass_through').every((l) => l.atCost)).toBe(true);
    expect(invoiceTotal(lines)).toBe(5900 + 1250 + 200 + 900);
    expect(() => buildInvoiceLines({ currency: 'SAR', passThroughs: [{ id: 'x', category: 'lab', description: 'x', amount: 1, currency: 'USD', handlingFee: null }] })).toThrow('currency_mismatch');
  });
  it('retries day 1/3/7 then pauses', () => {
    const f = new Date('2026-11-01T00:00:00Z');
    expect(retrySchedule(f, [1, 3, 7]).map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-11-02', '2026-11-04', '2026-11-08']);
    expect(statusAfterFailedAttempt(0, [1, 3, 7])).toBe('past_due');
    expect(statusAfterFailedAttempt(3, [1, 3, 7])).toBe('paused');
  });
  it('addMonth clamps', () => {
    expect(addMonth(new Date('2026-01-31T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});

describe('churn', () => {
  it('flags with reasons', () => {
    expect(churnRisk({ missedVisits30d: 0, overdueConcerns: 0, failedPayments: 0, appOpens14d: 10 }).flagged).toBe(false);
    expect(churnRisk({ missedVisits30d: 3, overdueConcerns: 0, failedPayments: 1, appOpens14d: 10 }).reasons).toEqual(['missed_visits', 'failed_payments']);
  });
});

describe('i18n', () => {
  it('Arabic dictionary has every English key', () => {
    const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, p + k + '.') : [p + k]));
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });
  it('every notification type has both languages', () => {
    for (const t of NOTIFICATION_TYPES) {
      expect(notificationTemplates[t].en.length).toBeGreaterThan(5);
      expect(notificationTemplates[t].ar.length).toBeGreaterThan(5);
    }
  });
  it('translate interpolates and falls back', () => {
    expect(translate('en', 'timeline.duration', { min: 30 })).toBe('30 min');
    expect(translate('ar', 'status.checked')).toBe('تمت الاطمئنان اليوم');
    expect(translate('ar', 'missing.key')).toBe('missing.key');
  });
});

describe('report generator v1', () => {
  it('produces deterministic bilingual visit report with flags', () => {
    const input = {
      parentName: 'Fatma', staffName: 'Mona', visitType: 'nurse' as const,
      checkedInAt: '2026-11-05T08:00:00Z', checkedOutAt: '2026-11-05T08:40:00Z',
      observations: { mood: 4, appetite: 'good' as const, hydration: 'concern' as const, fallsSinceLastVisit: 0 },
      vitals: [{ kind: 'bp_systolic' as const, value: 165 }, { kind: 'pulse' as const, value: 70 }],
      tasksDone: [{ code: 'meds_reviewed', label_en: 'Medicines reviewed', label_ar: 'مراجعة الأدوية' }],
      note: 'Drank little water today.', photoCount: 1,
    };
    const a = templateVisitReportGenerator.generate('p1', { from: '2026-11-05', to: '2026-11-05' }, input);
    const b = templateVisitReportGenerator.generate('p1', { from: '2026-11-05', to: '2026-11-05' }, input);
    expect(a).toEqual(b);
    expect(a.generator).toBe('template_v1');
    expect(a.payload.flags).toEqual({ outOfRangeVitals: true, criticalVitals: false, concerns: ['hydration'] });
    expect(a.text_en).toContain('Nurse visit — Mona');
    expect(a.text_en).toContain('Outside usual range');
    expect(a.text_ar).toContain('زيارة تمريض');
    expect(a.text_ar).toContain('مراجعة الأدوية');
  });
  it('monthly report computes rates', () => {
    const r = templateMonthlyReportGenerator.generate('p1', { from: '2026-10-01', to: '2026-10-31' }, {
      parentName: 'Fatma', month: '2026-10', visitsPlanned: 10, visitsCompleted: 9,
      vitalsSeries: [{ kind: 'pulse', points: [{ at: 'x', value: 70 }, { at: 'y', value: 80 }] }],
      dosesDue: 60, dosesConfirmed: 57, escalations: 1, concernsRaised: 2, concernsResolved: 2, carerChanges: 0,
    });
    expect(r.payload.adherence).toBeCloseTo(0.95);
    expect(r.payload.vitalsSummary[0]).toMatchObject({ min: 70, max: 80, avg: 75 });
    expect(r.text_en).toContain('Visits: 9 of 10 (90%)');
  });
});
