/**
 * Engagement goals: the Target → Activity → Goal tree, rolled-up progress, and
 * the per-activity correlation tag. Shared by the goals routes, the engagement
 * list/detail (progress), and the report's Scope & Objectives Coverage section.
 */
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import {
  GOAL_STATUSES,
  defaultTagColorFor,
  type EngagementProgress,
  type GoalStatus,
  type Target,
} from '@reporter/shared';
import { REPORT_VISIBLE_EVIDENCE } from '../helpers/report-visibility.js';

export function emptyProgress(): EngagementProgress {
  return { total: 0, complete: 0, inProgress: 0, notStarted: 0, notApplicable: 0, percent: 0 };
}

/** Build an `EngagementProgress` from a per-status count map. */
export function progressFromCounts(
  counts: Partial<Record<GoalStatus, number>>,
): EngagementProgress {
  const complete = counts.complete ?? 0;
  const inProgress = counts.in_progress ?? 0;
  const notStarted = counts.not_started ?? 0;
  const notApplicable = counts.not_applicable ?? 0;
  const total = complete + inProgress + notStarted + notApplicable;
  const denom = Math.max(1, total - notApplicable);
  const percent = total === 0 ? 0 : Math.round((complete / denom) * 100);
  return { total, complete, inProgress, notStarted, notApplicable, percent };
}

/**
 * Progress for many engagements in one query (used by the engagement list).
 * Engagements with no goals are simply absent from the map (callers omit
 * `progress` for them). Returns an empty map when given no ids.
 */
export async function computeEngagementProgress(
  app: FastifyInstance,
  engagementIds: number[],
): Promise<Map<number, EngagementProgress>> {
  const out = new Map<number, EngagementProgress>();
  if (engagementIds.length === 0) return out;
  const rows = await app.db.$queryRaw<{ engagement_id: number; status: string; n: number }[]>(
    Prisma.sql`
      SELECT t.engagement_id AS engagement_id, g.status::text AS status, COUNT(*)::int AS n
      FROM activity_goals g
      JOIN target_activities a ON a.id = g.activity_id
      JOIN engagement_targets t ON t.id = a.target_id
      WHERE t.engagement_id IN (${Prisma.join(engagementIds)})
      GROUP BY t.engagement_id, g.status
    `,
  );
  const byEng = new Map<number, Partial<Record<GoalStatus, number>>>();
  for (const r of rows) {
    const c = byEng.get(r.engagement_id) ?? {};
    if ((GOAL_STATUSES as readonly string[]).includes(r.status)) {
      c[r.status as GoalStatus] = r.n;
    }
    byEng.set(r.engagement_id, c);
  }
  for (const [id, counts] of byEng) out.set(id, progressFromCounts(counts));
  return out;
}

/** Progress for a single engagement (null when it has no goals). */
export async function computeOneEngagementProgress(
  app: FastifyInstance,
  engagementId: number,
): Promise<EngagementProgress | undefined> {
  const map = await computeEngagementProgress(app, [engagementId]);
  return map.get(engagementId);
}

/**
 * The full goals tree for an engagement, serialized to the client shape.
 *
 * `forReport` scopes each goal's evidence tally to evidence the report is allowed
 * to show ({@link REPORT_VISIBLE_EVIDENCE}). Without it a goal whose only evidence
 * is excluded prints "0 / 1" in the Scope & Objectives Coverage table — pointing
 * the reader at an item that appears nowhere in the document. The interactive
 * Goals page omits the flag and keeps the true totals, because excluded evidence
 * stays visible in the app (badged) so it can be un-excluded.
 */
export async function fetchGoalsTree(
  app: FastifyInstance,
  engagementId: number,
  opts: { forReport?: boolean } = {},
): Promise<Target[]> {
  const evidenceCount = opts.forReport ? { where: { evidence: REPORT_VISIBLE_EVIDENCE } } : true;
  const targets = await app.db.engagementTarget.findMany({
    where: { engagementId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    include: {
      activities: {
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        include: {
          goals: {
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
            include: { _count: { select: { evidence: evidenceCount, findings: true } } },
          },
        },
      },
    },
  });

  return targets.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    position: t.position,
    activities: t.activities.map((a) => ({
      id: a.id,
      name: a.name,
      category: a.category,
      tagId: a.tagId,
      position: a.position,
      goals: a.goals.map((g) => ({
        id: g.id,
        title: g.title,
        status: g.status,
        isRetest: g.isRetest,
        notes: g.notes,
        position: g.position,
        numEvidence: g._count.evidence,
        numFindings: g._count.findings,
      })),
    })),
  }));
}

/** Progress rolled up from an already-fetched goals tree. */
export function progressFromTree(targets: Target[]): EngagementProgress {
  const counts: Partial<Record<GoalStatus, number>> = {};
  for (const t of targets)
    for (const a of t.activities)
      for (const g of a.goals) counts[g.status] = (counts[g.status] ?? 0) + 1;
  return progressFromCounts(counts);
}

/**
 * Find or create the engagement tag that correlates evidence to an activity, and
 * return its id. Tags are unique per (engagement, name); an existing tag with the
 * same name is reused. A blank name yields no tag (returns null).
 */
export async function ensureActivityTag(
  db: Prisma.TransactionClient,
  engagementId: number,
  activityName: string,
): Promise<number | null> {
  const name = activityName.trim().slice(0, 64);
  if (!name) return null;
  const tag = await db.tag.upsert({
    where: { engagementId_name: { engagementId, name } },
    create: { engagementId, name, colorName: defaultTagColorFor(name) },
    update: {},
  });
  return tag.id;
}
