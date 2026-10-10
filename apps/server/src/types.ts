import 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { ContentStore } from './blobstore/index.js';
import type { ServerConfig } from './config.js';

/** The authenticated principal attached to a request by an auth preHandler. */
export interface AuthedUser {
  id: number;
  slug: string;
  email: string;
  firstName: string;
  lastName: string;
  admin: boolean;
  /** How this request authenticated: web session or client API key. */
  via: 'session' | 'apikey';
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The Prisma client WITH the audit backstop applied (`audit/extension.ts`).
     * Every write through it — and through the `tx` its `$transaction` yields —
     * is recorded in the audit log unless the request's audit context suppresses
     * it (`withIntent`, `withImporter`) or the write runs inside a transaction,
     * where only a `withIntent`-wrapped handler's own entries are recorded.
     * Typed as the plain `PrismaClient` through a documented cast: the query
     * extension changes no argument or result types. Never construct a second
     * client to write around it.
     */
    db: PrismaClient;
    blobs: ContentStore;
    config: ServerConfig;
  }
  interface FastifyRequest {
    /** Raw request body bytes, captured for HMAC verification on `/api/*`. */
    rawBody?: Buffer;
    /** Set by `requireAuth` / `requireApiAuth`; null until authenticated. */
    authedUser: AuthedUser | null;
  }
}
