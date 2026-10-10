import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import { z } from 'zod';
import { verifyPassword } from '../../auth/password.js';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSession,
  destroySession,
  resolveSession,
} from '../../auth/session.js';
import { HttpError, requireAuth, toAuthedUser } from '../../auth/guards.js';
import { bindAuditActor } from '../../audit/context.js';
import {
  auditCtx,
  coalesceOrInsert,
  q,
  recordAudit,
  withIntent,
  type AuditCtx,
} from '../../services/audit.js';
import { createLocalUser } from '../../services/users.js';
import { serializeUser } from '../../services/serializers.js';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const setupSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

/**
 * AUDIT. These handlers run before any auth guard, so nothing has bound an
 * actor to the request's audit store when they start: each one does it by
 * hand, through the same `toAuthedUser` the guards use, the moment it knows
 * who the user is — and `auditCtx(req)` then picks the actor up from the store.
 * Binding early is what attributes POST /setup's own `user.create` to the
 * admin it creates, and a failed sign-in to the account it was aimed at.
 *
 * What is and is not recorded here follows DECISIONS: sign-in, sign-out and a
 * recovery-link sign-in are events on the `user`; a wrong password against a
 * KNOWN, LIVE account is recorded and coalesced on the fixed key `auth-fail`
 * (so a burst folds to one row with a count, and an attacker cannot write
 * unbounded permanent rows); an attempt against an unknown email, or against a
 * disabled or deleted account, writes NOTHING — there is no attributable live
 * actor, and an attacker-chosen string must never become a log line an admin
 * reads. Session and AuthIdentity are unaudited models, so the backstop stays
 * silent for every write in this file; only the `user` create in /setup is an
 * audited write, and it is wrapped so the hand-written entry speaks for it.
 */
function bindActor(req: FastifyRequest, user: User): AuditCtx {
  bindAuditActor(toAuthedUser(user, 'session'));
  return auditCtx(req);
}

/** The entity every sign-in entry is about: the user, by slug, labelled as the backstop would. */
function userEntity(user: User): { id: string; label: string } {
  return { id: user.slug, label: `${user.firstName} ${user.lastName}`.trim() || user.email };
}

