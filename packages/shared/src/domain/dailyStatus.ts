import { hhmmToMinutes, localParts } from './time';
import type { DailyStatusCode } from '../design-tokens';

export interface DailyStatusInput {
  now: Date;
  timezone: string;
  /** CONFIG HH:MM (default 18:00). */
  noContactAfter: string;
  /** Any completed/in-progress visit, caregiver check-in or confirmed contact today (local date). */
  contactTimes: Date[];
  /** True when an escalation is active (not closed). */
  openEscalation: boolean;
}

/**
 * F3 daily status. Priority: alert > checked > no_contact > pending.
 * "pending" is the neutral state before the cut-off when there's been no contact yet.
 */
export function computeDailyStatus(i: DailyStatusInput): DailyStatusCode {
  if (i.openEscalation) return 'alert';
  const today = localParts(i.now, i.timezone).date;
  const contacted = i.contactTimes.some((t) => localParts(t, i.timezone).date === today && t <= i.now);
  if (contacted) return 'checked';
  const nowMin = localParts(i.now, i.timezone).minutes;
  return nowMin >= hhmmToMinutes(i.noContactAfter) ? 'no_contact' : 'pending';
}
