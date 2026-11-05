import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { Db } from '../src/db/pool';
import { loadEnv } from '../src/env';
import { FakeClock } from '../src/lib/clock';
import { FieldCrypto } from '../src/lib/crypto';
import { FakePaymentProvider } from '../src/providers/payment';
import { RecordingChannel } from '../src/providers/messaging';
import { LocalStorage } from '../src/providers/storage';
import { FakeOAuthVerifier } from '../src/providers/oauth';
import { Worker } from '../src/jobs/queue';
import { registerJobs } from '../src/jobs/register';
import { seedReference } from '../src/db/reference';
import type { Deps } from '../src/deps';

const host = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres').host;
const OWNER_URL = `postgres://barr_owner:barr_owner@${host}/barr_test`;

export interface Harness {
  app: FastifyInstance; d: Deps; clock: FakeClock; worker: Worker; owner: pg.Pool;
  push: RecordingChannel; whatsapp: RecordingChannel; sms: RecordingChannel; calls: RecordingChannel; payments: FakePaymentProvider;
  ids: Record<string, string>;
  token(role: keyof Harness['tokens']): string;
  /** Re-sign-in all staff (access tokens live 15 min; tests that jump the clock call this, as the app's refresh would). */
  relogin(): Promise<void>;
  tokens: Record<'admin' | 'coordinator' | 'nurse' | 'doctor' | 'backupDoctor' | 'caregiver' | 'unverifiedNurse' | 'otherNurse', string>;
  close(): Promise<void>;
}

export async function makeHarness(start = new Date('2026-11-05T07:00:00Z')): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: `postgres://barr_app:barr_app@${host}/barr_test`, DEV_FIXED_OTP: '123456', PUBLIC_BASE_URL: 'http://test' } as any);
  const owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
  const tables = (await owner.query(`select tablename from pg_tables where schemaname='public' and tablename <> 'schema_migrations'`)).rows.map((r) => r.tablename);
  await owner.query(`truncate ${tables.map((t) => `"${t}"`).join(',')} restart identity cascade`);
  const clock = new FakeClock(start);
  const push = new RecordingChannel('push'), whatsapp = new RecordingChannel('whatsapp'), sms = new RecordingChannel('sms'), calls = new RecordingChannel('call');
  const payments = new FakePaymentProvider();
  const d: Deps = {
    env, db: Db.connect(env.DATABASE_URL, 5), clock, crypto: new FieldCrypto(env.FIELD_ENCRYPTION_KEY, env.BLIND_INDEX_KEY),
    payments, whatsapp, sms, push, calls, storage: new LocalStorage('http://test', env.JWT_SECRET, () => clock.now()), oauth: new FakeOAuthVerifier(),
  };
  const app = await buildApp(d);
  const worker = registerJobs(new Worker(d.db), d);

  // Base data, created by the owner role (bypasses RLS) — mirrors what admin would do in the dashboard.
  const ids: Record<string, string> = {};
  const c = await owner.connect();
  try {
    await seedReference(c as any);
    ids.city = (await c.query(`insert into cities (name_en, name_ar) values ('Cairo','القاهرة') returning id`)).rows[0].id;
    const mk = async (key: string, phone: string, role: string, roles: string[], verified = true, gender = 'female') => {
      const u = (await c.query(`insert into users (phone_enc, phone_hash, first_name, display_name, roles, language) values ($1,$2,$3,$3,$4,'ar') returning id`, [d.crypto.encrypt(phone), d.crypto.blindIndex(phone), key, roles])).rows[0];
      ids[key] = u.id;
      return { id: u.id, role, verified, gender };
    };
    const staff = [
      await mk('admin', '+201000000001', 'admin', ['admin']),
      await mk('coordinator', '+201000000002', 'coordinator', ['coordinator']),
      await mk('nurse', '+201000000003', 'nurse', ['nurse']),
      await mk('doctor', '+201000000004', 'oncall_doctor', ['doctor', 'oncall_doctor'], true, 'male'),
      await mk('backupDoctor', '+201000000005', 'oncall_doctor', ['doctor', 'oncall_doctor'], true, 'male'),
      await mk('caregiver', '+201000000006', 'caregiver', ['caregiver']),
      await mk('unverifiedNurse', '+201000000007', 'nurse', ['nurse'], false),
      await mk('otherNurse', '+201000000008', 'nurse', ['nurse']),
    ];
    ids.pod = (await c.query(`insert into pods (city_id, name, coordinator_user_id, neighborhoods) values ($1,'Zamalek pod',$2,'{Zamalek,Dokki}') returning id`, [ids.city, ids.coordinator])).rows[0].id;
    for (const s of staff) {
      await c.query(`insert into staff (user_id, role, gender, city_id, pod_id) values ($1,$2,$3,$4,$5)`, [s.id, s.role, s.gender, ids.city, ids.pod]);
      if (s.verified) for (const item of ['id_checked', 'background_check', 'reference_check', 'training']) await c.query(`insert into staff_verifications (user_id, item, completed_on, verified_by) values ($1,$2,'2026-10-01',$3)`, [s.id, item, ids.admin]);
    }
    await c.query(`insert into oncall_rota (city_id, user_id, tier, starts_at, ends_at) values ($1,$2,'primary',$4,$5), ($1,$3,'backup',$4,$5)`, [ids.city, ids.doctor, ids.backupDoctor, new Date(start.getTime() - 86_400_000), new Date(start.getTime() + 60 * 86_400_000)]);
    for (let i = 1; i <= 3; i++) await c.query(`insert into assessment_slots (pod_id, coordinator_user_id, starts_at, ends_at) values ($1,$2,$3,$4)`, [ids.pod, ids.coordinator, new Date(start.getTime() + i * 86_400_000), new Date(start.getTime() + i * 86_400_000 + 3_600_000)]);
    // Push tokens so push "sends" (except where tests remove them).
    for (const s of staff) await c.query(`insert into push_tokens (user_id, token, platform, app) values ($1,$2,'android','field')`, [s.id, `ExponentPushToken[${s.id}]`]);
  } finally { c.release(); }

  const tokens = {} as Harness['tokens'];
  const phones: Record<string, string> = { admin: '+201000000001', coordinator: '+201000000002', nurse: '+201000000003', doctor: '+201000000004', backupDoctor: '+201000000005', caregiver: '+201000000006', unverifiedNurse: '+201000000007', otherNurse: '+201000000008' };
  for (const [k, phone] of Object.entries(phones)) tokens[k as keyof typeof tokens] = (await signInPhone(app, phone)).accessToken;

  return {
    app, d, clock, worker, owner, push, whatsapp, sms, calls, payments, ids, tokens,
    token: (r) => tokens[r],
    relogin: async () => { for (const [k, phone] of Object.entries(phones)) tokens[k as keyof typeof tokens] = (await signInPhone(app, phone)).accessToken; },
    close: async () => { await app.close(); await d.db.close(); await owner.end(); },
  };
}

