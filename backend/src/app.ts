import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Deps } from './deps';
import { AppError } from './lib/errors';
import { authRoutes } from './routes/auth';
import { familyRoutes } from './routes/family';
import { fieldRoutes } from './routes/field';
import { adminRoutes } from './routes/admin';
import { webhookRoutes } from './routes/webhooks';

/** Stateless API (§4.2): no in-process session state; scale horizontally behind a load balancer. */
export async function buildApp(d: Deps) {
  const app = Fastify({
    logger: d.env.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.authorization', 'req.body.code', 'req.body.idToken', 'req.body.refreshToken'] },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });
  // Keep the raw body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try { done(null, body.length ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error, undefined); }
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: [d.env.DASHBOARD_ORIGIN], credentials: false });
  if (d.env.NODE_ENV !== 'test') await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, details: err.details });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'validation_error', details: err.flatten() });
    const pgCode = (err as any)?.code;
    if (pgCode === 'P0001') return reply.status(422).send({ error: err.message });
    if (pgCode === '42501') return reply.status(403).send({ error: 'forbidden_by_policy' }); // RLS
    if ((err as any).statusCode && (err as any).statusCode < 500) return reply.status((err as any).statusCode).send({ error: err.message });
    req.log?.error(err);
    if (d.env.NODE_ENV === 'test') console.error(err);
    return reply.status(500).send({ error: 'internal_error' });
  });

  app.get('/health', async () => ({ ok: true, region: d.env.DATA_REGION }));
  await app.register(async (v1) => {
    await authRoutes(v1, d);
    await familyRoutes(v1, d);
    await fieldRoutes(v1, d);
    await adminRoutes(v1, d);
    await webhookRoutes(v1, d);
  }, { prefix: '/v1' });
  return app;
}
