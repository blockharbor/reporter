import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireAuth } from '../../auth/guards.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { generateApiKey } from '../../services/apikeys.js';
import { auditCtx, recordAudit } from '../../services/audit.js';
import { serializeApiKey, serializeUser } from '../../services/serializers.js';
import type { AuthedUser } from '../../types.js';

/** The entity every account entry is about: the signed-in user, by slug. */
function self(u: AuthedUser): { id: string; label: string } {
  return { id: u.slug, label: `${u.firstName} ${u.lastName}`.trim() || u.email };
}

// AUDIT. The profile edit is an ordinary `user.update` the backstop records on
// its own (one coalescable entry per changed name field), so it adds nothing.
// The other three handlers write to the credential models — ApiKey and
// AuthIdentity — which are deliberately unaudited so a generic diff can never
// carry a hash or a secret, and so each records its own entry by hand with no
// values: an API key is named by `String(apiKey.id)` alone (the access key,
// public as it is, never reaches a column that survives a removal), and the
// password change records the fact and whether it spent a recovery waiver.
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/account/api-keys', { preHandler: requireAuth }, async (req) => {
    const keys = await app.db.apiKey.findMany({
      where: { userId: req.authedUser!.id },
      orderBy: { createdAt: 'desc' },
    });
    return keys.map(serializeApiKey);
  });

  app.post('/account/api-keys', { preHandler: requireAuth }, async (req, reply) => {
    const key = await generateApiKey(app.db, req.authedUser!.id);
    // The generator hands back only the pair the client needs; the row id the
    // entry is keyed on is one lookup away, by the (unique) access key.
    const row = await app.db.apiKey.findUnique({
      where: { accessKey: key.accessKey },
      select: { id: true },
    });
    await recordAudit(auditCtx(req), {
      action: 'create',
      entityType: 'api_key',
      entity: { id: row ? String(row.id) : null, label: 'API key' },
      summary: 'Created an API key',
    });
    reply.status(201);
    // secretKey is included exactly once, here.
    return { accessKey: key.accessKey, secretKey: key.secretKey };
  });

  app.delete('/account/api-keys/:accessKey', { preHandler: requireAuth }, async (req) => {
    const { accessKey } = req.params as { accessKey: string };
    const key = await app.db.apiKey.findUnique({ where: { accessKey } });
    if (!key || key.userId !== req.authedUser!.id) throw new HttpError(404, 'API key not found');
    await app.db.apiKey.delete({ where: { id: key.id } });
    // The creation time is the one non-secret detail that tells a user's keys
    // apart in the UI, so a revoke says which one went.
    await recordAudit(auditCtx(req), {
      action: 'delete',
      entityType: 'api_key',
      entity: { id: String(key.id), label: 'API key' },
      summary: 'Revoked an API key',
      changes: [{ kind: 'field', field: 'createdAt', from: key.createdAt.toISOString(), to: null }],
    });
    return { ok: true };
  });

  app.put('/account/profile', { preHandler: requireAuth }, async (req) => {
    const body = z
      .object({ firstName: z.string().min(1).optional(), lastName: z.string().min(1).optional() })
      .parse(req.body);
    const user = await app.db.user.update({ where: { id: req.authedUser!.id }, data: body });
    return serializeUser(user);
  });

  app.post('/account/password', { preHandler: requireAuth }, async (req) => {
    const { currentPassword, newPassword } = z
      .object({ currentPassword: z.string().optional(), newPassword: z.string().min(8) })
      .parse(req.body);

    const identity = await app.db.authIdentity.findFirst({
      where: { userId: req.authedUser!.id, scheme: 'local' },
    });
    if (!identity) throw new HttpError(400, 'Current password is incorrect');
    // A pending reset (recovery-link sign-in) waives the current password once;
    // otherwise it is required and must verify.
    if (!identity.mustResetPassword) {
      const ok =
        identity.passwordHash &&
        currentPassword &&
        (await verifyPassword(identity.passwordHash, currentPassword));
      if (!ok) throw new HttpError(400, 'Current password is incorrect');
    }
    await app.db.authIdentity.update({
      where: { id: identity.id },
      data: { passwordHash: await hashPassword(newPassword), mustResetPassword: false },
    });
    // No values, ever — not the hash, not a length. `mustResetPassword` was read
    // before the update, so the suffix says whether this spent the one-time
    // waiver a recovery sign-in granted.
    await recordAudit(auditCtx(req), {
      action: 'password_changed',
      entityType: 'user',
      entity: self(req.authedUser!),
      summary: `Changed password${identity.mustResetPassword ? ' (after a recovery sign-in)' : ''}`,
    });
    return { ok: true };
  });
}
