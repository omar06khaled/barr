import type { Sql } from '../db/pool';

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  parentId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}

/** Append-only audit log (§F16.7, §8). The app role cannot update/delete rows. */
export async function audit(c: Sql, e: AuditEntry) {
  await c.query(
    `insert into audit_log (actor_user_id, action, entity_type, entity_id, parent_id, before, after, meta) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.actorUserId, e.action, e.entityType, e.entityId ?? null, e.parentId ?? null, e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), e.meta ?? {}],
  );
}

export async function track(c: Sql, name: string, userId: string | null, parentId: string | null, props: Record<string, unknown> = {}) {
  await c.query(`insert into analytics_events (name, user_id, parent_id, props) values ($1,$2,$3,$4)`, [name, userId, parentId, props]);
}
