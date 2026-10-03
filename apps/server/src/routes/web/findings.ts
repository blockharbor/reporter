import type { FastifyInstance } from 'fastify';
import {
  attachEvidenceInput,
  createFindingInput,
  reorderInput,
  scoreVector,
  updateFindingEvidenceInput,
  updateFindingInput,
} from '@reporter/shared';
import { HttpError, requireAuth, requireEngagementRole } from '../../auth/guards.js';
import { REPORT_VISIBLE_EVIDENCE } from '../../helpers/report-visibility.js';
import {
  evidenceInclude,
  serializeFinding,
  serializeFindingEvidence,
} from '../../services/serializers.js';

// Every finding read (list + detail) carries its link counts: attached evidence and
// linked goals. The Findings page filters/sorts on both, client-side.
//
// `numEvidenceInReport` needs a *report-filtered* count of that same evidence
// relation, and Prisma's `_count` has no aliasing — `evidence` may appear in it
// once, filtered or not — so the two counts can't be siblings there. Same answer as
// `findings-report.ts`'s gather: keep the unfiltered `_count` for the true total and
// pair it with a filtered relation include whose length is the report-visible count.
// Only the link's id is selected, so this costs one narrow join and nothing is
// loaded that isn't counted. These rows never reach the wire: no route serializes
// them, and the detail route below replaces the `evidence` key of its response.
const findingInclude = {
  category: true,
  evidence: { where: { evidence: REPORT_VISIBLE_EVIDENCE }, select: { evidenceId: true } },
  _count: { select: { evidence: true, goals: true } },
} as const;

async function categoryIdFor(
  app: FastifyInstance,
  engagementId: number,
  name: string | null,
): Promise<number | null> {
  if (!name) return null;
  const cat = await app.db.findingCategory.upsert({
    where: { engagementId_category: { engagementId, category: name } },
    create: { engagementId, category: name },
    update: { deletedAt: null },
  });
  return cat.id;
}

