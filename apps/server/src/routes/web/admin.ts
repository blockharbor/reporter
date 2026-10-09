import { randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CANNOT_DELETE_SELF,
  defaultTagColorFor,
  tagColorNameSchema,
  type AdminEngagement,
  type AdminUser,
} from '@reporter/shared';
import { HttpError, requireAdmin, requireAuth } from '../../auth/guards.js';
import {
  assertSiteKeepsAnAdmin,
  countUserDeletionImpact,
  createLocalUser,
  siteAdminBlockReason,
} from '../../services/users.js';
import { serializeApiKey, serializeEngagement, serializeUser } from '../../services/serializers.js';

const adminGuard = [requireAuth, requireAdmin];

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // --- Users ---
  app.get('/admin/users', { preHandler: adminGuard }, async (): Promise<AdminUser[]> => {
    const users = await app.db.user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      // Filter in the query — never materialize TOTP secrets for a list view.
      include: { identities: { where: { totpSecret: { not: null } }, select: { id: true } } },
    });
    return users.map((u) => ({
      ...serializeUser(u),
      hasTotp: u.identities.length > 0,
    }));
  });

  app.post('/admin/users', { preHandler: adminGuard }, async (req, reply) => {
    const body = z
      .object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email(),
        password: z.string().min(8).optional(),
        admin: z.boolean().default(false),
        headless: z.boolean().default(false),
      })
      .parse(req.body);

    // Deleting a user is a hard delete, which frees its unique email, so this only
    // collides with a live account — or with a row the old soft-delete left behind,
    // which the list view above hides and which therefore needs saying out loud.
    const exists = await app.db.user.findUnique({ where: { email: body.email } });
    if (exists) {
      throw new HttpError(
        409,
        exists.deletedAt
          ? 'A previously deleted account still holds that email address'
          : 'A user with that email already exists',
      );
    }

    const user = await createLocalUser(app.db, {
      ...body,
      mustResetPassword: Boolean(body.password),
    });
    reply.status(201);
    return serializeUser(user);
  });

  app.put('/admin/users/:slug', { preHandler: adminGuard }, async (req) => {
    const { slug } = req.params as { slug: string };
    const body = z
      .object({ admin: z.boolean().optional(), disabled: z.boolean().optional() })
      .parse(req.body);
    const user = await app.db.user.findUnique({ where: { slug } });
    if (!user) throw new HttpError(404, 'User not found');
    // Demoting or disabling the last admin would lock everyone out of the Admin panel
    // for good, so the patch is judged by the standing it leaves the user with.
    await assertSiteKeepsAnAdmin(app.db, user, {
      admin: body.admin ?? user.admin,
      disabled: body.disabled ?? user.disabled,
    });
    const updated = await app.db.user.update({ where: { id: user.id }, data: body });
    return serializeUser(updated);
  });

  // What deleting this user would do, so the confirm dialog can warn before the
  // click. A per-user route rather than extra columns on `GET /admin/users`: these
  // are correlated subqueries that only the one user being deleted ever needs, and
  // the list view is re-fetched on every visit to the Admin panel.
  app.get('/admin/users/:slug/impact', { preHandler: adminGuard }, async (req) => {
    const { slug } = req.params as { slug: string };
    const user = await app.db.user.findUnique({ where: { slug } });
    if (!user) throw new HttpError(404, 'User not found');
    const impact = await countUserDeletionImpact(app.db, user.id);
    // The same refusals, in the same words, the DELETE below would answer with — so
    // the dialog can disable the button and explain instead of posting a doomed
    // request.
    const blockedReason =
      user.id === req.authedUser!.id
        ? CANNOT_DELETE_SELF
        : await siteAdminBlockReason(app.db, user, null);
    return { slug: user.slug, ...impact, canDelete: blockedReason === null, blockedReason };
  });

  // Hard delete with anonymization. The row is really removed — which also frees its
  // unique email for reuse — and the schema's referential actions do the rest:
  // sessions, API keys, auth identities, WebAuthn credentials, recovery codes,
  // engagement roles and the engagement/evidence prefs cascade away, while the
  // evidence this user captured, the comments they wrote, their last-edited stamps
  // and the reports they generated all survive with their user reference set to NULL
  // (every display site renders "Deleted user"). Evidence is the client deliverable,
  // so it has to outlive its author; nothing is hand-deleted here that the database
  // already handles.
  app.delete('/admin/users/:slug', { preHandler: adminGuard }, async (req) => {
    const { slug } = req.params as { slug: string };
    const user = await app.db.user.findUnique({ where: { slug } });
    if (!user) throw new HttpError(404, 'User not found');
    if (user.id === req.authedUser!.id) throw new HttpError(400, CANNOT_DELETE_SELF);
    await assertSiteKeepsAnAdmin(app.db, user, null);

    // Count inside the transaction, before the row goes, so the numbers handed back
    // describe exactly the rows this delete anonymized and revoked.
    const impact = await app.db.$transaction(async (tx) => {
      const counts = await countUserDeletionImpact(tx, user.id);
      await tx.user.delete({ where: { id: user.id } });
      return counts;
    });
    return { ok: true as const, slug: user.slug, ...impact };
  });

  // Generate a one-time recovery login link (admin-issued).
  app.post('/admin/users/:slug/recovery', { preHandler: adminGuard }, async (req) => {
    const { slug } = req.params as { slug: string };
    const user = await app.db.user.findUnique({ where: { slug } });
    if (!user) throw new HttpError(404, 'User not found');
    const code = randomBytes(24).toString('base64url');
    const codeHash = createHash('sha256').update(code).digest('hex');
    await app.db.recoveryCode.create({
      data: { userId: user.id, codeHash, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    // The code is returned once; the admin shares the /login/recovery/<code> link.
    return { recoveryUrl: `${app.config.APP_URL}/login/recovery/${code}` };
  });

  // Clear the user's TOTP secret(s) so they re-enroll on next login. A no-op
  // (nothing enrolled) still succeeds; `hadTotp` tells the caller which it was.
  app.post('/admin/users/:slug/totp-reset', { preHandler: adminGuard }, async (req) => {
    const { slug } = req.params as { slug: string };
    const user = await app.db.user.findUnique({ where: { slug } });
    if (!user) throw new HttpError(404, 'User not found');
    const { count } = await app.db.authIdentity.updateMany({
      where: { userId: user.id, totpSecret: { not: null } },
      data: { totpSecret: null },
    });
    return { ok: true, hadTotp: count > 0 };
  });

  // --- Per-user API keys (visibility + revocation) ---
  app.get('/admin/users/:slug/api-keys', { preHandler: adminGuard }, async (req) => {
    const { slug } = req.params as { slug: string };
    const user = await app.db.user.findUnique({ where: { slug } });
    if (!user) throw new HttpError(404, 'User not found');
    const keys = await app.db.apiKey.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    return keys.map(serializeApiKey);
  });

  app.delete('/admin/users/:slug/api-keys/:accessKey', { preHandler: adminGuard }, async (req) => {
    const { slug, accessKey } = req.params as { slug: string; accessKey: string };
    const user = await app.db.user.findUnique({ where: { slug } });
    if (!user) throw new HttpError(404, 'User not found');
    const key = await app.db.apiKey.findUnique({ where: { accessKey } });
    if (!key || key.userId !== user.id) throw new HttpError(404, 'API key not found');
    await app.db.apiKey.delete({ where: { id: key.id } });
    return { ok: true };
  });

  // --- Engagements (site-wide view; per-engagement mutations reuse the
  // /engagements/:slug routes, which site admins already bypass into) ---
  app.get(
    '/admin/engagements',
    { preHandler: adminGuard },
    async (req): Promise<AdminEngagement[]> => {
      const engs = await app.db.engagement.findMany({
        include: {
          _count: { select: { evidence: true, roles: true, findings: true } },
          roles: { where: { userId: req.authedUser!.id }, select: { role: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      return engs.map((eng) => ({
        ...serializeEngagement(eng, {
          numUsers: eng._count.roles,
          numEvidence: eng._count.evidence,
          numFindings: eng._count.findings,
        }),
        amMember: eng.roles.length > 0,
      }));
    },
  );

  // --- Default tags ---
  app.get('/admin/default-tags', { preHandler: adminGuard }, async () => {
    return app.db.defaultTag.findMany({ orderBy: { name: 'asc' } });
  });

  app.post('/admin/default-tags', { preHandler: adminGuard }, async (req, reply) => {
    // Palette-constrained like the engagement tag inputs: a DefaultTag is copied
    // verbatim into every new engagement, so an off-palette value here would seed
    // every future engagement with a tag that renders as slate.
    const body = z
      .object({ name: z.string().min(1).max(64), colorName: tagColorNameSchema.optional() })
      .parse(req.body);
    const created = await app.db.defaultTag.create({
      data: { name: body.name, colorName: body.colorName ?? defaultTagColorFor(body.name) },
    });
    reply.status(201);
    return created;
  });

  app.delete('/admin/default-tags/:id', { preHandler: adminGuard }, async (req) => {
    const { id } = req.params as { id: string };
    await app.db.defaultTag.delete({ where: { id: Number(id) } }).catch(() => {});
    return { ok: true };
  });

  // Finding categories are managed per-engagement (Settings → Finding categories),
  // not globally — there is no site-wide category taxonomy anymore.
}
