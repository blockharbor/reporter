import type { FastifyReply, FastifyRequest } from 'fastify';
import { isDateWithinSkew, parseAuthorization, verifySignature } from '@reporter/api-client';
import { ENGAGEMENT_ROLES, ROLE_RANK, type EngagementRole } from '@reporter/shared';
import type { User } from '@prisma/client';
import type { AuthedUser } from '../types.js';
import { bindAuditActor } from '../audit/context.js';
import { auditCtx, coalesceOrInsert } from '../services/audit.js';
import { SESSION_COOKIE, resolveSession } from './session.js';

/**
 * The request principal from a user row. Exported for the pre-guard sign-in
 * handlers (setup, login, recovery), which know their user before any guard
 * ran and must `bindAuditActor` it themselves so their entries are attributed.
 */
export function toAuthedUser(user: User, via: AuthedUser['via']): AuthedUser {
  return {
    id: user.id,
    slug: user.slug,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    admin: user.admin,
    via,
  };
}

/** A thrown error that carries an HTTP status; caught by the app error handler. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Web-plane auth: resolve the session cookie or 401. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  const user = await resolveSession(req.server.db, token);
  if (!user) throw new HttpError(401, 'Not authenticated');
  req.authedUser = toAuthedUser(user, 'session');
  // From here every write in this request is attributed to the session user.
  bindAuditActor(req.authedUser);
}

/** Client-API-plane auth: verify the HMAC signature or a uniform 401. */
export async function requireApiAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const fail = () => new HttpError(401, 'Unauthorized');

  const parsed = parseAuthorization(req.headers['authorization']);
  const date = req.headers['date'];
  if (!parsed || typeof date !== 'string' || !isDateWithinSkew(date)) throw fail();

  const apiKey = await req.server.db.apiKey.findUnique({
    where: { accessKey: parsed.accessKey },
    include: { user: true },
  });
  if (!apiKey || apiKey.user.disabled || apiKey.user.deletedAt) throw fail();

  // Path must include the query string exactly as signed.
  const ok = verifySignature(
    {
      method: req.method,
      path: req.url,
      date,
      body: req.rawBody ?? Buffer.alloc(0),
      secretKeyBase64: Buffer.from(apiKey.secretKey).toString('base64'),
    },
    parsed.signature,
  );
  if (!ok) throw fail();

  req.authedUser = toAuthedUser(apiKey.user, 'apikey');
  bindAuditActor(req.authedUser);

  // The one audit entry a guard writes: an API key authenticated, attributed to
  // the user behind it and to nothing else — no key id, no access key, no IP
  // (DECISIONS: "No key id, no IP stored"), and `entityId` is the user's slug so
  // the entry threads with the same user's sign-ins. Awaited, because no audit
  // write may outlive its request; best-effort, because `coalesceOrInsert` logs
  // and swallows outside a transaction and a client request must never fail on
  // the log. Coalesced on the fixed key `auth`, so a capture client polling
  // every few seconds is one entry with a count, not a row per request.
  const u = req.authedUser;
  await coalesceOrInsert(auditCtx(req), {
    action: 'api_key_auth',
    entityType: 'user',
    entity: { id: u.slug, label: `${u.firstName} ${u.lastName}`.trim() || u.email },
    summary: 'Authenticated with an API key',
    coalesceKey: 'auth',
  });

  // Best-effort last-auth stamp; don't block the request on it. Deliberately
  // fire-and-forget and deliberately unaudited (ApiKey has no model spec): a
  // write that may complete after the response cannot be attributed with
  // confidence — see audit/context.ts on the store's lifetime.
  void req.server.db.apiKey
    .update({ where: { id: apiKey.id }, data: { lastAuth: new Date() } })
    .catch(() => {});
}

/** Requires the authenticated user to be a site admin. Run after an auth guard. */
export async function requireAdmin(req: FastifyRequest): Promise<void> {
  if (!req.authedUser?.admin) throw new HttpError(403, 'Admin only');
}

/**
 * Returns a preHandler that requires at least `minRole` on the engagement named
 * by `:slug`. Site admins bypass. Run after an auth guard.
 */
export function requireEngagementRole(minRole: EngagementRole) {
  return async (req: FastifyRequest): Promise<void> => {
    const user = req.authedUser;
    if (!user) throw new HttpError(401, 'Not authenticated');

    const slug = (req.params as { slug?: string }).slug;
    if (!slug) throw new HttpError(400, 'Missing engagement slug');

    const engagement = await req.server.db.engagement.findUnique({ where: { slug } });
    if (!engagement) throw new HttpError(404, 'Engagement not found');

    if (user.admin) return; // site admins can access every engagement

    const role = await req.server.db.userEngagementRole.findUnique({
      where: { userId_engagementId: { userId: user.id, engagementId: engagement.id } },
    });
    if (!role || ROLE_RANK[role.role] < ROLE_RANK[minRole]) {
      throw new HttpError(403, 'Insufficient role for this engagement');
    }
  };
}

/**
 * The engagement roles that count as "writes reports" for the global report-template
 * library. Derived from `ROLE_RANK` rather than listed, so adding a role between
 * `read` and `write` can't silently fall on the permissive side of this guard.
 */
const TEMPLATE_MANAGE_ROLES: EngagementRole[] = ENGAGEMENT_ROLES.filter(
  (r) => ROLE_RANK[r] >= ROLE_RANK.write,
);

/**
 * Requires a user who may manage the global report-template library: a site admin,
 * or anyone holding `write`/`admin` on at least one engagement. Run after an auth
 * guard. Mirrors `requireEngagementRole`'s error semantics — 401 when unauthed,
 * 403 when authed but short of the bar — but takes no `:slug`, because a template
 * belongs to no engagement.
 *
 * This is deliberately NOT admin-only, and should not be "tightened" to
 * `requireAdmin`: templates are a working artifact of the people who actually
 * write reports, and routing "save the configuration I just built" through a site
 * admin would leave the library stale exactly when an operator needs a new entry.
 * Using a template — listing, applying, generating with one — is gated on nothing
 * but authentication; only managing the library passes through here.
 */
export async function requireReportTemplateManager(req: FastifyRequest): Promise<void> {
  const user = req.authedUser;
  if (!user) throw new HttpError(401, 'Not authenticated');
  if (user.admin) return; // site admins manage every site-wide list

  // One query: does this user hold a writing role on any engagement at all?
  const writing = await req.server.db.userEngagementRole.findFirst({
    where: { userId: user.id, role: { in: TEMPLATE_MANAGE_ROLES } },
    select: { id: true },
  });
  if (!writing) {
    throw new HttpError(
      403,
      'Write access on an engagement is required to manage report templates',
    );
  }
}
