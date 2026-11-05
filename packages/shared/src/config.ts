/**
 * CONFIG values (PRD: "never hard-code"). These are DEFAULTS only. At runtime the
 * backend reads overrides from the `settings` table (editable in the dashboard)
 * and falls back to these. Business-rule functions take config as a parameter.
 */
export const EGYPT_TZ = 'Africa/Cairo';

export const defaultConfig = {
  timezone: EGYPT_TZ,
  /** F3: amber "No contact yet" after this local time (HH:MM). */
  noContactAfter: '18:00',
  /** F3 / §10: daily summary send time (HH:MM, Egypt). */
  dailySummaryAt: '18:00',
  /** F5: check-in radius in metres. */
  checkInRadiusM: 150,
  /** F7: minutes after dose time before it's "missed" and coordinator is alerted. */
  missedDoseAlertMin: 60,
  /** F7: minutes after dose time before family is notified of an unresolved missed dose. */
  missedDoseFamilyMin: 180,
  /** §10: no-show grace minutes after scheduled visit time. */
  noShowGraceMin: 30,
  /** §10: minutes after no-show detection before the family is notified if unresolved. */
  noShowFamilyMin: 60,
  /** F8 (product rule; tested). */
  escalationAckMin: 2,
  escalationFamilyNotifyMin: 15,
  /** F11 reply deadlines in hours. */
  concernDeadlineUrgentH: 4,
  concernDeadlineNormalH: 24,
  concernReopenDays: 7,
  /** F13 replacement target in hours. */
  replacementTargetH: 48,
  /** F9: retry days after a failed renewal. */
  paymentRetryDays: [1, 3, 7] as number[],
  /** F9: pass-through charge timing. */
  passThroughBilling: 'next_invoice' as 'next_invoice' | 'immediate',
  /** F6: photos per visit. */
  maxPhotosPerVisit: 6,
  /** §8: signed URL expiry (must be ≤ 900 s). */
  signedUrlTtlS: 600,
  /** F6: escalate automatically when vitals cross critical thresholds. */
  vitalsCritical: {
    systolicHigh: 180,
    systolicLow: 85,
    diastolicHigh: 120,
    pulseHigh: 130,
    pulseLow: 40,
    glucoseHigh: 400,
    glucoseLow: 54,
    tempHigh: 39.5,
    spo2Low: 88,
  },
  /** Invite expiry (§6). */
  inviteExpiryDays: 7,
  /** Data retention for soft-deleted parent records, in days (§8). Set after legal review. */
  parentRetentionDays: 365 * 7,
};

export type BarrConfig = typeof defaultConfig;

export function mergeConfig(overrides: Partial<Record<string, unknown>> | undefined): BarrConfig {
  return { ...defaultConfig, ...(overrides as Partial<BarrConfig>) };
}
