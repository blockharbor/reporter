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
  AUDIT_TX_MAX_WAIT_MS,
  AUDIT_TX_TIMEOUT_MS,
  auditCtx,
  inTx,
  n,
  q,
  recordAudit,
  withIntent,
} from '../../services/audit.js';
import {
  assertSiteKeepsAnAdmin,
  countUserDeletionImpact,
  createLocalUser,
  siteAdminBlockReason,
} from '../../services/users.js';
import { serializeApiKey, serializeEngagement, serializeUser } from '../../services/serializers.js';

const adminGuard = [requireAuth, requireAdmin];

/** The user's handle in a summary: the same label the backstop gives a `user` row. */
function displayName(u: { firstName: string; lastName: string; email: string }): string {
  return `${u.firstName} ${u.lastName}`.trim() || u.email;
}

// AUDIT. Everything in this file is site administration, so every entry here
// has no engagement (`auditCtx(req)`) and lands in the admin log only. The
// backstop already records what the row-level truth describes well — a user
// created (with its nested identity as a count only), a default tag added or
// removed, and the profile-style edits — so those handlers add nothing. Hand-
// written entries cover the rest: the admin toggles, where a fold would turn
// "disabled then re-enabled" into one entry whose before and after agree; the
// user delete, which runs in a transaction the backstop cannot see and whose
// cascades it could not count anyway; and the credential flows (recovery link,
// TOTP reset, API-key revoke), whose models are deliberately unaudited so no
// generic diff can ever carry a hash. The only identity an API-key entry has is
// `String(apiKey.id)`: `entityId` survives a removal, so the access key — public
// as it is — is not written anywhere in the table.

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

    // One discrete entry per flag that actually flips, through `recordAudit` and
    // never the fold: an admin who disables a user and re-enables them a minute
    // later must leave two lines, not one whose before and after both read
    // `false`. A no-op PUT (the same values again) stays outside the scope — the
    // backstop sees an update with no diff and writes nothing, and a scope with
    // a listed write and no entry would trip.
    const name = displayName(user);
    const flips: Array<{
      field: 'admin' | 'disabled';
      from: boolean;
      to: boolean;
      summary: string;
    }> = [];
    if (body.admin !== undefined && body.admin !== user.admin) {
      flips.push({
        field: 'admin',
        from: user.admin,
        to: body.admin,
        summary: body.admin
          ? `Granted site admin to ${q(name)}`
          : `Revoked site admin from ${q(name)}`,
      });
    }
    if (body.disabled !== undefined && body.disabled !== user.disabled) {
      flips.push({
        field: 'disabled',
        from: user.disabled,
        to: body.disabled,
        summary: body.disabled ? `Disabled user ${q(name)}` : `Enabled user ${q(name)}`,
      });
    }
    const update = () => app.db.user.update({ where: { id: user.id }, data: body });
    if (flips.length === 0) return serializeUser(await update());

    const ctx = auditCtx(req);
    const updated = await withIntent(['user'], async () => {
      const row = await update();
      for (const flip of flips) {
        await recordAudit(ctx, {
          action: 'update',
          entityType: 'user',
          entity: { id: user.slug, label: name },
          summary: flip.summary,
          changes: [{ kind: 'field', field: flip.field, from: flip.from, to: flip.to }],
        });
      }
      return row;
    });
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
    //
    // The audit entry is written INSIDE the transaction, through `tx`, and
    // BEFORE the delete: the two commit or roll back together, so an unlogged
    // user deletion is impossible, and the entry exists when the schema's
    // `SET NULL` on audit_entries.actor_id runs — it is the admin's entry, so
    // nothing on it is nulled, while the deleted user's own earlier entries keep
    // their name and email snapshots. `withIntent` names the models the delete
    // speaks for: `user` is the one Prisma write; the rest are the cascades and
    // anonymizations the database performs (invisible to the backstop) that the
    // counts describe. The explicit limits matter: every audit row naming this
    // user fires the guard trigger on its way to NULL, and Prisma's 5 s default
    // was sized for a handful of statements, not a long-lived engagement's log.
    const name = displayName(user);
    const ctx = auditCtx(req);
    const impact = await withIntent(
      ['user', 'userEngagementRole', 'evidence', 'evidenceComment', 'apiKey'],
      () =>
        app.db.$transaction(
          async (tx) => {
            const counts = await countUserDeletionImpact(tx, user.id);
            await recordAudit(inTx(ctx, tx), {
              action: 'delete',
              entityType: 'user',
              entity: { id: user.slug, label: name },
              summary:
                `Deleted user ${q(name)} (${user.email}): ` +
                `${n(counts.evidence, 'evidence', 'evidence')} and ${n(counts.comments, 'comment')} anonymized, ` +
                `${n(counts.engagements, 'membership')} and ${n(counts.apiKeys, 'API key')} revoked`,
              changes: [
                { kind: 'field', field: 'email', from: user.email, to: null },
                { kind: 'field', field: 'admin', from: user.admin, to: null },
                { kind: 'count', label: 'Evidence anonymized', count: counts.evidence },
                { kind: 'count', label: 'Comments anonymized', count: counts.comments },
                { kind: 'count', label: 'Memberships revoked', count: counts.engagements },
                { kind: 'count', label: 'API keys revoked', count: counts.apiKeys },
              ],
            });
            await tx.user.delete({ where: { id: user.id } });
            return counts;
          },
          { maxWait: AUDIT_TX_MAX_WAIT_MS, timeout: AUDIT_TX_TIMEOUT_MS },
        ),
    );
    return { ok: true as const, slug: user.slug, ...impact };
  });

  // Generate a one-time recovery login link (admin-issued).
  app.post('/admin/users/:slug/recovery', { preHandler: adminGuard }, async (req) => {
    const { slug } = req.params as { slug: string };
    const user = await app.db.user.findUnique({ where: { slug } });
    if (!user) throw new HttpError(404, 'User not found');
    const code = randomBytes(24).toString('base64url');
    const codeHash = createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await app.db.recoveryCode.create({ data: { userId: user.id, codeHash, expiresAt } });
    // The fact and the expiry are the record; the code and its hash never reach
    // the log (RecoveryCode is unaudited, and this entry carries neither).
    await recordAudit(auditCtx(req), {
      action: 'recovery_link_issued',
      entityType: 'user',
      entity: { id: user.slug, label: displayName(user) },
      summary: `Issued a recovery link for ${q(displayName(user))}`,
      changes: [{ kind: 'field', field: 'expiresAt', from: null, to: expiresAt.toISOString() }],
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
    await recordAudit(auditCtx(req), {
      action: 'totp_reset',
      entityType: 'user',
      entity: { id: user.slug, label: displayName(user) },
      summary: `Reset TOTP for ${q(displayName(user))}${count === 0 ? ' (nothing was enrolled)' : ''}`,
      changes: [{ kind: 'count', label: 'Identities cleared', count }],
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
    // Identified by the row id only. The key's creation time is the one
    // non-secret detail that tells two of a user's keys apart in the UI.
    await recordAudit(auditCtx(req), {
      action: 'delete',
      entityType: 'api_key',
      entity: { id: String(key.id), label: `API key of ${displayName(user)}` },
      summary: `Revoked an API key of ${q(displayName(user))}`,
      changes: [{ kind: 'field', field: 'createdAt', from: key.createdAt.toISOString(), to: null }],
    });
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
