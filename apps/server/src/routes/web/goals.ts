/**
 * Engagement goals (Target → Activity → Goal): CRUD, ordering, evidence/finding
 * links (which auto-advance a goal to "in progress"), linked-goal lookups for the
 * evidence/finding detail views, and the proposal-JSON importer.
 *
 * AUDIT. Create, update and delete of a target, activity or goal are left to the
 * backstop: each is one plain write whose row-level truth ("Created goal
 * “Enumerate ECUs”", "Edited goal “…”: Status") is already the right sentence,
 * and the tag an activity mints through `ensureActivityTag` is a real tag the
 * backstop should see minted. The handlers that write their own entries are the
 * ones whose truth the backstop cannot tell: the three reorders (a transaction
 * of N position updates is ONE reorder), the four link/unlink handlers (a
 * `createMany`/`delete` on a join row, named by the goal and the thing linked),
 * and the proposal import (one event, not one per row). The goal auto-advance
 * the link handlers trigger is deliberately NOT claimed by their scopes —
 * `activityGoal` is absent from the `withIntent` lists — so the backstop still
 * records the status change as its own entry on the goal, and the link entry is
 * written first so the two read in the order they happened.
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
  type AuditChange,
  type AuditEntityType,
  type ImportResult,
  type LinkedGoal,
} from '@reporter/shared';
import { withImporter, type AuditModel } from '../../audit/context.js';
import { ALL_AUDITED_MODELS } from '../../audit/models.js';
import { HttpError, requireAuth, requireEngagementRole } from '../../auth/guards.js';
import { ensureActivityTag, fetchGoalsTree, progressFromTree } from '../../services/goals.js';
import {
  auditCtx,
  evidenceLabel,
  inTx,
  n,
  orderLabel,
  q,
  recordAudit,
  sameOrder,
  withIntent,
  type AuditCtx,
} from '../../services/audit.js';

/** Parse a positive-integer route param or 400. */
function intParam(v: string, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${what} id`);
  return n;
}

/** What one of the three tree reorders needs to write its rows and its entry. */
interface ReorderSpec<T extends { id: number }> {
  /** Every row the parent holds, in its CURRENT order — the `from` side. */
  current: readonly T[];
  /** The submitted order; ids the parent does not hold are dropped, a repeat kept once. */
  orderedIds: readonly number[];
  label: (row: T) => string;
  /** The one model the transaction writes, for the `withIntent` claim. */
  model: AuditModel;
  update: (tx: Prisma.TransactionClient, id: number, position: number) => Promise<unknown>;
  entry: {
    entityType: AuditEntityType;
    entity: { id: string; label: string };
    /** The `order` change's field, which the UI labels ("targets" → "Targets"). */
    field: string;
    summary: (count: number) => string;
  };
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

  /**
   * The three tree reorders share one shape: the submitted ids are filtered to
   * the parent's own (the pre-existing contract — a foreign id is dropped, not
   * rejected), the same order again is no write and no entry, and otherwise the
   * position updates and ONE `reorder` entry — the labels before and after —
   * commit in one transaction. Compared by id, not by label: two goals may share
   * a title and still swap places.
   */
  async function reorderRows<T extends { id: number }>(
    ctx: AuditCtx,
    spec: ReorderSpec<T>,
  ): Promise<void> {
    const byId = new Map(spec.current.map((r) => [r.id, r]));
    const ids: number[] = [];
    for (const id of spec.orderedIds) if (byId.has(id) && !ids.includes(id)) ids.push(id);
    if (
      ids.length === 0 ||
      sameOrder(
        spec.current.map((r) => r.id),
        ids,
      )
    ) {
      return;
    }
    await withIntent([spec.model], () =>
      app.db.$transaction(async (tx) => {
        for (let i = 0; i < ids.length; i++) await spec.update(tx, ids[i]!, i);
        await recordAudit(inTx(ctx, tx), {
          action: 'reorder',
          entityType: spec.entry.entityType,
          entity: spec.entry.entity,
          summary: spec.entry.summary(ids.length),
          changes: [
            {
              kind: 'order',
              field: spec.entry.field,
              from: spec.current.map((r) => orderLabel(spec.label(r))),
              to: ids.map((id) => orderLabel(spec.label(byId.get(id)!))),
            },
          ],
        });
      }),
    );
  }

  /**
   * The link/unlink entry on a goal, worded exactly as the backstop words the
   * same join-row write (one item named, several counted), so a goal's history
   * reads the same whichever layer wrote it.
   */
  async function recordGoalLink(
    ctx: AuditCtx,
    action: 'link' | 'unlink',
    goal: { id: number; title: string },
    kind: 'evidence' | 'finding',
    labels: string[],
  ): Promise<void> {
    const verb = action === 'link' ? 'Linked' : 'Unlinked';
    const preposition = action === 'link' ? 'to' : 'from';
    const what =
      labels.length === 1
        ? `${kind} ${q(labels[0]!)}`
        : n(labels.length, kind, kind === 'evidence' ? 'evidence' : 'findings');
    await recordAudit(ctx, {
      action,
      entityType: 'goal',
      entity: { id: String(goal.id), label: goal.title },
      summary: `${verb} ${what} ${preposition} goal ${q(goal.title)}`,
      changes: [
        { kind: 'items', label: kind === 'evidence' ? 'Evidence' : 'Findings', items: labels },
      ],
    });
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
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        position: t.position,
        activities: [],
      };
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
      const current = await app.db.engagementTarget.findMany({
        where: { engagementId: eng.id },
        select: { id: true, name: true },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      await reorderRows(auditCtx(req, { id: eng.id, slug, name: eng.name }), {
        current,
        orderedIds,
        label: (t) => t.name,
        model: 'engagementTarget',
        update: (tx, id, position) =>
          tx.engagementTarget.update({ where: { id }, data: { position } }),
        entry: {
          entityType: 'engagement',
          entity: { id: String(eng.id), label: eng.name },
          field: 'targets',
          summary: (count) => `Reordered ${n(count, 'target')}`,
        },
      });
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
      const current = await app.db.targetActivity.findMany({
        where: { targetId: target.id },
        select: { id: true, name: true },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      await reorderRows(auditCtx(req, { id: eng.id, slug, name: eng.name }), {
        current,
        orderedIds,
        label: (a) => a.name,
        model: 'targetActivity',
        update: (tx, id, position) =>
          tx.targetActivity.update({ where: { id }, data: { position } }),
        entry: {
          entityType: 'target',
          entity: { id: String(target.id), label: target.name },
          field: 'activities',
          summary: (count) =>
            `Reordered ${n(count, 'activity', 'activities')} under target ${q(target.name)}`,
        },
      });
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
      const current = await app.db.activityGoal.findMany({
        where: { activityId: activity.id },
        select: { id: true, title: true },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      await reorderRows(auditCtx(req, { id: eng.id, slug, name: eng.name }), {
        current,
        orderedIds,
        label: (g) => g.title,
        model: 'activityGoal',
        update: (tx, id, position) => tx.activityGoal.update({ where: { id }, data: { position } }),
        entry: {
          entityType: 'activity',
          entity: { id: String(activity.id), label: activity.name },
          field: 'goals',
          summary: (count) => `Reordered ${n(count, 'goal')} under activity ${q(activity.name)}`,
        },
      });
      return { ok: true };
    },
  );

  // --- Goal ↔ evidence / finding links --------------------------------------

  /**
   * Bump a not-started goal to in-progress once it gains its first artifact.
   * Runs OUTSIDE the link handlers' audit scopes, and `activityGoal` is not in
   * their model lists either way, so the backstop records this status change as
   * its own entry on the goal — see the module header.
   */
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
        select: { id: true, title: true, contentType: true },
      });
      if (evidence.length) {
        // Only the links that will actually land are written and recorded: the
        // `skipDuplicates` on the insert makes a re-link a no-op, and a no-op is
        // not an event. The scope claims the join row only; the auto-advance
        // below stays the backstop's to record.
        const already = new Set(
          (
            await app.db.goalEvidence.findMany({
              where: { goalId: goal.id, evidenceId: { in: evidence.map((e) => e.id) } },
              select: { evidenceId: true },
            })
          ).map((r) => r.evidenceId),
        );
        const fresh = evidence.filter((e) => !already.has(e.id));
        if (fresh.length) {
          const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
          await withIntent(['goalEvidence'], async () => {
            await app.db.goalEvidence.createMany({
              data: fresh.map((e) => ({ goalId: goal.id, evidenceId: e.id })),
              skipDuplicates: true,
            });
            await recordGoalLink(ctx, 'link', goal, 'evidence', fresh.map(evidenceLabel));
          });
        }
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
        select: { id: true, title: true, contentType: true },
      });
      if (!ev) return { ok: true };
      const where = { goalId_evidenceId: { goalId: goal.id, evidenceId: ev.id } };
      // Unlinking what is not linked is a no-op, not an error — and not an
      // entry: nothing is written, so the scope is never entered.
      const link = await app.db.goalEvidence.findUnique({ where, select: { goalId: true } });
      if (!link) return { ok: true };
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      await withIntent(['goalEvidence'], async () => {
        // `deleteMany`, not `delete`: the link existed at the pre-check, but a
        // concurrent unlink could remove it first; `deleteMany` is idempotent
        // (0 rows, no throw) so the scope always reaches `recordGoalLink`. A
        // swallowed `delete` error would leave the backstop's tally of this
        // write unmatched by an entry and trip withIntent's tripwire.
        await app.db.goalEvidence.deleteMany({ where: { goalId: goal.id, evidenceId: ev.id } });
        await recordGoalLink(ctx, 'unlink', goal, 'evidence', [evidenceLabel(ev)]);
      });
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
        select: { id: true, title: true },
      });
      if (findings.length) {
        // As for evidence above: write and record only the links that will land.
        const already = new Set(
          (
            await app.db.goalFinding.findMany({
              where: { goalId: goal.id, findingId: { in: findings.map((f) => f.id) } },
              select: { findingId: true },
            })
          ).map((r) => r.findingId),
        );
        const fresh = findings.filter((f) => !already.has(f.id));
        if (fresh.length) {
          const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
          await withIntent(['goalFinding'], async () => {
            await app.db.goalFinding.createMany({
              data: fresh.map((f) => ({ goalId: goal.id, findingId: f.id })),
              skipDuplicates: true,
            });
            await recordGoalLink(
              ctx,
              'link',
              goal,
              'finding',
              fresh.map((f) => f.title),
            );
          });
        }
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
        select: { id: true, title: true },
      });
      if (!f) return { ok: true };
      const where = { goalId_findingId: { goalId: goal.id, findingId: f.id } };
      const link = await app.db.goalFinding.findUnique({ where, select: { goalId: true } });
      if (!link) return { ok: true };
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      await withIntent(['goalFinding'], async () => {
        // Idempotent delete, so a concurrent unlink cannot leave the scope with a
        // tallied write and no entry — see the evidence unlink above.
        await app.db.goalFinding.deleteMany({ where: { goalId: goal.id, findingId: f.id } });
        await recordGoalLink(ctx, 'unlink', goal, 'finding', [f.title]);
      });
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
      const rawJson = rawProposal == null ? undefined : (rawProposal as Prisma.InputJsonValue);

      // AUDIT. An import is one event, not one per target, activity, goal, tag
      // and category: the whole transaction runs as an importer (the backstop
      // counts rows and records nothing) under a scope claiming every model, and
      // ONE `import` entry on the engagement is written through `tx` at the end,
      // once the counts are final, so it commits with the rows. The raw proposal
      // is never in the entry — the column is redacted everywhere else and the
      // entry simply does not mention it. A run that throws part-way records
      // nothing, and nothing landed either.
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });

      // The whole import is one transaction: a `replace` must never delete the
      // existing tree and then only partially rebuild it if a later create fails.
      return withIntent(ALL_AUDITED_MODELS, () =>
        withImporter('proposal-import', () =>
          app.db.$transaction(async (tx): Promise<ImportResult> => {
            let targetsRemoved = 0;
            if (mode === 'replace') {
              targetsRemoved = (
                await tx.engagementTarget.deleteMany({ where: { engagementId: eng.id } })
              ).count;
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
                    : ((eng.scopeTargets as unknown as { name: string; subsystems: string[] }[]) ??
                      []);
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
            let categoriesSeeded = 0;
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
              categoriesSeeded = categoryNames.size;
            }

            const created =
              `${n(targetsCreated, 'target')}, ` +
              `${n(activitiesCreated, 'activity', 'activities')} and ${n(goalsCreated, 'goal')} created`;
            const changes: AuditChange[] = [
              { kind: 'field', field: 'mode', from: null, to: mode },
              { kind: 'field', field: 'applyMetadata', from: null, to: applyMetadata },
              ...(mode === 'replace'
                ? [{ kind: 'count' as const, label: 'Targets removed', count: targetsRemoved }]
                : []),
              { kind: 'count', label: 'Targets', count: targetsCreated },
              { kind: 'count', label: 'Activities', count: activitiesCreated },
              { kind: 'count', label: 'Goals', count: goalsCreated },
              ...(applyMetadata
                ? [{ kind: 'count' as const, label: 'Finding categories', count: categoriesSeeded }]
                : []),
            ];
            await recordAudit(inTx(ctx, tx), {
              action: 'import',
              entityType: 'engagement',
              entity: { id: String(eng.id), label: eng.name },
              summary:
                (mode === 'replace'
                  ? `Replaced the goals tree from a proposal (${n(targetsRemoved, 'target')} removed): `
                  : 'Imported a proposal into the goals tree: ') +
                created +
                (metadataApplied ? '; engagement details applied' : ''),
              changes,
            });

            return { targetsCreated, activitiesCreated, goalsCreated, metadataApplied };
          }),
        ),
      );
    },
  );
}
