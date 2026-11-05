import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from '../env';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies migrations in filename order, each in a transaction, recorded in schema_migrations. */
export async function migrate(url: string, log = console.log) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(join(dir, f), 'utf8'));
        await client.query('insert into schema_migrations(name) values ($1)', [f]);
        await client.query('commit');
        log(`applied ${f}`);
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate(loadEnv().MIGRATION_DATABASE_URL).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