export async function findingRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/engagements/:slug/findings',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const findings = await app.db.finding.findMany({
        where: { engagementId: eng.id },
        include: findingInclude,
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      });
      return findings.map((f) => serializeFinding(f, slug));
    },
  );

  app.post(
    '/engagements/:slug/findings',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const input = createFindingInput.parse(req.body);
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      // New findings append to the end of the manual order. This read-then-write
      // isn't atomic: two simultaneous creates in one engagement can land on the
      // same position. The impact is only a cosmetic tie (list order falls back to
      // createdAt) and a reorder rewrites positions cleanly, so we don't lock here.
      const max = await app.db.finding.aggregate({
        where: { engagementId: eng.id },
        _max: { position: true },
      });
      const finding = await app.db.finding.create({
        data: {
          engagementId: eng.id,
          title: input.title,
          description: input.description,
          kind: input.kind,
          affectedTarget: input.affectedTarget,
          impact: input.impact,
          // A strength carries no remediation effort.
          fixEffort: input.kind === 'strength' ? 'none' : input.fixEffort,
          iso21434Refs: input.iso21434Refs,
          unr155Refs: input.unr155Refs,
          categoryId: await categoryIdFor(app, eng.id, input.category),
          position: (max._max.position ?? -1) + 1,
        },
        include: findingInclude,
      });
      reply.status(201);
      return serializeFinding(finding, slug);
    },
  );

  app.get(
    '/engagements/:slug/findings/:uuid',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const finding = await app.db.finding.findFirst({
        where: { uuid, engagementId: eng.id },
        include: findingInclude,
      });
      if (!finding) throw new HttpError(404, 'Finding not found');
      // Attack Path first (inPath=true), then Attached Evidence, each ordered by
      // its own position. The client splits the flat list back into the two
      // buckets by `inPath`.
      const links = await app.db.evidenceFinding.findMany({
        where: { findingId: finding.id },
        include: { evidence: { include: evidenceInclude(req.authedUser!.id) } },
        orderBy: [{ inPath: 'desc' }, { position: 'asc' }, { evidenceId: 'asc' }],
      });
      return {
        ...serializeFinding(finding, slug),
        evidence: links.map((l) => serializeFindingEvidence(l, slug)),
      };
    },
  );

  app.put(
    '/engagements/:slug/findings/:uuid',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const body = updateFindingInput.parse(req.body);
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const finding = await app.db.finding.findFirst({ where: { uuid, engagementId: eng.id } });
      if (!finding) throw new HttpError(404, 'Finding not found');

      const data: {
        title?: string;
        description?: string;
        kind?: 'weakness' | 'strength';
        affectedTarget?: string;
        impact?: string;
        fixEffort?: 'none' | 'low' | 'medium' | 'high';
        iso21434Refs?: string[];
        unr155Refs?: string[];
        remediation?: string;
        readyToReport?: boolean;
        categoryId?: number | null;
        severity?: 'none' | 'low' | 'medium' | 'high' | 'critical' | null;
        cvssVector?: string | null;
        cvssScore?: number | null;
      } = {
        title: body.title ?? undefined,
        description: body.description ?? undefined,
        kind: body.kind ?? undefined,
        affectedTarget: body.affectedTarget ?? undefined,
        impact: body.impact ?? undefined,
        fixEffort: body.fixEffort ?? undefined,
        iso21434Refs: body.iso21434Refs ?? undefined,
        unr155Refs: body.unr155Refs ?? undefined,
        remediation: body.remediation ?? undefined,
        readyToReport: body.readyToReport ?? undefined,
        categoryId:
          body.category === undefined ? undefined : await categoryIdFor(app, eng.id, body.category),
      };

      // Severity / CVSS resolution:
      //  • A CVSS vector wins — the server derives score + severity from it so the
      //    number and label can never drift from the stored vector.
      //  • Clearing the vector (null) drops the score; a manual severity may
      //    accompany it. Otherwise a bare `severity` is a simple (manual) rating.
      if (typeof body.cvssVector === 'string') {
        const scored = scoreVector(body.cvssVector);
        if (!scored) throw new HttpError(400, 'Invalid CVSS vector');
        data.cvssVector = scored.vector;
        data.cvssScore = scored.score;
        data.severity = scored.severity;
      } else if (body.cvssVector === null) {
        data.cvssVector = null;
        data.cvssScore = null;
        if (body.severity !== undefined) data.severity = body.severity;
      } else if (body.severity !== undefined) {
        // A manual severity supersedes any stored vector — clear it so the label
        // can never drift from a stale score/vector.
        data.severity = body.severity;
        data.cvssVector = null;
        data.cvssScore = null;
      }

      // A strength carries no risk rating or remediation — defensively clear the
      // weakness-only fields so none of them leak into the weaknesses dashboard,
      // tables, or export, even on a weakness→strength switch. (The editor also
      // hides these for strengths, but any API/import caller is covered here too.)
      const resultingKind = body.kind ?? finding.kind;
      if (resultingKind === 'strength') {
        data.severity = null;
        data.cvssVector = null;
        data.cvssScore = null;
        data.fixEffort = 'none';
        data.impact = '';
        data.remediation = '';
      }

      const updated = await app.db.finding.update({
        where: { id: finding.id },
        data,
        include: findingInclude,
      });
      return serializeFinding(updated, slug);
    },
  );

  app.delete(
    '/engagements/:slug/findings/:uuid',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const finding = await app.db.finding.findFirst({ where: { uuid, engagementId: eng.id } });
      if (!finding) throw new HttpError(404, 'Finding not found');
      await app.db.finding.delete({ where: { id: finding.id } });
      return { ok: true };
    },
  );

  // Attach evidence to a finding, into the Attack Path or Attached Evidence bucket.
  app.post(
    '/engagements/:slug/findings/:uuid/evidence',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const { evidenceUuids, inPath } = attachEvidenceInput.parse(req.body);
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const finding = await app.db.finding.findFirst({ where: { uuid, engagementId: eng.id } });
      if (!finding) throw new HttpError(404, 'Finding not found');
      const evidence = await app.db.evidence.findMany({
        where: { uuid: { in: evidenceUuids }, engagementId: eng.id },
        select: { id: true, uuid: true },
      });
      // Idempotent: skip evidence already linked (in either bucket). New links
      // append to the end of the *target* bucket, so position is scoped per bucket.
      const existing = await app.db.evidenceFinding.findMany({
        where: { findingId: finding.id },
        select: { evidenceId: true, position: true, inPath: true },
      });
      const attachedIds = new Set(existing.map((e) => e.evidenceId));
      let nextPos =
        existing.filter((e) => e.inPath === inPath).reduce((m, e) => Math.max(m, e.position), -1) +
        1;
      // Assign positions in the caller's requested order (a `WHERE uuid IN (…)`
      // query has no inherent order), so the bucket lands in the order the user
      // listed the evidence.
      const idByUuid = new Map(evidence.map((e) => [e.uuid, e.id]));
      const toAttach = evidenceUuids
        .map((u) => idByUuid.get(u))
        .filter((id): id is number => id !== undefined && !attachedIds.has(id));
      await app.db.evidenceFinding.createMany({
        data: toAttach.map((id) => ({
          evidenceId: id,
          findingId: finding.id,
          position: nextPos++,
          inPath,
        })),
        skipDuplicates: true,
      });
      return { ok: true, attached: toAttach.length };
    },
  );

  // Update a single evidence↔finding link: set its Attack Path caption and/or
  // move it between the Attack Path and Attached Evidence buckets.
  app.patch(
    '/engagements/:slug/findings/:uuid/evidence/:evidenceUuid',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, uuid, evidenceUuid } = req.params as {
        slug: string;
        uuid: string;
        evidenceUuid: string;
      };
      const body = updateFindingEvidenceInput.parse(req.body);
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const finding = await app.db.finding.findFirst({ where: { uuid, engagementId: eng.id } });
      const evidence = await app.db.evidence.findFirst({
        where: { uuid: evidenceUuid, engagementId: eng.id },
        select: { id: true },
      });
      if (!finding || !evidence) throw new HttpError(404, 'Not found');
      const link = await app.db.evidenceFinding.findUnique({
        where: { evidenceId_findingId: { evidenceId: evidence.id, findingId: finding.id } },
      });
      if (!link) throw new HttpError(404, 'Evidence is not attached to this finding');

      const data: { caption?: string; inPath?: boolean; position?: number } = {};
      if (body.caption !== undefined) data.caption = body.caption;
      // Moving buckets: append to the end of the target bucket so positions stay
      // dense per bucket. A no-op move (same bucket) leaves position untouched.
      if (body.inPath !== undefined && body.inPath !== link.inPath) {
        const count = await app.db.evidenceFinding.count({
          where: { findingId: finding.id, inPath: body.inPath },
        });
        data.inPath = body.inPath;
        data.position = count;
      }

      const updated = await app.db.evidenceFinding.update({
        where: { evidenceId_findingId: { evidenceId: evidence.id, findingId: finding.id } },
        data,
        include: { evidence: { include: evidenceInclude(req.authedUser!.id) } },
      });
      return serializeFindingEvidence(updated, slug);
    },
  );

  // Reorder the findings within an engagement (drag-and-drop order).
  app.patch(
    '/engagements/:slug/findings/reorder',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const { orderedUuids } = reorderInput.parse(req.body);
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      // Load the full set: the order must list every finding exactly once, so
      // reassigning positions 0..n-1 can never collide with an omitted finding.
      const findings = await app.db.finding.findMany({
        where: { engagementId: eng.id },
        select: { id: true, uuid: true },
      });
      const idByUuid = new Map(findings.map((f) => [f.uuid, f.id]));
      if (idByUuid.size !== orderedUuids.length || orderedUuids.some((u) => !idByUuid.has(u))) {
        throw new HttpError(400, 'Order must list exactly the findings in this engagement');
      }
      await app.db.$transaction(
        orderedUuids.map((u, i) =>
          app.db.finding.update({ where: { id: idByUuid.get(u)! }, data: { position: i } }),
        ),
      );
      return { ok: true };
    },
  );

  // Reorder one bucket of a finding's evidence. The body lists just that bucket's
  // links in their new order (Attack Path or Attached Evidence) — not every link
  // on the finding — so positions are reassigned by array index within the bucket.
  app.patch(
    '/engagements/:slug/findings/:uuid/evidence/reorder',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const { orderedUuids } = reorderInput.parse(req.body);
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const finding = await app.db.finding.findFirst({ where: { uuid, engagementId: eng.id } });
      if (!finding) throw new HttpError(404, 'Finding not found');
      const links = await app.db.evidenceFinding.findMany({
        where: { findingId: finding.id },
        include: { evidence: { select: { uuid: true } } },
      });
      const idByUuid = new Map(links.map((l) => [l.evidence.uuid, l.evidenceId]));
      // Every submitted uuid must be linked to this finding, but the submitted set
      // need not be every link — it's a single bucket's ordering.
      if (orderedUuids.some((u) => !idByUuid.has(u))) {
        throw new HttpError(400, 'Order references evidence not attached to this finding');
      }
      await app.db.$transaction(
        orderedUuids.map((u, i) =>
          app.db.evidenceFinding.update({
            where: {
              evidenceId_findingId: { evidenceId: idByUuid.get(u)!, findingId: finding.id },
            },
            data: { position: i },
          }),
        ),
      );
      return { ok: true };
    },
  );

  app.delete(
    '/engagements/:slug/findings/:uuid/evidence/:evidenceUuid',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, uuid, evidenceUuid } = req.params as {
        slug: string;
        uuid: string;
        evidenceUuid: string;
      };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const finding = await app.db.finding.findFirst({ where: { uuid, engagementId: eng.id } });
      const evidence = await app.db.evidence.findFirst({
        where: { uuid: evidenceUuid, engagementId: eng.id },
      });
      if (!finding || !evidence) throw new HttpError(404, 'Not found');
      await app.db.evidenceFinding
        .delete({
          where: { evidenceId_findingId: { evidenceId: evidence.id, findingId: finding.id } },
        })
        .catch(() => {});
      return { ok: true };
    },
  );
}
