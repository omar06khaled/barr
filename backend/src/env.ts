import { z } from 'zod';

/** All deployment configuration comes from the environment (no region-specific code: DATA_REGION is CONFIG). */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().default('postgres://barr_app:barr_app@localhost:5432/barr'),
  MIGRATION_DATABASE_URL: z.string().default('postgres://barr_owner:barr_owner@localhost:5432/barr'),
  DATA_REGION: z.string().default('unset'),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-dev-only-secret'),
  /** 32-byte key, base64. Field-level encryption for phones/addresses (§8). */
  FIELD_ENCRYPTION_KEY: z.string().default('ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0zMi1ieXRlcyE='),
  /** Key for HMAC blind indexes (phone lookup). */
  BLIND_INDEX_KEY: z.string().default('dev-blind-index-key'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:4000'),
  DASHBOARD_ORIGIN: z.string().default('http://localhost:5173'),

  PAYMENT_PROVIDER: z.enum(['fake', 'paytabs']).default('fake'),
  PAYTABS_PROFILE_ID: z.string().optional(),
  PAYTABS_SERVER_KEY: z.string().optional(),
  PAYTABS_REGION_URL: z.string().default('https://secure-egypt.paytabs.com'),

  MESSAGING_PROVIDER: z.enum(['console', 'meta']).default('console'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  CALLING_PROVIDER: z.enum(['console', 'twilio']).default('console'),

  PUSH_PROVIDER: z.enum(['console', 'expo']).default('console'),
  EXPO_ACCESS_TOKEN: z.string().optional(),

  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().default('barr-media'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  GOOGLE_CLIENT_IDS: z.string().default(''), // comma separated (iOS, Android, web)
  APPLE_BUNDLE_IDS: z.string().default('app.barr.family,app.barr.field'),
  /** Development only: accept OTP 000000. Never enabled in production. */
  DEV_FIXED_OTP: z.string().optional(),
});

export type Env = z.infer<typeof schema>;
export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  const env = schema.parse(src);
  if (env.NODE_ENV === 'production') {
    if (env.JWT_SECRET.startsWith('dev-only')) throw new Error('JWT_SECRET must be set in production');
    if (env.FIELD_ENCRYPTION_KEY === schema.shape.FIELD_ENCRYPTION_KEY._def.defaultValue()) throw new Error('FIELD_ENCRYPTION_KEY must be set in production');
    if (env.DEV_FIXED_OTP) throw new Error('DEV_FIXED_OTP is not allowed in production');
  }
  return env;
}
