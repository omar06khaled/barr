import { hours } from './time';

export const CONCERN_CATEGORIES = ['care_quality', 'staff_conduct', 'schedule', 'medicine', 'billing', 'app', 'other'] as const;
export type ConcernCategory = (typeof CONCERN_CATEGORIES)[number];
export type ConcernStatus = 'open' | 'in_progress' | 'resolved';
export type ConcernUrgency = 'urgent' | 'normal';

/** Concerns about staff conduct auto-flag as safety (F11). */
export const isSafetyConcern = (c: ConcernCategory) => c === 'staff_conduct';

export function concernDeadline(createdAt: Date, urgency: ConcernUrgency, safety: boolean, cfg: { concernDeadlineUrgentH: number; concernDeadlineNormalH: number }): Date {
  const h = urgency === 'urgent' || safety ? cfg.concernDeadlineUrgentH : cfg.concernDeadlineNormalH;
  return new Date(createdAt.getTime() + hours(h));
}

export function isOverdue(c: { status: ConcernStatus; deadline: Date }, now: Date): boolean {
  return c.status !== 'resolved' && now > c.deadline;
}

export function canReopen(c: { status: ConcernStatus; resolvedAt: Date | null }, now: Date, reopenDays: number): boolean {
  return c.status === 'resolved' && !!c.resolvedAt && now.getTime() - c.resolvedAt.getTime() <= reopenDays * 86_400_000;
}

/** Human-readable reference number, e.g. C-2611-04F2. */
export function concernReference(createdAt: Date, seq: number): string {
  const yymm = createdAt.toISOString().slice(2, 7).replace('-', '');
  return `C-${yymm}-${seq.toString(36).toUpperCase().padStart(4, '0')}`;
}
