import type { Db } from './db/pool';
import type { Env } from './env';
import type { Clock } from './lib/clock';
import type { FieldCrypto } from './lib/crypto';
import type { PaymentProvider } from './providers/payment';
import type { CallingProvider, MessagingProvider, PushProvider, SmsProvider } from './providers/messaging';
import type { StorageProvider } from './providers/storage';
import type { OAuthVerifier } from './providers/oauth';

/** Everything a service needs, injected (so tests swap providers and the clock). */
export interface Deps {
  env: Env;
  db: Db;
  clock: Clock;
  crypto: FieldCrypto;
  payments: PaymentProvider;
  whatsapp: MessagingProvider;
  sms: SmsProvider;
  push: PushProvider;
  calls: CallingProvider;
  storage: StorageProvider;
  oauth: OAuthVerifier;
}
