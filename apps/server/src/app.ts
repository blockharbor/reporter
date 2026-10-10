import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from './config.js';
import { createBlobStore, type ContentStore } from './blobstore/index.js';
import { auditContext, newAuditContext } from './audit/context.js';
import { createAuditedDb } from './audit/extension.js';
import { HttpError } from './auth/guards.js';
import { registerWebRoutes } from './routes/web/index.js';
import { registerApiRoutes } from './routes/api/index.js';
import './types.js';

export interface BuildAppOptions {
  /** Inject a Prisma client (tests). Otherwise one is created from config. */
  prisma?: PrismaClient;
  /** Inject a blob store (tests). Otherwise one is created from config. */
  blobs?: ContentStore;
}

/**
 * Construct the fully-wired Fastify app with no side effects (no listen). Tests
 * use `fastify.inject`; `index.ts` calls `listen`.
 */
export async function buildApp(
  config: ServerConfig,
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const logger =
    config.NODE_ENV === 'test'
      ? false
      : config.isProd
        ? true
        : {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          };

  const app = Fastify({
    bodyLimit: config.MAX_UPLOAD_BYTES,
    logger,
    trustProxy: true,
  });

  // The ONLY client construction in the app, and it is always wrapped: a test
  // that injects a client still exercises the backstop, and nothing can write
  // around the audit log by holding the bare client. The seed is the one other
  // constructor and goes through the same factory.
  const prisma = createAuditedDb(opts.prisma ?? new PrismaClient(), app.log);
  const blobs = opts.blobs ?? (await createBlobStore(config));
  await assertAuditGuard(prisma, config, app.log);

  app.decorate('db', prisma);
  app.decorate('blobs', blobs);
  app.decorate('config', config);
  app.decorateRequest('authedUser', null);
  app.decorateRequest('rawBody', undefined);

  // Capture the raw body for every request so `/api/*` can HMAC-verify it, while
  // still exposing parsed JSON to handlers. Multipart bodies stay as a Buffer;
  // handlers parse them with busboy from `req.rawBody`.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (err) {
      done(err as Error);
    }
  });
  app.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      req.rawBody = body;
      done(null, body);
    },
  );

  // Seed the audit request context for every request, on the ROOT instance so
  // it covers /api as well as /web; the auth guards bind the actor into it once
  // they know who is asking. Callback form on purpose: `run(store, done)` makes
  // every later hook, the body parser, the handler and any promise they spawn
  // execute inside the store, which an async hook would not guarantee.
  app.addHook('onRequest', (req, _reply, done) => {
    auditContext.run(newAuditContext(req.id, req.log), done);
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Central error handling: HttpError → its status, zod → 400, else 500.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'Validation failed', issues: err.issues });
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({ error: 'Too many requests' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'Internal server error' });
  });

  await app.register(registerApiRoutes, { prefix: '/api' });
  await app.register(registerWebRoutes, { prefix: '/web' });

  // Serve the built web SPA if present (Phase 2+). Falls back to index.html for
  // client-side routes. In dev, the Vite server serves the UI instead.
  // `wildcard: true` serves files dynamically at request time (missing files fall
  // through to the SPA handler below) instead of globbing the directory once at
  // boot — so rebuilding the SPA with new hashed asset filenames is picked up
  // without needing to restart the server.
  const webDist = resolveWebDist();
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/web')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

/**
 * The audit log's append-only guarantee is a database trigger that Prisma
 * neither generates nor introspects, so a database created with `prisma db
 * push` has the table and not the guard — and nothing else would ever notice.
 * This is what makes "only the migration path is supported" a rule the server
 * enforces: fatal in production, a warning in development and test, where the
 * database is disposable and the itest for the trigger is the real check.
 */
async function assertAuditGuard(
  db: PrismaClient,
  config: ServerConfig,
  log: FastifyBaseLogger,
): Promise<void> {
  let reason: string;
  try {
    const rows = await db.$queryRaw<
      unknown[]
    >`SELECT 1 FROM pg_trigger WHERE tgname = 'audit_entries_guard'`;
    if (rows.length > 0) return;
    reason =
      'the trigger is missing; was the database created with `prisma db push`? Only `prisma migrate deploy` installs it';
  } catch (err) {
    reason = `the check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  const message = `audit log guard trigger audit_entries_guard not found — ${reason}`;
  if (config.isProd) throw new Error(message);
  log.warn(message);
}

function resolveWebDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../web/dist'), // running from dist/
    join(here, '../../../web/dist'), // running from src/ via tsx
  ];
  return candidates.find((p) => existsSync(join(p, 'index.html'))) ?? null;
}
