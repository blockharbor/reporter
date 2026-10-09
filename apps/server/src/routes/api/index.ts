import type { FastifyInstance } from 'fastify';
import { createEngagementInput, createTagInput, parseQuery } from '@reporter/shared';
import { HttpError, requireApiAuth, requireEngagementRole } from '../../auth/guards.js';
import { createEvidence, listEvidence } from '../../services/evidence.js';
import { serializeEngagement, serializeTag } from '../../services/serializers.js';
import { TAG_ORDER_BY, nextTagPosition } from '../../services/tags.js';
import { parsePagination } from '../../helpers/pagination.js';
import { parseEvidenceRequest } from '../shared-evidence.js';
import { VERSION } from '../../version.js';

/**
 * Registers the client-API plane (`/api/*`). Every route is authenticated by
 * HMAC signature (see @reporter/api-client). Used by the desktop app and
 * terminal recorder.
 */
export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireApiAuth);

  app.get('/checkconnection', async (req) => {
    const u = req.authedUser!;
    return {
      ok: true as const,
      user: { slug: u.slug, firstName: u.firstName, lastName: u.lastName, email: u.email },
      serverVersion: VERSION,
    };
  });

  app.get('/engagements', async (req) => {
    const user = req.authedUser!;
    const engs = await app.db.engagement.findMany({
      where: user.admin ? {} : { roles: { some: { userId: user.id } } },
      include: {
        _count: { select: { evidence: true, roles: true } },
        roles: { where: { userId: user.id }, select: { role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return engs.map((eng) =>
      serializeEngagement(eng, {
        role: user.admin ? 'admin' : eng.roles[0]?.role,
        numUsers: eng._count.roles,
        numEvidence: eng._count.evidence,
      }),
    );
  });

  app.post('/engagements', async (req) => {
    const input = createEngagementInput.parse(req.body);
    const user = req.authedUser!;
    const existing = await app.db.engagement.findUnique({ where: { slug: input.slug } });
    if (existing) throw new HttpError(409, 'An engagement with that slug already exists');
    const defaultTags = await app.db.defaultTag.findMany();
    const eng = await app.db.engagement.create({
      data: {
        slug: input.slug,
        name: input.name,
        projectedEndAt: input.projectedEndAt ? new Date(input.projectedEndAt) : undefined,
        roles: { create: { userId: user.id, role: 'admin' } },
        // Explicit positions, as in the /web create route: the seed list's order
        // becomes the engagement's initial curated tag order.
        tags: {
          create: defaultTags.map((t, i) => ({
            name: t.name,
            colorName: t.colorName,
            position: i,
          })),
        },
      },
    });
    return serializeEngagement(eng, { role: 'admin', numUsers: 1, numEvidence: 0 });
  });

  // The HMAC plane's tag surface is list + create, deliberately. Capture clients
  // (desktop tray, reporter-term) only ever pick a tag or mint one mid-capture —
  // which is also why POST here is idempotent where /web returns 409. Rename,
  // merge, bulk-unapply and reorder are NOT exposed: merge and unapply are
  // irreversible and cross-cutting and belong behind an interactive confirmation
  // that can show the usage counts and the by-name references, and an API key is
  // a long-lived credential sitting on an operator's laptop — handing it the power
  // to strip a tag from every item in an engagement widens the blast radius of a
  // stolen key for no client benefit. Reorder is a preference for human pickers,
  // and clients get its benefit for free through the `orderBy` below.
  app.get('/engagements/:slug/tags', { preHandler: requireEngagementRole('read') }, async (req) => {
    const { slug } = req.params as { slug: string };
    const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
    const tags = await app.db.tag.findMany({
      where: { engagementId: eng.id },
      orderBy: TAG_ORDER_BY,
    });
    return tags.map((t) => serializeTag(t));
  });

  app.post(
    '/engagements/:slug/tags',
    { preHandler: requireEngagementRole('write') },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const input = createTagInput.parse(req.body);
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const existing = await app.db.tag.findUnique({
        where: { engagementId_name: { engagementId: eng.id, name: input.name } },
      });
      if (existing) return serializeTag(existing);
      const tag = await app.db.tag.create({
        data: {
          engagementId: eng.id,
          name: input.name,
          colorName: input.colorName,
          position: await nextTagPosition(app.db, eng.id),
        },
      });
      return serializeTag(tag);
    },
  );

  // List evidence (filter query + pagination), same shape as the web timeline.
  // Lets clients (desktop) pick an existing piece of evidence to link a capture to.
  app.get(
    '/engagements/:slug/evidence',
    { preHandler: requireEngagementRole('read') },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const query = (req.query as { q?: string }).q ?? '';
      return listEvidence(
        app,
        eng.id,
        slug,
        parseQuery(query),
        parsePagination(req.query as any),
        req.authedUser!.id,
      );
    },
  );

  app.post(
    '/engagements/:slug/evidence',
    { preHandler: requireEngagementRole('write') },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const { metadata, file } = await parseEvidenceRequest(req);
      const evidence = await createEvidence(app, {
        engagementId: eng.id,
        engagementSlug: slug,
        operatorId: req.authedUser!.id,
        metadata,
        file,
      });
      reply.status(201);
      return evidence;
    },
  );
}
