export interface ChurnSignals { missedVisits30d: number; overdueConcerns: number; failedPayments: number; appOpens14d: number }

/** §10 churn-risk flag. Returns the reasons; flagged when any reason applies. */
export function churnRisk(s: ChurnSignals): { flagged: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (s.missedVisits30d >= 2) reasons.push('missed_visits');
  if (s.overdueConcerns >= 1) reasons.push('overdue_concerns');
  if (s.failedPayments >= 1) reasons.push('failed_payments');
  if (s.appOpens14d < 2) reasons.push('low_app_opens');
  return { flagged: reasons.length > 0, reasons };
}
