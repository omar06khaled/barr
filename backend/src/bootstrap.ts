import { loadEnv, type Env } from './env';
import { Db } from './db/pool';
import { FieldCrypto } from './lib/crypto';
import { systemClock } from './lib/clock';
import { providersFromEnv } from './lib/providers';
import type { Deps } from './deps';

export function makeDeps(env: Env = loadEnv()): Deps {
  return { env, db: Db.connect(env.DATABASE_URL, 20), clock: systemClock, crypto: new FieldCrypto(env.FIELD_ENCRYPTION_KEY, env.BLIND_INDEX_KEY), ...providersFromEnv(env) };
}
