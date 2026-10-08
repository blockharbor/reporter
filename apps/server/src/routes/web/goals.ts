/**
 * Engagement goals (Target → Activity → Goal): CRUD, ordering, evidence/finding
 * links (which auto-advance a goal to "in progress"), linked-goal lookups for the
 * evidence/finding detail views, and the proposal-JSON importer.
 */
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  createActivityInput,
  createGoalInput,
  createTargetInput,
  importRequestSchema,
  linkGoalEvidenceInput,
  linkGoalFindingInput,
  reorderIdsInput,
  updateActivityInput,
  updateGoalInput,
  updateTargetInput,
  type ImportResult,
  type LinkedGoal,
} from '@reporter/shared';
import { HttpError, requireAuth, requireEngagementRole } from '../../auth/guards.js';
import { ensureActivityTag, fetchGoalsTree, progressFromTree } from '../../services/goals.js';

/** Parse a positive-integer route param or 400. */
function intParam(v: string, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${what} id`);
  return n;
}

export async function goalRoutes(app: FastifyInstance): Promise<void> {
  const engBySlug = (slug: string) => app.db.engagement.findUniqueOrThrow({ where: { slug } });

  /** Load a target scoped to the engagement (404 if it belongs elsewhere). */
  async function getTarget(engagementId: number, id: number) {
    const t = await app.db.engagementTarget.findFirst({ where: { id, engagementId } });
    if (!t) throw new HttpError(404, 'Target not found');
    return t;
  }
  async function getActivity(engagementId: number, id: number) {
    const a = await app.db.targetActivity.findFirst({
      where: { id, target: { engagementId } },
    });
    if (!a) throw new HttpError(404, 'Activity not found');
    return a;
  }
  async function getGoal(engagementId: number, id: number) {
    const g = await app.db.activityGoal.findFirst({
      where: { id, activity: { target: { engagementId } } },
    });
    if (!g) throw new HttpError(404, 'Goal not found');
    return g;
  }

  // --- Goals tree -----------------------------------------------------------
  app.get(
    '/engagements/:slug/goals',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const eng = await engBySlug(slug);
      const targets = await fetchGoalsTree(app, eng.id);
      return { targets, progress: progressFromTree(targets) };
    },
  );

  // --- Targets --------------------------------------------------------------
  app.post(
    '/engagements/:slug/targets',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const input = createTargetInput.parse(req.body);
      const eng = await engBySlug(slug);
      const position = await app.db.engagementTarget.count({ where: { engagementId: eng.id } });
      const t = await app.db.engagementTarget.create({
        data: { engagementId: eng.id, name: input.name, description: input.description, position },
      });
      return { id: t.id, name: t.name, description: t.description, position: t.position, activities: [] };
    },
  );

  app.put(
    '/engagements/:slug/targets/:id',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const input = updateTargetInput.parse(req.body);
      const eng = await engBySlug(slug);
      await getTarget(eng.id, intParam(id, 'target'));
      const t = await app.db.engagementTarget.update({
        where: { id: Number(id) },
        data: { name: input.name, description: input.description },
      });
      return { id: t.id, name: t.name, description: t.description, position: t.position };
    },
  );

  app.delete(
    '/engagements/:slug/targets/:id',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const eng = await engBySlug(slug);
      await getTarget(eng.id, intParam(id, 'target'));
      await app.db.engagementTarget.delete({ where: { id: Number(id) } });
      return { ok: true };
    },
  );

  app.patch(
    '/engagements/:slug/targets/reorder',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const { orderedIds } = reorderIdsInput.parse(req.body);
      const eng = await engBySlug(slug);
      const valid = await app.db.engagementTarget.findMany({
        where: { engagementId: eng.id, id: { in: orderedIds } },
        select: { id: true },
      });
      const validSet = new Set(valid.map((v) => v.id));
      await app.db.$transaction(
        orderedIds
          .filter((tid) => validSet.has(tid))
          .map((tid, i) =>
            app.db.engagementTarget.update({ where: { id: tid }, data: { position: i } }),
          ),
      );
      return { ok: true };
    },
  );

  // --- Activities -----------------------------------------------------------
  app.post(
    '/engagements/:slug/targets/:id/activities',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const input = createActivityInput.parse(req.body);
      const eng = await engBySlug(slug);
      const target = await getTarget(eng.id, intParam(id, 'target'));
      const position = await app.db.targetActivity.count({ where: { targetId: target.id } });
      const tagId = await ensureActivityTag(app.db, eng.id, input.name);
      const a = await app.db.targetActivity.create({
        data: { targetId: target.id, name: input.name, category: input.category, tagId, position },
      });
      return {
        id: a.id,
        name: a.name,
        category: a.category,
        tagId: a.tagId,
        position: a.position,
        goals: [],
      };
    },
  );

  app.put(
    '/engagements/:slug/activities/:id',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const input = updateActivityInput.parse(req.body);
      const eng = await engBySlug(slug);
      const activity = await getActivity(eng.id, intParam(id, 'activity'));
      // Renaming an activity re-points it at a tag matching the new name (created
      // if needed); the old tag is left in place (it may be in use on evidence).
      const tagId =
        input.name !== undefined && input.name !== activity.name
          ? await ensureActivityTag(app.db, eng.id, input.name)
          : undefined;
      const a = await app.db.targetActivity.update({
        where: { id: activity.id },
        data: { name: input.name, category: input.category, ...(tagId != null ? { tagId } : {}) },
      });
      return { id: a.id, name: a.name, category: a.category, tagId: a.tagId, position: a.position };
    },
  );

  app.delete(
    '/engagements/:slug/activities/:id',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const eng = await engBySlug(slug);
      const activity = await getActivity(eng.id, intParam(id, 'activity'));
      await app.db.targetActivity.delete({ where: { id: activity.id } });
      return { ok: true };
    },
  );

  app.patch(
    '/engagements/:slug/targets/:id/activities/reorder',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const { orderedIds } = reorderIdsInput.parse(req.body);
      const eng = await engBySlug(slug);
      const target = await getTarget(eng.id, intParam(id, 'target'));
      const valid = await app.db.targetActivity.findMany({
        where: { targetId: target.id, id: { in: orderedIds } },
        select: { id: true },
      });
      const validSet = new Set(valid.map((v) => v.id));
      await app.db.$transaction(
        orderedIds
          .filter((aid) => validSet.has(aid))
          .map((aid, i) =>
            app.db.targetActivity.update({ where: { id: aid }, data: { position: i } }),
          ),
      );
      return { ok: true };
    },
  );

  // --- Goals ----------------------------------------------------------------
  app.post(
    '/engagements/:slug/activities/:id/goals',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const input = createGoalInput.parse(req.body);
      const eng = await engBySlug(slug);
      const activity = await getActivity(eng.id, intParam(id, 'activity'));
      const position = await app.db.activityGoal.count({ where: { activityId: activity.id } });
      const g = await app.db.activityGoal.create({
        data: {
          activityId: activity.id,
          title: input.title,
          isRetest: input.isRetest,
          notes: input.notes,
          position,
        },
      });
      return {
        id: g.id,
        title: g.title,
        status: g.status,
        isRetest: g.isRetest,
        notes: g.notes,
        position: g.position,
        numEvidence: 0,
        numFindings: 0,
      };
    },
  );

  app.put(
    '/engagements/:slug/goals/:id',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const input = updateGoalInput.parse(req.body);
      const eng = await engBySlug(slug);
      const goal = await getGoal(eng.id, intParam(id, 'goal'));
      const g = await app.db.activityGoal.update({
        where: { id: goal.id },
        data: {
          title: input.title,
          status: input.status,
          isRetest: input.isRetest,
          notes: input.notes,
        },
        include: { _count: { select: { evidence: true, findings: true } } },
      });
      return {
        id: g.id,
        title: g.title,
        status: g.status,
        isRetest: g.isRetest,
        notes: g.notes,
        position: g.position,
        numEvidence: g._count.evidence,
        numFindings: g._count.findings,
      };
    },
  );

  app.delete(
    '/engagements/:slug/goals/:id',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const eng = await engBySlug(slug);
      const goal = await getGoal(eng.id, intParam(id, 'goal'));
      await app.db.activityGoal.delete({ where: { id: goal.id } });
      return { ok: true };
    },
  );

  app.patch(
    '/engagements/:slug/activities/:id/goals/reorder',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const { orderedIds } = reorderIdsInput.parse(req.body);
      const eng = await engBySlug(slug);
      const activity = await getActivity(eng.id, intParam(id, 'activity'));
      const valid = await app.db.activityGoal.findMany({
        where: { activityId: activity.id, id: { in: orderedIds } },
        select: { id: true },
      });
      const validSet = new Set(valid.map((v) => v.id));
      await app.db.$transaction(
        orderedIds
          .filter((gid) => validSet.has(gid))
          .map((gid, i) => app.db.activityGoal.update({ where: { id: gid }, data: { position: i } })),
      );
      return { ok: true };
    },
  );

  // --- Goal ↔ evidence / finding links --------------------------------------

  /** Bump a not-started goal to in-progress once it gains its first artifact. */
  async function autoAdvance(goalId: number): Promise<void> {
    await app.db.activityGoal.updateMany({
      where: { id: goalId, status: 'not_started' },
      data: { status: 'in_progress' },
    });
  }

  app.post(
    '/engagements/:slug/goals/:id/evidence',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const { evidenceUuids } = linkGoalEvidenceInput.parse(req.body);
      const eng = await engBySlug(slug);
      const goal = await getGoal(eng.id, intParam(id, 'goal'));
      const evidence = await app.db.evidence.findMany({
        where: { engagementId: eng.id, uuid: { in: evidenceUuids } },
        select: { id: true },
      });
      if (evidence.length) {
        await app.db.goalEvidence.createMany({
          data: evidence.map((e) => ({ goalId: goal.id, evidenceId: e.id })),
          skipDuplicates: true,
        });
        await autoAdvance(goal.id);
      }
      return { linked: evidence.length };
    },
  );

  app.delete(
    '/engagements/:slug/goals/:id/evidence/:evidenceUuid',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id, evidenceUuid } = req.params as {
        slug: string;
        id: string;
        evidenceUuid: string;
      };
      const eng = await engBySlug(slug);
      const goal = await getGoal(eng.id, intParam(id, 'goal'));
      const ev = await app.db.evidence.findFirst({
        where: { uuid: evidenceUuid, engagementId: eng.id },
        select: { id: true },
      });
      if (ev) {
        await app.db.goalEvidence
          .delete({ where: { goalId_evidenceId: { goalId: goal.id, evidenceId: ev.id } } })
          .catch(() => {});
      }
      return { ok: true };
    },
  );

  app.post(
    '/engagements/:slug/goals/:id/findings',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const { findingUuids } = linkGoalFindingInput.parse(req.body);
      const eng = await engBySlug(slug);
      const goal = await getGoal(eng.id, intParam(id, 'goal'));
      const findings = await app.db.finding.findMany({
        where: { engagementId: eng.id, uuid: { in: findingUuids } },
        select: { id: true },
      });
      if (findings.length) {
        await app.db.goalFinding.createMany({
          data: findings.map((f) => ({ goalId: goal.id, findingId: f.id })),
          skipDuplicates: true,
        });
        await autoAdvance(goal.id);
      }
      return { linked: findings.length };
    },
  );

  app.delete(
    '/engagements/:slug/goals/:id/findings/:findingUuid',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id, findingUuid } = req.params as {
        slug: string;
        id: string;
        findingUuid: string;
      };
      const eng = await engBySlug(slug);
      const goal = await getGoal(eng.id, intParam(id, 'goal'));
      const f = await app.db.finding.findFirst({
        where: { uuid: findingUuid, engagementId: eng.id },
        select: { id: true },
      });
      if (f) {
        await app.db.goalFinding
          .delete({ where: { goalId_findingId: { goalId: goal.id, findingId: f.id } } })
          .catch(() => {});
      }
      return { ok: true };
    },
  );

  // --- Linked-goal lookups (evidence/finding detail views) ------------------
  const linkedGoalSelect = {
    goal: { include: { activity: { include: { target: true } } } },
  } as const;
  /**
   * Target → Activity → Goal position, ids breaking position ties: the same key
   * order `fetchGoalsTree` walks the tree in, so one artifact's linked goals read
   * in the same sequence here, in the goals tree, and in the report. Without it
   * these lists come back in whatever order the join happens to produce.
   */
  const linkedGoalOrder: (Prisma.GoalEvidenceOrderByWithRelationInput &
    Prisma.GoalFindingOrderByWithRelationInput)[] = [
    { goal: { activity: { target: { position: 'asc' } } } },
    { goal: { activity: { target: { id: 'asc' } } } },
    { goal: { activity: { position: 'asc' } } },
    { goal: { activity: { id: 'asc' } } },
    { goal: { position: 'asc' } },
    { goalId: 'asc' },
  ];
  const toLinkedGoal = (g: {
    id: number;
    title: string;
    status: LinkedGoal['status'];
    activity: { name: string; target: { name: string } };
  }): LinkedGoal => ({
    id: g.id,
    title: g.title,
    status: g.status,
    targetName: g.activity.target.name,
    activityName: g.activity.name,
  });

  app.get(
    '/engagements/:slug/goals/for-evidence/:evidenceUuid',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug, evidenceUuid } = req.params as { slug: string; evidenceUuid: string };
      const eng = await engBySlug(slug);
      const links = await app.db.goalEvidence.findMany({
        where: {
          evidence: { uuid: evidenceUuid, engagementId: eng.id },
          goal: { activity: { target: { engagementId: eng.id } } },
        },
        include: linkedGoalSelect,
        orderBy: linkedGoalOrder,
      });
      return links.map((l) => toLinkedGoal(l.goal));
    },
  );

  app.get(
    '/engagements/:slug/goals/for-finding/:findingUuid',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug, findingUuid } = req.params as { slug: string; findingUuid: string };
      const eng = await engBySlug(slug);
      const links = await app.db.goalFinding.findMany({
        where: {
          finding: { uuid: findingUuid, engagementId: eng.id },
          goal: { activity: { target: { engagementId: eng.id } } },
        },
        include: linkedGoalSelect,
        orderBy: linkedGoalOrder,
      });
      return links.map((l) => toLinkedGoal(l.goal));
    },
  );

  // --- Proposal import ------------------------------------------------------
  app.post(
    '/engagements/:slug/proposal/import',
    {
      preHandler: [requireAuth, requireEngagementRole('write')],
      bodyLimit: app.config.MAX_UPLOAD_BYTES,
    },
    async (req): Promise<ImportResult> => {
      const { slug } = req.params as { slug: string };
      const { draft, mode, applyMetadata, rawProposal } = importRequestSchema.parse(req.body);
      const eng = await engBySlug(slug);

      // The raw proposal JSON is stored verbatim (provenance). null/undefined is
      // treated as "not provided" — Prisma's JSON column keeps its current value.
      const rawJson =
        rawProposal == null ? undefined : (rawProposal as Prisma.InputJsonValue);

      // The whole import is one transaction: a `replace` must never delete the
      // existing tree and then only partially rebuild it if a later create fails.
      return app.db.$transaction(async (tx): Promise<ImportResult> => {
        if (mode === 'replace') {
          await tx.engagementTarget.deleteMany({ where: { engagementId: eng.id } });
        }

        let metadataApplied = false;
        if (applyMetadata) {
          const m = draft.metadata;
          const data: Prisma.EngagementUpdateInput = {};
          if (m.clientName) data.clientName = m.clientName;
          if (m.assessmentType) data.assessmentType = m.assessmentType;
          if (m.testApproach) data.testApproach = m.testApproach;
          if (m.objectivesNarrative) data.objectivesNarrative = m.objectivesNarrative;
          if (m.scope) data.scope = m.scope;
          if (m.location) data.location = m.location;
          if (m.startedAt) data.startedAt = new Date(m.startedAt);
          if (m.scopeExclusions?.length) data.scopeExclusions = m.scopeExclusions;
          if (m.providerContacts?.length) data.providerContacts = m.providerContacts;
          if (m.clientContacts?.length) data.clientContacts = m.clientContacts;
          if (rawJson !== undefined) data.proposalImport = rawJson;

          // Populate the structured Service-scope section from the same devices
          // that build the goals tree: each target's name, with its interface
          // (activity) names as the in-scope subsystems. `replace` overwrites the
          // scope list; `merge` appends to whatever is already there (mirroring
          // how the goals tree itself merges). Capped to the engagement schema's
          // 100-target / 200-subsystem limits.
          const derivedScope = draft.targets.map((t) => ({
            name: t.name,
            subsystems: t.activities
              .map((a) => a.name)
              .filter((s) => s.trim().length > 0)
              .slice(0, 200),
          }));
          if (derivedScope.length) {
            const existing =
              mode === 'replace'
                ? []
                : ((eng.scopeTargets as unknown as { name: string; subsystems: string[] }[]) ?? []);
            data.scopeTargets = [...existing, ...derivedScope].slice(0, 100);
          }

          if (Object.keys(data).length) {
            await tx.engagement.update({ where: { id: eng.id }, data });
            metadataApplied = true;
          }
        } else if (rawJson !== undefined) {
          await tx.engagement.update({
            where: { id: eng.id },
            data: { proposalImport: rawJson },
          });
        }

        // Create the tree. Positions continue after any existing targets (merge).
        let targetPos = await tx.engagementTarget.count({ where: { engagementId: eng.id } });
        let targetsCreated = 0;
        let activitiesCreated = 0;
        let goalsCreated = 0;

        for (const t of draft.targets) {
          const target = await tx.engagementTarget.create({
            data: {
              engagementId: eng.id,
              name: t.name,
              description: t.description,
              position: targetPos++,
            },
          });
          targetsCreated++;
          let activityPos = 0;
          for (const a of t.activities) {
            const tagId = await ensureActivityTag(tx, eng.id, a.name);
            const activity = await tx.targetActivity.create({
              data: {
                targetId: target.id,
                name: a.name,
                category: a.category,
                tagId,
                position: activityPos++,
              },
            });
            activitiesCreated++;
            if (a.goals.length) {
              await tx.activityGoal.createMany({
                data: a.goals.map((g, i) => ({
                  activityId: activity.id,
                  title: g.title,
                  isRetest: g.isRetest,
                  position: i,
                })),
              });
              goalsCreated += a.goals.length;
            }
          }
        }

        // Seed the engagement's finding-category list from the proposal's own
        // weakness taxonomy so classifying a finding is "pick from the plan", not
        // free-typing: the intended weakness classes (non-retest goal titles) plus
        // the activity categories. Deduped, length-bounded, and revived if a
        // matching category was previously soft-deleted.
        if (applyMetadata) {
          const categoryNames = new Set<string>();
          for (const t of draft.targets) {
            for (const a of t.activities) {
              const cat = a.category.trim();
              if (cat) categoryNames.add(cat);
              for (const g of a.goals) {
                const title = g.title.trim();
                // Retests are prior-report carryovers (e.g. "W1-…"), not classes.
                if (!g.isRetest && title && title.length <= 120) categoryNames.add(title);
              }
            }
          }
          for (const category of categoryNames) {
            await tx.findingCategory.upsert({
              where: { engagementId_category: { engagementId: eng.id, category } },
              create: { engagementId: eng.id, category },
              update: { deletedAt: null },
            });
          }
        }

        return { targetsCreated, activitiesCreated, goalsCreated, metadataApplied };
      });
    },
  );
}
