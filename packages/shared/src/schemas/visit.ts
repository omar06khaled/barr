import { z } from 'zod';

export const VISIT_TYPES = ['assessment', 'coordinator', 'nurse', 'doctor', 'caregiver_shift'] as const;
export const visitType = z.enum(VISIT_TYPES);
export type VisitType = z.infer<typeof visitType>;
export const VISIT_STATUSES = ['scheduled', 'in_progress', 'completed', 'missed', 'cancelled'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const geoPoint = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().nonnegative().optional() });

const triLevel = z.enum(['poor', 'normal', 'good']);
const okConcern = z.enum(['ok', 'concern']);

/** PRD §9.2 — typed, coded observations. Every field optional; template decides which are asked. */
export const observations = z
  .object({
    mood: z.number().int().min(1).max(5),
    appetite: triLevel,
    sleep: triLevel,
    mobility: z.enum(['independent', 'with_aid', 'assisted', 'bedbound']),
    pain: z.object({ score: z.number().int().min(0).max(10), location: z.enum(['none', 'head', 'chest', 'abdomen', 'back', 'joints', 'legs', 'other']) }),
    skin: okConcern,
    hydration: okConcern,
    homeSafety: z.record(z.string().max(40), z.boolean()),
    cognitionChange: z.boolean(),
    fallsSinceLastVisit: z.number().int().min(0).max(50),
    medicineAdherence: okConcern,
    socialContact: z.boolean(),
  })
  .partial();
export type Observations = z.infer<typeof observations>;
export const OBSERVATION_KEYS = ['mood', 'appetite', 'sleep', 'mobility', 'pain', 'skin', 'hydration', 'homeSafety', 'cognitionChange', 'fallsSinceLastVisit', 'medicineAdherence', 'socialContact'] as const;
export type ObservationKey = (typeof OBSERVATION_KEYS)[number];

export const HOME_SAFETY_ITEMS = ['rugs_secured', 'lighting_ok', 'bathroom_rails', 'clear_walkways', 'gas_checked', 'emergency_numbers_visible'] as const;

export const VITAL_KINDS = ['bp_systolic', 'bp_diastolic', 'pulse', 'glucose', 'temperature', 'spo2', 'weight'] as const;
export const vitalReading = z.object({ kind: z.enum(VITAL_KINDS), value: z.number(), recordedAt: z.string().datetime() });

/** Checklist template (editable by admin). */
export const checklistTemplate = z.object({
  visitType: visitType,
  version: z.number().int().positive(),
  observations: z.array(z.enum(OBSERVATION_KEYS)),
  vitals: z.array(z.enum(VITAL_KINDS)),
  tasks: z.array(z.object({ code: z.string().max(40), label_en: z.string(), label_ar: z.string() })),
  photos: z.boolean(),
});
export type ChecklistTemplate = z.infer<typeof checklistTemplate>;

/**
 * Offline-first visit capture. The client generates UUIDs (visit already exists
 * server-side; captureId identifies this submission) so sync is idempotent.
 */
export const visitCheckIn = z.object({
  visitId: z.string().uuid(),
  capturedAt: z.string().datetime(),
  location: geoPoint.nullable(),
  offline: z.boolean().default(false),
});
export const visitCheckOut = visitCheckIn;

export const visitReportSubmission = z.object({
  visitId: z.string().uuid(),
  submittedAt: z.string().datetime(),
  observations: observations,
  vitals: z.array(vitalReading).max(20),
  tasksDone: z.array(z.string().max(40)).max(50),
  note: z.string().max(2000).default(''),
  /** Object-storage keys of photos already uploaded via signed upload URLs. */
  photoKeys: z.array(z.string().max(300)).max(6),
  offline: z.boolean().default(false),
});
export type VisitReportSubmission = z.infer<typeof visitReportSubmission>;

/** Sync batch from the field app outbox (offline queue). Each op has a client op id → idempotent. */
export const syncOp = z.discriminatedUnion('kind', [
  z.object({ opId: z.string().uuid(), kind: z.literal('check_in'), payload: visitCheckIn }),
  z.object({ opId: z.string().uuid(), kind: z.literal('check_out'), payload: visitCheckOut }),
  z.object({ opId: z.string().uuid(), kind: z.literal('report'), payload: visitReportSubmission }),
  z.object({
    opId: z.string().uuid(),
    kind: z.literal('dose_confirm'),
    payload: z.object({ doseId: z.string().uuid(), status: z.enum(['confirmed', 'skipped']), capturedAt: z.string().datetime(), method: z.enum(['caregiver', 'nurse', 'parent_whatsapp', 'parent_phone', 'staff_other']), note: z.string().max(500).optional() }),
  }),
]);
export type SyncOp = z.infer<typeof syncOp>;
export const syncBatch = z.object({ ops: z.array(syncOp).max(200) });
