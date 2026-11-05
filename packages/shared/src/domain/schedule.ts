import { addDays, localParts, zonedTimeToUtc } from './time';
import type { VisitType } from '../schemas/visit';

/**
 * Care-plan visit rules. Weekday: 0=Sun..6=Sat.
 * - weekly: on given weekdays
 * - biweekly: on given weekday, every 2 weeks counted from anchorDate
 * - monthly: on given day of month (clamped to month length)
 * - daily: every day (caregiver shifts)
 */
export type VisitRule =
  | { type: VisitType; freq: 'daily'; time: string; durationMin: number }
  | { type: VisitType; freq: 'weekly'; weekdays: number[]; time: string; durationMin: number }
  | { type: VisitType; freq: 'biweekly'; weekday: number; anchorDate: string; time: string; durationMin: number }
  | { type: VisitType; freq: 'monthly'; dayOfMonth: number; time: string; durationMin: number };

export interface PlannedVisit { type: VisitType; scheduledAt: Date; durationMin: number; ruleIndex: number }

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

/** §10 Visit generation: next `days` days from `fromDate` (inclusive). Deterministic → idempotent with a unique key. */
export function planVisits(rules: VisitRule[], fromDate: string, days: number, tz: string): PlannedVisit[] {
  const out: PlannedVisit[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i);
    const noon = zonedTimeToUtc(date, '12:00', tz);
    const wd = localParts(noon, tz).weekday;
    const dom = Number(date.slice(8, 10));
    const [y, m] = date.split('-').map(Number) as [number, number];
    const monthLen = new Date(Date.UTC(y, m, 0)).getUTCDate();
    rules.forEach((r, ruleIndex) => {
      let hit = false;
      if (r.freq === 'daily') hit = true;
      else if (r.freq === 'weekly') hit = r.weekdays.includes(wd);
      else if (r.freq === 'biweekly') hit = wd === r.weekday && Math.floor(daysBetween(r.anchorDate, date) / 7) % 2 === 0 && daysBetween(r.anchorDate, date) >= 0;
      else if (r.freq === 'monthly') hit = dom === Math.min(r.dayOfMonth, monthLen);
      if (hit) out.push({ type: r.type, scheduledAt: zonedTimeToUtc(date, r.time, tz), durationMin: r.durationMin, ruleIndex });
    });
  }
  return out.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

/** §10 Daily routes: group a staff member's visits by neighbourhood, in time order. */
export function groupRoute<T extends { neighborhood: string; scheduledAt: Date }>(visits: T[]): { neighborhood: string; visits: T[] }[] {
  const sorted = [...visits].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  const groups = new Map<string, T[]>();
  for (const v of sorted) {
    const g = groups.get(v.neighborhood) ?? [];
    g.push(v);
    groups.set(v.neighborhood, g);
  }
  return [...groups.entries()]
    .map(([neighborhood, vs]) => ({ neighborhood, visits: vs }))
    .sort((a, b) => a.visits[0]!.scheduledAt.getTime() - b.visits[0]!.scheduledAt.getTime());
}

/** No-show: scheduled visit not checked in after grace. */
export function isNoShow(v: { status: string; scheduledAt: Date }, now: Date, graceMin: number): boolean {
  return v.status === 'scheduled' && now.getTime() >= v.scheduledAt.getTime() + graceMin * 60_000;
}
