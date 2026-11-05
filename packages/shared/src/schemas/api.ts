import { z } from 'zod';
import { geoPoint, visitType } from './visit';
import { CONCERN_CATEGORIES } from '../domain/concerns';
import { CURRENCIES, PLAN_CODES } from '../domain/billing';
import { ESCALATION_DECISIONS } from '../domain/escalation';

export const lang = z.enum(['ar', 'en']);
export type Lang = z.infer<typeof lang>;

export const otpRequest = z.object({ phone: z.string().min(6).max(20) });
export const otpVerify = z.object({ phone: z.string().min(6).max(20), code: z.string().regex(/^\d{6}$/), deviceName: z.string().max(80).optional() });
export const oauthSignIn = z.object({ provider: z.enum(['google', 'apple']), idToken: z.string().min(10), nonce: z.string().optional() });
export const refreshRequest = z.object({ refreshToken: z.string().min(20) });

export const parentCreate = z.object({
  name: z.string().min(1).max(120),
  gender: z.enum(['female', 'male']),
  birthYear: z.number().int().min(1900).max(2020).optional(),
  phone: z.string().max(20).optional(),
  address: z.string().min(3).max(400),
  neighborhood: z.string().max(80).optional(),
  location: geoPoint,
  language: lang,
  carerGenderPreference: z.enum(['same_as_parent', 'female', 'male', 'any']).optional(),
  emergencyContacts: z.array(z.object({ name: z.string().max(80), phone: z.string().max(20), relation: z.string().max(40) })).max(5),
  knownMedicines: z.array(z.string().max(120)).max(30).default([]),
  allergies: z.object({ has: z.boolean(), text: z.string().max(300).default('') }),
  mobilityNotes: z.string().max(500).default(''),
  photoKey: z.string().max(300).optional(),
});
export type ParentCreate = z.infer<typeof parentCreate>;
export const parentUpdate = parentCreate.partial();

/** Default carer preference: female carers for mothers; same-gender for fathers (personal care). */
export function defaultCarerPreference(gender: 'female' | 'male'): 'female' | 'male' {
  return gender === 'female' ? 'female' : 'male';
}

export const inviteCreate = z.object({ phone: z.string().min(6).max(20) });
export const subscribeRequest = z.object({ parentId: z.string().uuid(), planCode: z.enum(PLAN_CODES), currency: z.enum(CURRENCIES) });
export const bookAssessment = z.object({ parentId: z.string().uuid(), slotId: z.string().uuid() });

export const escalationCreate = z.object({
  parentId: z.string().uuid(),
  severity: z.enum(['urgent', 'non_urgent']).default('urgent'),
  note: z.string().max(1000).optional(),
});
export const escalationDecision = z.object({ decision: z.enum(ESCALATION_DECISIONS), note: z.string().max(1000).optional() });
export const escalationClose = z.object({ note: z.string().min(3).max(2000) });

export const concernCreate = z.object({
  parentId: z.string().uuid(),
  category: z.enum(CONCERN_CATEGORIES),
  urgency: z.enum(['urgent', 'normal']).default('normal'),
  text: z.string().min(3).max(2000),
  photoKey: z.string().max(300).optional(),
});

export const medicationCreate = z.object({
  parentId: z.string().uuid(),
  name: z.string().min(1).max(120),
  doseText: z.string().min(1).max(120),
  timesOfDay: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1).max(8),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  instructions: z.string().max(500).default(''),
});

export const consentRecord = z.object({
  parentId: z.string().uuid(),
  consents: z.array(z.object({ type: z.enum(['visits', 'photos', 'share_updates']), granted: z.boolean() })).min(1),
  sharedWithUserIds: z.array(z.string().uuid()).default([]),
  documentKey: z.string().max(300),
});

export const passThroughCreate = z.object({
  parentId: z.string().uuid(),
  category: z.enum(['medicine', 'lab', 'ambulance', 'other']),
  description: z.string().min(2).max(200),
  amount: z.number().int().positive(),
  currency: z.enum(CURRENCIES),
  handlingFee: z.number().int().nonnegative().nullable().default(null),
  receiptKey: z.string().max(300),
});

export const helplineCall = z.object({ parentId: z.string().uuid().nullable(), callerName: z.string().max(80), callerPhone: z.string().max(20).optional(), summary: z.string().min(2).max(2000), convertToEscalation: z.boolean().default(false), severity: z.enum(['urgent', 'non_urgent']).default('urgent') });

export const visitSchedule = z.object({ parentId: z.string().uuid(), type: visitType, staffId: z.string().uuid().nullable(), scheduledAt: z.string().datetime(), durationMin: z.number().int().min(10).max(720) });

export const pageQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