export async function signInPhone(app: FastifyInstance, phone: string) {
  const r1 = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  if (r1.statusCode !== 200) throw new Error(`otp request ${r1.statusCode} ${r1.body}`);
  const r2 = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: '123456' } });
  if (r2.statusCode !== 200) throw new Error(`otp verify ${r2.statusCode} ${r2.body}`);
  return r2.json() as { accessToken: string; refreshToken: string; user: { id: string }; isNew: boolean };
}

export async function api(h: Harness, token: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const r = await h.app.inject({ method, url: `/v1${url}`, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.body ? safeJson(r.body) : null };
}
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

export const HOME = { lat: 30.0626, lng: 31.2197 }; // Zamalek
export const NEAR = { lat: 30.0630, lng: 31.2200, accuracyM: 10 };
export const FAR = { lat: 30.0800, lng: 31.2197, accuracyM: 10 };

/** Family sign-up + parent creation through the API. */
export async function newFamily(h: Harness, phone = '+966501234567', parentOverrides: Record<string, unknown> = {}) {
  const s = await signInPhone(h.app, phone);
  const p = await api(h, s.accessToken, 'POST', '/parents', {
    name: 'Fatma', gender: 'female', address: '12 Shagaret El Dor St, Zamalek, Cairo', neighborhood: 'Zamalek', location: HOME, language: 'ar',
    emergencyContacts: [{ name: 'Neighbour Hoda', phone: '01012345678', relation: 'neighbour' }], knownMedicines: ['Metformin'], allergies: { has: true, text: 'Penicillin' }, mobilityNotes: 'Uses a cane',
    ...parentOverrides,
  });
  if (p.status !== 200) throw new Error(`create parent ${p.status} ${JSON.stringify(p.body)}`);
  return { token: s.accessToken, userId: s.user.id, parentId: p.body.id as string, familyId: p.body.familyId as string };
}

/** Make a parent active with photo consent, as after a completed assessment. */
export async function activate(h: Harness, parentId: string, photoConsent = true) {
  await h.owner.query(`update parents set status='active' where id=$1`, [parentId]);
  const r = await api(h, h.token('coordinator'), 'POST', '/consents', { parentId, consents: [{ type: 'visits', granted: true }, { type: 'photos', granted: photoConsent }, { type: 'share_updates', granted: true }], documentKey: `consent_doc/${parentId}/scan.pdf` });
  if (r.status !== 200) throw new Error(`consent ${r.status} ${JSON.stringify(r.body)}`);
}

export async function makeVisit(h: Harness, parentId: string, staffKey: 'nurse' | 'caregiver' | 'coordinator' | 'otherNurse' = 'nurse', type = 'nurse', at?: Date) {
  const r = await api(h, h.token('admin'), 'POST', '/admin/visits', { parentId, type, staffId: h.ids[staffKey], scheduledAt: (at ?? new Date(h.clock.now().getTime() + 30 * 60_000)).toISOString(), durationMin: 45 });
  if (r.status !== 200) throw new Error(`visit ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
}

export const uuid = () => randomUUID();
