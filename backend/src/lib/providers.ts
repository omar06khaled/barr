import type { Env } from '../env';
import { FakePaymentProvider, PayTabsProvider, type PaymentProvider } from '../providers/payment';
import { ExpoPush, MetaCloudWhatsApp, RecordingChannel, TwilioSms } from '../providers/messaging';
import { LocalStorage, S3Storage } from '../providers/storage';
import { JwksOAuthVerifier } from '../providers/oauth';

/** Builds provider adapters from configuration only (switching provider = config change). */
export function providersFromEnv(env: Env) {
  const payments: PaymentProvider =
    env.PAYMENT_PROVIDER === 'paytabs'
      ? new PayTabsProvider({ profileId: req(env.PAYTABS_PROFILE_ID, 'PAYTABS_PROFILE_ID'), serverKey: req(env.PAYTABS_SERVER_KEY, 'PAYTABS_SERVER_KEY'), baseUrl: env.PAYTABS_REGION_URL })
      : new FakePaymentProvider();
  const whatsapp =
    env.MESSAGING_PROVIDER === 'meta'
      ? new MetaCloudWhatsApp({ phoneNumberId: req(env.WHATSAPP_PHONE_NUMBER_ID, 'WHATSAPP_PHONE_NUMBER_ID'), token: req(env.WHATSAPP_TOKEN, 'WHATSAPP_TOKEN'), appSecret: env.WHATSAPP_APP_SECRET })
      : new RecordingChannel('whatsapp', true);
  const twilio = env.SMS_PROVIDER === 'twilio' || env.CALLING_PROVIDER === 'twilio'
    ? new TwilioSms({ sid: req(env.TWILIO_ACCOUNT_SID, 'TWILIO_ACCOUNT_SID'), token: req(env.TWILIO_AUTH_TOKEN, 'TWILIO_AUTH_TOKEN'), from: req(env.TWILIO_FROM, 'TWILIO_FROM') })
    : null;
  return {
    payments,
    whatsapp,
    sms: env.SMS_PROVIDER === 'twilio' ? twilio! : new RecordingChannel('sms', true),
    calls: env.CALLING_PROVIDER === 'twilio' ? twilio! : new RecordingChannel('call', true),
    push: env.PUSH_PROVIDER === 'expo' ? new ExpoPush(env.EXPO_ACCESS_TOKEN) : new RecordingChannel('push', true),
    storage:
      env.STORAGE_PROVIDER === 's3'
        ? new S3Storage({ bucket: env.S3_BUCKET, region: env.S3_REGION, endpoint: env.S3_ENDPOINT, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY })
        : new LocalStorage(env.PUBLIC_BASE_URL, env.JWT_SECRET),
    oauth: new JwksOAuthVerifier(env.GOOGLE_CLIENT_IDS.split(',').filter(Boolean), env.APPLE_BUNDLE_IDS.split(',').filter(Boolean)),
  };
}
function req(v: string | undefined, name: string): string {
  if (!v) throw new Error(`${name} is required for the selected provider`);
  return v;
}
