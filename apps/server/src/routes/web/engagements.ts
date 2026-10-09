import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  addEngagementMemberInput,
  createEngagementInput,
  updateEngagementInput,
} from '@reporter/shared';
import { HttpError, requireAuth, requireEngagementRole } from '../../auth/guards.js';
import { serializeEngagement, serializeUser } from '../../services/serializers.js';
import { computeEngagementProgress, computeOneEngagementProgress } from '../../services/goals.js';

export async function engagementRoutes(app: FastifyInstance): Promise<void> {
  // List the engagements the user is a member of — for everyone, site admins
  // included. The all-engagements view lives at GET /web/admin/engagements.
  app.get('/engagements', { preHandler: requireAuth }, async (req) => {
    const user = req.authedUser!;
    const engs = await app.db.engagement.findMany({
      where: { roles: { some: { userId: user.id } } },
      include: {
        _count: { select: { evidence: true, roles: true, findings: true } },
        roles: { where: { userId: user.id }, select: { role: true } },
        prefs: { where: { userId: user.id }, select: { isFavorite: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const progress = await computeEngagementProgress(
      app,
      engs.map((e) => e.id),
    );
    return engs.map((eng) =>
      serializeEngagement(eng, {
        role: eng.roles[0]?.role,
        favorite: eng.prefs[0]?.isFavorite ?? false,
        numUsers: eng._count.roles,
        numEvidence: eng._count.evidence,
        numFindings: eng._count.findings,
        progress: progress.get(eng.id),
      }),
    );
  });

  // Create an engagement; the creator becomes its admin and default tags are copied in.
  app.post('/engagements', { preHandler: requireAuth }, async (req) => {
    const input = createEngagementInput.parse(req.body);
    const user = req.authedUser!;

    const existing = await app.db.engagement.findUnique({ where: { slug: input.slug } });
    if (existing) throw new HttpError(409, 'An engagement with that slug already exists');

    const defaultTags = await app.db.defaultTag.findMany();

    const eng = await app.db.engagement.create({
      data: {
        slug: input.slug,
        name: input.name,
        // startedAt defaults to now(); a projected end is optional at creation.
        projectedEndAt: input.projectedEndAt ? new Date(input.projectedEndAt) : undefined,
        roles: { create: { userId: user.id, role: 'admin' } },
        // Explicit positions: the seed list's own order becomes the engagement's
        // initial curated tag order (Settings → Tags), instead of every tag sharing
        // position 0 and ordering by the `name` tiebreak alone.
        tags: {
          create: defaultTags.map((t, i) => ({
            name: t.name,
            colorName: t.colorName,
            position: i,
          })),
        },
      },
    });
    return serializeEngagement(eng, {
      role: 'admin',
      favorite: false,
      numUsers: 1,
      numEvidence: 0,
      numFindings: 0,
    });
  });

  app.get(
    '/engagements/:slug',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const eng = await app.db.engagement.findUniqueOrThrow({
        where: { slug },
        include: {
          _count: { select: { evidence: true, roles: true, findings: true } },
          roles: { where: { userId: req.authedUser!.id }, select: { role: true } },
          prefs: { where: { userId: req.authedUser!.id }, select: { isFavorite: true } },
        },
      });
      const progress = await computeOneEngagementProgress(app, eng.id);
      return serializeEngagement(eng, {
        role: req.authedUser!.admin ? 'admin' : eng.roles[0]?.role,
        favorite: eng.prefs[0]?.isFavorite ?? false,
        numUsers: eng._count.roles,
        numEvidence: eng._count.evidence,
        numFindings: eng._count.findings,
        progress,
        // The detail view (engagement settings) needs the full structured report content.
        includeContent: true,
      });
    },
  );

  app.put(
    '/engagements/:slug',
    { preHandler: [requireAuth, requireEngagementRole('admin')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const body = updateEngagementInput.parse(req.body);
      const current = await app.db.engagement.findUniqueOrThrow({ where: { slug } });

      const data: Prisma.EngagementUpdateInput = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.status !== undefined) data.status = body.status;
      if (body.startedAt !== undefined) data.startedAt = new Date(body.startedAt);
      if (body.projectedEndAt !== undefined)
        data.projectedEndAt = body.projectedEndAt === null ? null : new Date(body.projectedEndAt);
      // Report metadata: empty string clears to null so the report treats it as unset.
      const orNull = (v: string | null | undefined) => (v == null || v === '' ? null : v);
      if (body.clientName !== undefined) data.clientName = orNull(body.clientName);
      if (body.assessmentType !== undefined) data.assessmentType = orNull(body.assessmentType);
      if (body.testApproach !== undefined) data.testApproach = orNull(body.testApproach);
      if (body.location !== undefined) data.location = orNull(body.location);
      if (body.scope !== undefined) data.scope = orNull(body.scope);
      if (body.executiveSummary !== undefined)
        data.executiveSummary = orNull(body.executiveSummary);
      if (body.methodology !== undefined) data.methodology = orNull(body.methodology);
      if (body.objectivesNarrative !== undefined)
        data.objectivesNarrative = orNull(body.objectivesNarrative);
      // Report composition config: the whole object is replaced when present.
      if (body.reportConfig !== undefined) data.reportConfig = body.reportConfig;
      // Structured report content (JSON lists). Assign the validated array directly —
      // an empty array clears the list. The threat-model narrative clears to null.
      if (body.scopeTargets !== undefined) data.scopeTargets = body.scopeTargets;
      if (body.scopeExclusions !== undefined) data.scopeExclusions = body.scopeExclusions;
      if (body.strategicRecommendations !== undefined)
        data.strategicRecommendations = body.strategicRecommendations;
      if (body.threatModelNarrative !== undefined)
        data.threatModelNarrative = orNull(body.threatModelNarrative);
      if (body.threatModelDiagrams !== undefined)
        data.threatModelDiagrams = body.threatModelDiagrams;
      if (body.executionNarrative !== undefined) data.executionNarrative = body.executionNarrative;
      if (body.providerContacts !== undefined) data.providerContacts = body.providerContacts;
      if (body.clientContacts !== undefined) data.clientContacts = body.clientContacts;
      if (body.softwareTested !== undefined) data.softwareTested = body.softwareTested;
      if (body.thirdPartySoftware !== undefined) data.thirdPartySoftware = body.thirdPartySoftware;
      // Watermark. Text/color clear to null (renderer then uses its defaults);
      // enabled/opacity/layer are set directly.
      if (body.watermarkEnabled !== undefined) data.watermarkEnabled = body.watermarkEnabled;
      if (body.watermarkText !== undefined) data.watermarkText = orNull(body.watermarkText);
      if (body.watermarkColor !== undefined) data.watermarkColor = orNull(body.watermarkColor);
      if (body.watermarkOpacity !== undefined) data.watermarkOpacity = body.watermarkOpacity;
      if (body.watermarkLayer !== undefined) data.watermarkLayer = body.watermarkLayer;

      // A status change drives the actual-end date: entering complete/archived
      // stamps "now", returning to active clears it. This wins over any value in
      // the body. With no status change, an explicit actualEndAt is honored so
      // the date stays manually editable.
      const statusChanged = body.status !== undefined && body.status !== current.status;
      if (statusChanged) {
        data.actualEndAt = body.status === 'active' ? null : new Date();
      } else if (body.actualEndAt !== undefined) {
        data.actualEndAt = body.actualEndAt === null ? null : new Date(body.actualEndAt);
      }

      const eng = await app.db.engagement.update({ where: { slug }, data });
      const progress = await computeOneEngagementProgress(app, eng.id);
      // Return the full structured content (matching the GET detail route) so a
      // direct consumer of the PUT response sees the fields it just set.
      return serializeEngagement(eng, { includeContent: true, progress });
    },
  );

  // Delete an engagement and everything under it. Child rows (roles, prefs, tags,
  // evidence, findings, saved queries and their links) cascade at the DB level;
  // evidence blobs and stored report artifacts live outside the DB, so gather
  // their keys first and reclaim them from the blob store once the rows are gone.
  app.delete(
    '/engagements/:slug',
    { preHandler: [requireAuth, requireEngagementRole('admin')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });

      const evidence = await app.db.evidence.findMany({
        where: { engagementId: eng.id },
        select: { fullBlobKey: true, thumbBlobKey: true },
      });
      const reports = await app.db.generatedReport.findMany({
        where: { engagementId: eng.id },
        select: { blobKey: true },
      });

      await app.db.engagement.delete({ where: { id: eng.id } });

      for (const ev of evidence) {
        for (const key of [ev.fullBlobKey, ev.thumbBlobKey]) {
          if (key) await app.blobs.delete(key).catch(() => {});
        }
      }
      for (const r of reports) {
        if (r.blobKey) await app.blobs.delete(r.blobKey).catch(() => {});
      }
      return { ok: true };
    },
  );

  // Toggle favorite for the current user.
  app.post(
    '/engagements/:slug/favorite',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const { favorite } = z.object({ favorite: z.boolean() }).parse(req.body);
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      await app.db.userEngagementPref.upsert({
        where: { userId_engagementId: { userId: req.authedUser!.id, engagementId: eng.id } },
        create: { userId: req.authedUser!.id, engagementId: eng.id, isFavorite: favorite },
        update: { isFavorite: favorite },
      });
      return { favorite };
    },
  );

  // --- Engagement membership management (engagement admins) ---

  app.get(
    '/engagements/:slug/users',
    { preHandler: [requireAuth, requireEngagementRole('admin')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const roles = await app.db.userEngagementRole.findMany({
        // Deleting a user is a hard delete, which takes its roles with it; the
        // `deletedAt` filter only hides rows the old soft-delete left behind, which
        // deployed databases still carry.
        where: { engagementId: eng.id, user: { deletedAt: null } },
        include: { user: true },
      });
      return roles.map((r) => ({ user: serializeUser(r.user), role: r.role }));
    },
  );

  app.post(
    '/engagements/:slug/users',
    { preHandler: [requireAuth, requireEngagementRole('admin')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const body = addEngagementMemberInput.parse(req.body);
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      // Emails are unique but may be stored mixed-case; match case-insensitively.
      // A legacy soft-deleted account must not be re-addable as a member.
      const target = await app.db.user.findFirst({
        where: { email: { equals: body.email, mode: 'insensitive' }, deletedAt: null },
      });
      if (!target) throw new HttpError(404, `No user found with the email “${body.email}”`);
      await app.db.userEngagementRole.upsert({
        where: { userId_engagementId: { userId: target.id, engagementId: eng.id } },
        create: { userId: target.id, engagementId: eng.id, role: body.role },
        update: { role: body.role },
      });
      return { user: serializeUser(target), role: body.role };
    },
  );

  app.delete(
    '/engagements/:slug/users/:userSlug',
    { preHandler: [requireAuth, requireEngagementRole('admin')] },
    async (req) => {
      const { slug, userSlug } = req.params as { slug: string; userSlug: string };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const target = await app.db.user.findUnique({ where: { slug: userSlug } });
      if (!target) throw new HttpError(404, 'User not found');
      await app.db.userEngagementRole
        .delete({ where: { userId_engagementId: { userId: target.id, engagementId: eng.id } } })
        .catch(() => {});
      return { ok: true };
    },
  );
}
