import type { FastifyInstance } from 'fastify';
import {
  auditListQuerySchema,
  removeAuditEntryInput,
  uuidSchema,
  type AuditFacets,
  type AuditLogPage,
  type RemoveAuditEntryResult,
} from '@reporter/shared';
import { requireAdmin, requireAuth, requireEngagementRole } from '../../auth/guards.js';
import { parsePagination } from '../../helpers/pagination.js';
import { auditFacets, listAuditEntries, removeAuditEntry } from '../../services/audit-query.js';
import { serializeAuditEntry } from '../../services/serializers.js';

/**
 * Audit log, read side (services/audit-query.ts does the work). Two planes:
 *
 *  - `/engagements/:slug/audit-log` is the engagement tab — the first
 *    role-hidden tab in the app. `write` and `admin` members, plus site admins
 *    through `requireEngagementRole`'s bypass; a read-only member gets 403,
 *    because the log shows membership changes, client-name edits and
 *    report-exclusion decisions they see nowhere else. The scope is fixed by
 *    the guard's slug, so `eng`/`noEng` in the querystring are parsed and then
 *    ignored by the service rather than refused.
 *  - `/admin/audit-log` is the site-wide log and carries the only removal
 *    route. Site admins only (DECISIONS, 2026-10-09): the legitimate use of a
 *    removal is purging a credential or PII that landed in a diff, which is a
 *    site-operator action, and letting the owner of an engagement remove their
 *    own entries would weaken exactly the tamper evidence the log exists for.
 *
 * The querystring is parsed with `auditListQuerySchema` from @reporter/shared
 * — the first zod-parsed `req.query` on the server; every other list casts —
 * because this filter has real shape (repeated keys, closed enums, dates) and
 * a 400 with issues beats a silently ignored facet. `page`/`pageSize` stay
 * with `parsePagination` on the raw query, as every list does; do not move
 * them into the schema, or the 250 cap goes with them.
 */
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const engagementGuard = [requireAuth, requireEngagementRole('write')];
  const adminGuard = [requireAuth, requireAdmin];

  app.get(
    '/engagements/:slug/audit-log',
    { preHandler: engagementGuard },
    async (req): Promise<AuditLogPage> => {
      const { slug } = req.params as { slug: string };
      // The guard already 404s on an unknown slug; this only fetches the id.
      const eng = await app.db.engagement.findUniqueOrThrow({
        where: { slug },
        select: { id: true },
      });
      const query = auditListQuerySchema.parse(req.query);
      return listAuditEntries(
        app.db,
        { kind: 'engagement', engagementId: eng.id },
        query,
        parsePagination(req.query as Record<string, unknown>),
      );
    },
  );

  app.get(
    '/engagements/:slug/audit-log/facets',
    { preHandler: engagementGuard },
    async (req): Promise<AuditFacets> => {
      const { slug } = req.params as { slug: string };
      const eng = await app.db.engagement.findUniqueOrThrow({
        where: { slug },
        select: { id: true },
      });
      return auditFacets(app.db, { kind: 'engagement', engagementId: eng.id });
    },
  );

  app.get('/admin/audit-log', { preHandler: adminGuard }, async (req): Promise<AuditLogPage> => {
    const query = auditListQuerySchema.parse(req.query);
    return listAuditEntries(
      app.db,
      { kind: 'site' },
      query,
      parsePagination(req.query as Record<string, unknown>),
    );
  });

  app.get('/admin/audit-log/facets', { preHandler: adminGuard }, async (): Promise<AuditFacets> =>
    auditFacets(app.db, { kind: 'site' }),
  );

  // A POST, not a DELETE: nothing is deleted — the row becomes a tombstone in
  // place — and the reason travels in the body, which is what the tombstone
  // shows forever. The web plane's CSRF preHandler (index.ts) covers it.
  app.post(
    '/admin/audit-log/:uuid/remove',
    { preHandler: adminGuard },
    async (req): Promise<RemoveAuditEntryResult> => {
      const uuid = uuidSchema.parse((req.params as { uuid: string }).uuid);
      const { reason } = removeAuditEntryInput.parse(req.body ?? {});
      const row = await removeAuditEntry(app.db, uuid, req.authedUser!, reason);
      return { entry: serializeAuditEntry(row) };
    },
  );
}