function setSessionCookie(app: FastifyInstance, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: app.config.cookieSecure,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Public: what the SPA needs to render login/setup.
  app.get('/flags', async () => {
    const userCount = await app.db.user.count();
    return {
      appName: 'reporter',
      needsSetup: userCount === 0,
      oidcEnabled: app.config.oidcEnabled,
      webauthnEnabled: app.config.webauthnEnabled,
    };
  });

  // One-time first-admin creation; only works while there are zero users.
  app.post('/setup', async (req, reply) => {
    const body = setupSchema.parse(req.body);
    const userCount = await app.db.user.count();
    if (userCount > 0) throw new HttpError(409, 'Setup has already been completed');

    // The first admin creates themselves: the actor is bound as soon as the row
    // exists, inside the scope, so the create entry — and the sign-in after it —
    // carry their name rather than reading as a system write.
    let ctx: AuditCtx | undefined;
    const user = await withIntent(['user'], async () => {
      const created = await createLocalUser(app.db, { ...body, admin: true });
      ctx = bindActor(req, created);
      await recordAudit(ctx, {
        action: 'create',
        entityType: 'user',
        entity: userEntity(created),
        summary: `Created the first admin account ${q(userEntity(created).label)} (${created.email})`,
        changes: [
          { kind: 'field', field: 'firstName', from: null, to: created.firstName },
          { kind: 'field', field: 'lastName', from: null, to: created.lastName },
          { kind: 'field', field: 'email', from: null, to: created.email },
          { kind: 'field', field: 'admin', from: null, to: true },
          { kind: 'count', label: 'Identities created', count: 1 },
        ],
      });
      return created;
    });
    const token = await createSession(app.db, user.id);
    setSessionCookie(app, reply, token);
    await recordAudit(ctx ?? bindActor(req, user), {
      action: 'sign_in',
      entityType: 'user',
      entity: userEntity(user),
      summary: 'Signed in',
    });
    return { user: serializeUser(user) };
  });

  app.post(
    '/login',
    { config: { rateLimit: { max: app.config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, password } = loginSchema.parse(req.body);
      const identity = await app.db.authIdentity.findFirst({
        where: { scheme: 'local', identifier: email },
        include: { user: true },
      });

      const ok = identity?.passwordHash && (await verifyPassword(identity.passwordHash, password));
      if (!identity || !ok || identity.user.disabled || identity.user.deletedAt) {
        // Recorded only for a known, live account whose password did not verify
        // — attributed to that account, folded on `auth-fail`. Unknown emails
        // and disabled or deleted accounts leave no trace (see the header). The
        // write is awaited before the 401 so it cannot outlive the request, and
        // the response is the same uniform message either way.
        if (identity && !ok && !identity.user.disabled && !identity.user.deletedAt) {
          await coalesceOrInsert(bindActor(req, identity.user), {
            action: 'sign_in_failed',
            entityType: 'user',
            entity: userEntity(identity.user),
            summary: 'Failed sign-in: wrong password',
            coalesceKey: 'auth-fail',
          });
        }
        throw new HttpError(401, 'Invalid email or password');
      }

      const ctx = bindActor(req, identity.user);
      await app.db.authIdentity.update({
        where: { id: identity.id },
        data: { lastLogin: new Date() },
      });
      const token = await createSession(app.db, identity.user.id);
      setSessionCookie(app, reply, token);
      await recordAudit(ctx, {
        action: 'sign_in',
        entityType: 'user',
        entity: userEntity(identity.user),
        summary: 'Signed in',
      });
      return { user: serializeUser(identity.user) };
    },
  );

  // Redeem an admin-issued one-time recovery link (see POST /admin/users/:slug/recovery).
  // Rate-limited like /login; the code is single-use and 24h-expiring.
  app.post(
    '/login/recovery',
    { config: { rateLimit: { max: app.config.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { code } = z.object({ code: z.string().min(1) }).parse(req.body);
      const codeHash = createHash('sha256').update(code).digest('hex');
      const recovery = await app.db.recoveryCode.findUnique({
        where: { codeHash },
        include: { user: true },
      });
      const valid =
        recovery &&
        !recovery.usedAt &&
        recovery.expiresAt > new Date() &&
        !recovery.user.disabled &&
        !recovery.user.deletedAt;
      if (!valid) throw new HttpError(401, 'This recovery link is invalid or has expired');

      // Atomic single-use claim: concurrent redemptions race on usedAt, and
      // exactly one wins. Losers get the same 401 as an invalid code.
      const claimed = await app.db.recoveryCode.updateMany({
        where: { id: recovery.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new HttpError(401, 'This recovery link is invalid or has expired');
      }
      // The claim won: from here the request is this user's.
      const ctx = bindActor(req, recovery.user);

      // Recovery implies the old credentials may be compromised: burn any
      // other outstanding codes and revoke every existing session so only
      // the recovery session can use the current-password waiver below.
      const burned = await app.db.recoveryCode.updateMany({
        where: { userId: recovery.user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      const revoked = await app.db.session.deleteMany({ where: { userId: recovery.user.id } });

      // The user signed in without their password, so require them to set a
      // new one (the account password route waives "current password" once).
      await app.db.authIdentity.updateMany({
        where: { userId: recovery.user.id, scheme: 'local' },
        data: { mustResetPassword: true, lastLogin: new Date() },
      });

      const token = await createSession(app.db, recovery.user.id);
      setSessionCookie(app, reply, token);
      // The side effects are the story: how many sessions this sign-in cut off
      // and how many other links it burned. The code itself is never stored.
      await recordAudit(ctx, {
        action: 'recovery_code_used',
        entityType: 'user',
        entity: userEntity(recovery.user),
        summary: 'Signed in with a recovery link; other sessions and recovery links revoked',
        changes: [
          { kind: 'count', label: 'Sessions revoked', count: revoked.count },
          { kind: 'count', label: 'Other recovery links burned', count: burned.count },
        ],
      });
      return { user: serializeUser(recovery.user) };
    },
  );

  app.post('/logout', async (req, reply) => {
    // Resolve the session BEFORE destroying it: that is the only moment the
    // sign-out can still be attributed. No live session (already signed out,
    // expired, a stale cookie) means nothing happened worth recording.
    const token = req.cookies?.[SESSION_COOKIE];
    const user = await resolveSession(app.db, token);
    await destroySession(app.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    if (user) {
      await recordAudit(bindActor(req, user), {
        action: 'sign_out',
        entityType: 'user',
        entity: userEntity(user),
        summary: 'Signed out',
      });
    }
    return { ok: true };
  });

  app.get('/me', { preHandler: requireAuth }, async (req) => {
    const user = await app.db.user.findUniqueOrThrow({ where: { id: req.authedUser!.id } });
    const identity = await app.db.authIdentity.findFirst({
      where: { userId: user.id, scheme: 'local' },
      select: { mustResetPassword: true },
    });
    return {
      user: serializeUser(user, { mustResetPassword: identity?.mustResetPassword ?? false }),
    };
  });
}
