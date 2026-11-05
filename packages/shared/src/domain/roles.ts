/** PRD §5 roles and capabilities. Enforced in API middleware AND by Postgres RLS. */
export const ROLES = ['family', 'coordinator', 'nurse', 'doctor', 'caregiver', 'oncall_doctor', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES: Role[] = ['coordinator', 'nurse', 'doctor', 'caregiver', 'oncall_doctor', 'admin'];

export type Capability =
  | 'timeline.view'
  | 'plan.manage'
  | 'payment.manage'
  | 'concern.raise'
  | 'concern.handle'
  | 'chat.use'
  | 'family.invite'
  | 'escalation.trigger'
  | 'escalation.acknowledge'
  | 'escalation.resolve'
  | 'visit.perform'
  | 'visit.schedule'
  | 'report.write'
  | 'medication.manage'
  | 'dose.confirm'
  | 'careplan.publish'
  | 'staff.manage'
  | 'pricing.manage'
  | 'refund.issue'
  | 'audit.view'
  | 'settings.manage'
  | 'checkin.override'
  | 'helpline.log'
  | 'passthrough.record';

const matrix: Record<Role, Capability[]> = {
  family: ['timeline.view', 'plan.manage', 'payment.manage', 'concern.raise', 'chat.use', 'family.invite', 'escalation.trigger'],
  coordinator: [
    'timeline.view', 'visit.perform', 'visit.schedule', 'report.write', 'medication.manage', 'dose.confirm',
    'concern.handle', 'chat.use', 'escalation.trigger', 'careplan.publish', 'passthrough.record', 'helpline.log',
  ],
  nurse: ['timeline.view', 'visit.perform', 'report.write', 'medication.manage', 'dose.confirm', 'escalation.trigger', 'passthrough.record'],
  doctor: ['timeline.view', 'visit.perform', 'report.write', 'escalation.trigger', 'escalation.acknowledge', 'escalation.resolve'],
  caregiver: ['visit.perform', 'dose.confirm', 'report.write', 'escalation.trigger'],
  oncall_doctor: ['timeline.view', 'escalation.trigger', 'escalation.acknowledge', 'escalation.resolve'],
  admin: [
    'timeline.view', 'plan.manage', 'payment.manage', 'concern.handle', 'chat.use', 'escalation.trigger',
    'escalation.acknowledge', 'escalation.resolve', 'visit.schedule', 'report.write', 'medication.manage',
    'dose.confirm', 'careplan.publish', 'staff.manage', 'pricing.manage', 'refund.issue', 'audit.view',
    'settings.manage', 'checkin.override', 'helpline.log', 'passthrough.record',
  ],
};

export function can(roles: readonly Role[], cap: Capability): boolean {
  return roles.some((r) => matrix[r]?.includes(cap));
}

export const isStaff = (roles: readonly Role[]) => roles.some((r) => r !== 'family');
