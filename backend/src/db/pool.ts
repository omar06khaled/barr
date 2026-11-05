import pg from 'pg';
import type { Role } from '@barr/shared';

// Return bigint/numeric as JS numbers where safe; timestamps as Date (default).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
pg.types.setTypeParser(1082, (v) => v); // date as 'YYYY-MM-DD'

export type Sql = pg.PoolClient;
export interface Actor { userId: string; roles: Role[] }

/**
 * Every query runs inside a transaction with RLS context set (transaction-local):
 *  - as(actor) → barr.user_id / barr.roles → row-level security enforces section 5 roles.
 *  - system()  → barr.system = on (jobs, webhooks).
 */
export class Db {
  constructor(public pool: pg.Pool) {}

  static connect(url: string, max = 10) {
    return new Db(new pg.Pool({ connectionString: url, max }));
  }

  private async tx<T>(setup: (c: Sql) => Promise<void>, fn: (c: Sql) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await setup(c);
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  as<T>(actor: Actor, fn: (c: Sql) => Promise<T>): Promise<T> {
    return this.tx(async (c) => {
      await c.query(`select set_config('barr.user_id', $1, true), set_config('barr.roles', $2, true), set_config('barr.system', 'off', true)`, [
        actor.userId,
        ',' + actor.roles.join(',') + ',',
      ]);
    }, fn);
  }

  system<T>(fn: (c: Sql) => Promise<T>): Promise<T> {
    return this.tx(async (c) => {
      await c.query(`select set_config('barr.system', 'on', true)`);
    }, fn);
  }

  close() { return this.pool.end(); }
}

export async function one<T = Record<string, any>>(c: Sql, text: string, params: unknown[] = []): Promise<T | null> {
  const r = await c.query(text, params as any[]);
  return (r.rows[0] as T) ?? null;
}
export async function many<T = Record<string, any>>(c: Sql, text: string, params: unknown[] = []): Promise<T[]> {
  const r = await c.query(text, params as any[]);
  return r.rows as T[];
}
