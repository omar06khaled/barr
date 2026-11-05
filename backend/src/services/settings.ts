import { defaultConfig, mergeConfig, type BarrConfig } from '@barr/shared';
import type { Sql } from '../db/pool';

/** CONFIG values: `settings` row 'config' overrides shared defaults. Read per transaction (cheap, indexed PK). */
export async function getConfig(c: Sql): Promise<BarrConfig> {
  const r = await c.query(`select value from settings where key = 'config'`);
  return mergeConfig(r.rows[0]?.value);
}

export async function setConfig(c: Sql, patch: Partial<BarrConfig>, userId: string) {
  const current = await getConfig(c);
  const unknown = Object.keys(patch).filter((k) => !(k in defaultConfig));
  if (unknown.length) throw new Error(`unknown_config_keys:${unknown.join(',')}`);
  const next = { ...current, ...patch };
  if (next.signedUrlTtlS > 900) throw new Error('signed_url_ttl_max_900');
  await c.query(
    `insert into settings (key, value, updated_by, updated_at) values ('config', $1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [next, userId],
  );
  return { before: current, after: next };
}
