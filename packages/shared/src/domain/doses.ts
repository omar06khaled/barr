import { zonedTimeToUtc, minutes } from './time';

export interface MedicationSchedule {
  id: string;
  /** Local times of day, HH:MM (Egypt time). */
  timesOfDay: string[];
  startDate: string; // YYYY-MM-DD
  endDate: string | null;
  active: boolean;
}

export type DoseStatus = 'scheduled' | 'confirmed' | 'missed' | 'skipped';
export type DoseMethod = 'caregiver' | 'nurse' | 'parent_whatsapp' | 'parent_phone' | 'staff_other';

/**
 * Dose events for a local date. Each has a deterministic key (medication+time) so
 * nightly generation is idempotent (unique index on medication_id, scheduled_at).
 */
export function dosesForDate(med: MedicationSchedule, date: string, tz: string): { medicationId: string; scheduledAt: Date }[] {
  if (!med.active) return [];
  if (date < med.startDate) return [];
  if (med.endDate && date > med.endDate) return [];
  return [...new Set(med.timesOfDay)].sort().map((t) => ({ medicationId: med.id, scheduledAt: zonedTimeToUtc(date, t, tz) }));
}

export type MissedDoseStage = 'none' | 'alert_coordinator' | 'notify_family';

/** F7: stage of an unconfirmed dose at `now`. */
export function missedDoseStage(
  dose: { status: DoseStatus; scheduledAt: Date },
  now: Date,
  cfg: { missedDoseAlertMin: number; missedDoseFamilyMin: number },
): MissedDoseStage {
  if (dose.status === 'confirmed' || dose.status === 'skipped') return 'none';
  const age = now.getTime() - dose.scheduledAt.getTime();
  if (age >= minutes(cfg.missedDoseFamilyMin)) return 'notify_family';
  if (age >= minutes(cfg.missedDoseAlertMin)) return 'alert_coordinator';
  return 'none';
}

export function adherenceRate(doses: { status: DoseStatus }[]): number | null {
  const due = doses.filter((d) => d.status !== 'scheduled' && d.status !== 'skipped');
  if (due.length === 0) return null;
  return due.filter((d) => d.status === 'confirmed').length / due.length;
}
