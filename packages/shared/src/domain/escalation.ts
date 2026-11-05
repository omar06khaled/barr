import { minutes } from './time';

export type EscalationSeverity = 'urgent' | 'non_urgent';
export type EscalationTrigger = 'family_help' | 'staff' | 'helpline_call' | 'critical_vitals' | 'caregiver_no_show';
export type EscalationStatus = 'open' | 'acknowledged' | 'in_progress' | 'closed';
export type EscalationDecision = 'phone_advice' | 'nurse_dispatched' | 'ambulance_called' | 'hospital_transfer';

export const ESCALATION_TRIGGERS = ['family_help', 'staff', 'helpline_call', 'critical_vitals', 'caregiver_no_show'] as const;
export const ESCALATION_DECISIONS = ['phone_advice', 'nurse_dispatched', 'ambulance_called', 'hospital_transfer'] as const;

/** Jobs scheduled at creation (F8 / §10). All are idempotent: each checks state before acting. */
export function escalationTimerPlan(createdAt: Date, cfg: { escalationAckMin: number; escalationFamilyNotifyMin: number }) {
  return [
    { job: 'escalation.ack_check', runAt: new Date(createdAt.getTime() + minutes(cfg.escalationAckMin)) },
    { job: 'escalation.family_notify', runAt: new Date(createdAt.getTime() + minutes(cfg.escalationFamilyNotifyMin)) },
  ] as const;
}

const transitions: Record<EscalationStatus, EscalationStatus[]> = {
  open: ['acknowledged', 'closed'],
  acknowledged: ['in_progress', 'closed'],
  in_progress: ['closed'],
  closed: [],
};

export function canTransition(from: EscalationStatus, to: EscalationStatus): boolean {
  return transitions[from].includes(to);
}

/** Closing requires a note (F8 step 6). */
export function validateClose(note: string | null | undefined): string | null {
  return note && note.trim().length >= 3 ? null : 'closing_note_required';
}
