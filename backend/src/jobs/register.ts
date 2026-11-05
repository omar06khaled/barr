import { addDays, localParts } from '@barr/shared';
import type { Deps } from '../deps';
import { Worker, type CronSpec } from './queue';
import { sendNotification } from '../services/notifications';
import { escalationAckCheck, escalationFamilyNotify } from '../services/escalations';
import {
  churnFlags, concernDeadlines, dailyRoutes, dailyStatusForParent, doseFamilyCheck, doseMissedCheck, fanOut, generateDosesForParent,
  generateVisitsForParent, noShowCheck, noShowFamily, visitReminder,
} from '../services/automation';
import { chargeRenewal, enqueueDueRenewals } from '../services/payments';
import { generateMonthlyReport } from '../services/documents';
import { getConfig } from '../services/settings';

const TZ = 'Africa/Cairo';

/** §10 schedule. Times are Egypt time; the daily-status time is CONFIG (read at tick time). */
export function cronSpecs(d: Deps): CronSpec[] {
  return [
    { name: 'visits.generate_all', kind: 'daily', at: '01:00', tz: TZ },
    { name: 'doses.generate_all', kind: 'daily', at: '01:30', tz: TZ },
    { name: 'routes.daily', kind: 'daily', at: '06:00', tz: TZ },
    { name: 'status.daily_all', kind: 'daily', at: async () => d.db.system(async (c) => (await getConfig(c)).dailySummaryAt), tz: TZ },
    { name: 'concerns.deadlines', kind: 'interval', minutes: 5 },
    { name: 'payments.renewals', kind: 'interval', minutes: 60 },
    { name: 'reports.monthly_all', kind: 'monthly', day: 1, at: '08:00', tz: TZ },
    { name: 'churn.daily', kind: 'daily', at: '03:00', tz: TZ },
  ];
}

export function registerJobs(w: Worker, d: Deps) {
  const ACTIVE = `select id from parents where status='active' and deleted_at is null`;
  w.register<{ id: string }>('notification.send', ({ c, payload, now }) => sendNotification(d, c, payload.id, now));
  w.register<{ escalationId: string }>('escalation.ack_check', ({ c, payload, now }) => escalationAckCheck(d, c, now, payload.escalationId));
  w.register<{ escalationId: string }>('escalation.family_notify', ({ c, payload, now }) => escalationFamilyNotify(c, now, payload.escalationId));

  w.register<{ date: string }>('visits.generate_all', async ({ c, payload, now }) => { await fanOut(c, now, 'visits.generate_parent', ACTIVE, [], `visits.gen:${payload.date}`); });
  w.register<{ parentId: string }>('visits.generate_parent', async ({ c, payload, now }) => { await generateVisitsForParent(c, now, payload.parentId); });
  w.register<{ visitId: string; scheduledAt: string }>('visit.reminder', ({ c, payload, now }) => visitReminder(c, now, payload.visitId, payload.scheduledAt));
  w.register<{ visitId: string; scheduledAt: string }>('visit.no_show_check', ({ c, payload, now }) => noShowCheck(c, now, payload.visitId, payload.scheduledAt));
  w.register<{ visitId: string; scheduledAt: string }>('visit.no_show_family', ({ c, payload, now }) => noShowFamily(c, now, payload.visitId, payload.scheduledAt));
  w.register<{ date: string }>('routes.daily', async ({ c, payload, now }) => { await dailyRoutes(c, now, payload.date); });

  w.register<{ date: string }>('doses.generate_all', async ({ c, payload, now }) => {
    const tomorrow = addDays(payload.date, 1);
    await fanOut(c, now, 'doses.generate_parent', `select distinct parent_id id from medications where active`, [], `doses.gen:${tomorrow}`, { date: tomorrow });
  });
  w.register<{ parentId: string; date: string }>('doses.generate_parent', async ({ c, payload }) => { await generateDosesForParent(c, payload.parentId, payload.date); });
  w.register<{ doseId: string }>('dose.missed_check', ({ c, payload, now }) => doseMissedCheck(c, now, payload.doseId));
  w.register<{ doseId: string }>('dose.family_check', ({ c, payload, now }) => doseFamilyCheck(c, now, payload.doseId));

  w.register<{ date: string }>('status.daily_all', async ({ c, payload, now }) => { await fanOut(c, now, 'status.daily_parent', ACTIVE, [], `status:${payload.date}`); });
  w.register<{ parentId: string }>('status.daily_parent', ({ c, payload, now }) => dailyStatusForParent(c, now, payload.parentId));

  w.register('concerns.deadlines', async ({ c, now }) => { await concernDeadlines(c, now); });
  w.register('payments.renewals', async ({ c, now }) => { await enqueueDueRenewals(c, now); });
  w.register<{ subscriptionId: string; attempt: number }>('payment.renew', async ({ c, payload, now }) => { await chargeRenewal(d, c, now, payload.subscriptionId, payload.attempt); });
  w.register<{ subscriptionId: string; attempt: number }>('payment.retry', async ({ c, payload, now }) => { await chargeRenewal(d, c, now, payload.subscriptionId, payload.attempt); });

  w.register<{ month: string }>('reports.monthly_all', async ({ c, payload, now }) => {
    // Runs on the 1st for the PREVIOUS month.
    const [y, m] = payload.month.split('-').map(Number) as [number, number];
    const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
    await fanOut(c, now, 'reports.monthly_parent', `select id from parents where status in ('active','paused') and deleted_at is null`, [], `monthly:${prev}`, { month: prev });
  });
  w.register<{ parentId: string; month: string }>('reports.monthly_parent', async ({ c, payload, now }) => { await generateMonthlyReport(c, now, payload.parentId, payload.month, d.env.PUBLIC_BASE_URL, d.env.JWT_SECRET); });
  w.register('churn.daily', async ({ c, now }) => { await churnFlags(c, now); });
  return w;
}

export const todayCairo = (now: Date) => localParts(now, TZ).date;
