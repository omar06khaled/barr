import { hostname } from 'node:os';
import type { Db, Sql } from '../db/pool';
import { hhmmToMinutes, localParts, zonedTimeToUtc } from '@barr/shared';

export interface EnqueueOpts { runAt: Date; dedupeKey?: string; maxAttempts?: number }

/**
 * Postgres-backed job queue (see docs/decisions.md D4).
 * enqueue() takes the caller's transaction client, so a domain change and its
 * timers commit atomically (transactional outbox). dedupe_key makes enqueue idempotent.
 */
export async function enqueue(c: Sql, name: string, payload: Record<string, unknown>, o: EnqueueOpts): Promise<boolean> {
  const r = await c.query(
    `insert into jobs (name, payload, run_at, dedupe_key, max_attempts) values ($1, $2, $3, $4, $5)
     on conflict (dedupe_key) do nothing`,
    [name, payload, o.runAt, o.dedupeKey ?? null, o.maxAttempts ?? 5],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface JobContext<P = any> { c: Sql; payload: P; now: Date; jobId: number; attempt: number }
export type JobHandler<P = any> = (ctx: JobContext<P>) => Promise<void>;

export type CronSpec =
  | { name: string; kind: 'daily'; at: string | (() => Promise<string>); tz: string }
  | { name: string; kind: 'monthly'; day: number; at: string; tz: string }
  | { name: string; kind: 'interval'; minutes: number };

export class Worker {
  private handlers = new Map<string, JobHandler>();
  readonly id = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  constructor(private db: Db) {}

  register<P>(name: string, h: JobHandler<P>) { this.handlers.set(name, h as JobHandler); return this; }
  names() { return [...this.handlers.keys()]; }

  /** Enqueue cron jobs whose run time for the current period has passed. Idempotent per period. */
  async tickCron(now: Date, specs: CronSpec[]) {
    await this.db.system(async (c) => {
      for (const s of specs) {
        if (s.kind === 'interval') {
          const slot = Math.floor(now.getTime() / (s.minutes * 60_000));
          await enqueue(c, s.name, { slot }, { runAt: now, dedupeKey: `cron:${s.name}:${slot}`, maxAttempts: 3 });
        } else if (s.kind === 'daily') {
          const at = typeof s.at === 'string' ? s.at : await s.at();
          const lp = localParts(now, s.tz);
          if (lp.minutes >= hhmmToMinutes(at)) {
            await enqueue(c, s.name, { date: lp.date }, { runAt: zonedTimeToUtc(lp.date, at, s.tz), dedupeKey: `cron:${s.name}:${lp.date}` });
          }
        } else {
          const lp = localParts(now, s.tz);
          const day = Number(lp.date.slice(8, 10));
          if (day > s.day || (day === s.day && lp.minutes >= hhmmToMinutes(s.at))) {
            const month = lp.date.slice(0, 7);
            await enqueue(c, s.name, { month }, { runAt: now, dedupeKey: `cron:${s.name}:${month}` });
          }
        }
      }
    });
  }

  /** Claim and run due jobs. Returns the number processed. Safe to run on many workers (SKIP LOCKED). */
  async runDue(now: Date, limit = 50): Promise<number> {
    // Reap jobs stuck in "running" (crashed worker) after 5 minutes.
    await this.db.system((c) => c.query(`update jobs set status='failed', last_error='reaped' where status='running' and locked_at < $1`, [new Date(now.getTime() - 300_000)]));
    const claimed = await this.db.system(async (c) =>
      (await c.query(
        `update jobs set status='running', locked_by=$1, locked_at=$2, attempts=attempts+1
         where id in (select id from jobs where status in ('queued','failed') and run_at <= $2 order by run_at limit $3 for update skip locked)
         returning id, name, payload, attempts, max_attempts`,
        [this.id, now, limit],
      )).rows,
    );
    for (const j of claimed) {
      const h = this.handlers.get(j.name);
      try {
        if (!h) throw new Error(`no handler for ${j.name}`);
        await this.db.system((c) => h({ c, payload: j.payload, now, jobId: j.id, attempt: j.attempts }));
        await this.db.system((c) => c.query(`update jobs set status='done', finished_at=$2, last_error=null where id=$1`, [j.id, now]));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const dead = j.attempts >= j.max_attempts;
        const backoffMs = Math.min(3_600_000, 2 ** j.attempts * 15_000);
        await this.db.system((c) =>
          c.query(`update jobs set status=$2, last_error=$3, run_at=$4, finished_at=case when $2='dead' then $5::timestamptz else null end where id=$1`, [
            j.id, dead ? 'dead' : 'failed', msg.slice(0, 2000), new Date(now.getTime() + backoffMs), now,
          ]),
        );
      }
    }
    return claimed.length;
  }

  /** Run until no due jobs remain (tests / catch-up). */
  async drain(now: Date, maxRounds = 20) {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.runDue(now);
      total += n;
      if (n === 0) break;
    }
    return total;
  }
}
