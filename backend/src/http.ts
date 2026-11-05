import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny, output } from 'zod';
import { can, type Capability, type Role } from '@barr/shared';
import type { Deps } from './deps';
import type { Actor, Sql } from './db/pool';
import { authenticate } from './services/auth';
import { badRequest, forbidden } from './lib/errors';

declare module 'fastify' {
  interface FastifyRequest { actor?: Actor & { sessionId: string } }
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('validation_error', r.error.flatten());
  return r.data as output<S>;
}

export const authHook = (d: Deps) => async (req: FastifyRequest) => {
  const a = await authenticate(d, req.headers.authorization);
  req.actor = a;
};

export function actor(req: FastifyRequest): Actor {
  if (!req.actor) throw forbidden('unauthenticated');
  return req.actor;
}

export function requireCap(req: FastifyRequest, cap: Capability): Actor {
  const a = actor(req);
  if (!can(a.roles, cap)) throw forbidden(`missing_capability:${cap}`);
  return a;
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): Actor {
  const a = actor(req);
  if (!a.roles.some((r) => roles.includes(r))) throw forbidden('role_required');
  return a;
}

/** Throws 404 unless the actor can see the parent (RLS-backed check). */
export async function assertParentAccess(c: Sql, parentId: string) {
  const r = await c.query(`select barr_can_access_parent($1) ok, exists(select 1 from parents where id=$1 and deleted_at is null) e`, [parentId]);
  if (!r.rows[0]?.ok || !r.rows[0]?.e) throw forbidden('no_access_to_parent');
}

/** Opaque keyset cursor: base64url("<iso>|<id>"). */
export const encodeCursor = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
export function decodeCursor(c?: string): { at: Date; id: string } | null {
  if (!c) return null;
  const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!at || !id) throw badRequest('invalid_cursor');
  return { at: new Date(at), id };
}

export type Reply = FastifyReply;
