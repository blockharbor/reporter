import type { FastifyInstance } from 'fastify';
import {
  SEVERITY_LABELS,
  attachEvidenceInput,
  createFindingInput,
  reorderInput,
  scoreVector,
  updateFindingEvidenceInput,
  updateFindingInput,
  type AuditChange,
} from '@reporter/shared';
import { HttpError, requireAuth, requireEngagementRole } from '../../auth/guards.js';
import { REPORT_VISIBLE_EVIDENCE } from '../../helpers/report-visibility.js';
import { FINDING_TAG_ORDER_BY, TAG_ORDER_BY } from '../../services/tags.js';
import {
  evidenceInclude,
  recommendationCountsByFinding,
  serializeFinding,
  serializeFindingEvidence,
} from '../../services/serializers.js';
import {
  auditCtx,
  coalesceOrInsert,
  diffFinding,
  evidenceLabel,
  inTx,
  n,
  orderLabel,
  q,
  recordAudit,
  recordUpdate,
  sameOrder,
  withIntent,
  type FindingAuditRow,
} from '../../services/audit.js';

// Every finding read (list + detail) carries its link counts: attached evidence,
// linked goals, and the strategic recommendations addressing it. The Findings page
// filters/sorts on all three, client-side.
//
// Only the first two are relations countable here. `numRecommendations` comes from
// the engagement's `strategicRecommendations` JSON column, so every route below
// turns that column into a `findingUuid → count` map once, up front, with
// `recommendationCountsByFinding` — one parse per request, never one per finding.
// Each route already has the engagement row in hand (it resolves `:slug` to an id),
// so the column costs no extra query.
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
  // A plain relation include, not a `_count`: the read shape carries the full tag
  // objects, because every finding card renders the chips and the Findings page
  // filters on them client-side over the fetched array. Ordered by the
  // engagement's curated tag order, like the chips on an evidence row.
  tags: { include: { tag: true }, orderBy: FINDING_TAG_ORDER_BY },
  evidence: { where: { evidence: REPORT_VISIBLE_EVIDENCE }, select: { evidenceId: true } },
  _count: { select: { evidence: true, goals: true } },
} as const;

/**
 * The before-image for the audit diff: the category by name and the tags by
 * name, in the same curated order `findingInclude` reads them back in, so
 * `diffFinding` compares like with like.
 */
const auditInclude = {
  category: true,
  tags: { include: { tag: true }, orderBy: FINDING_TAG_ORDER_BY },
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

// ---------------------------------------------------------------------------
// Audit wording helpers
// ---------------------------------------------------------------------------

/** The glossary name of a finding's evidence bucket, as a summary says it. */
function bucketName(inPath: boolean): string {
  return inPath ? 'attack path' : 'attached evidence';
}

/** The same bucket as a change label / order field ("Attack path", "Attached evidence"). */
function bucketLabel(inPath: boolean): string {
  return inPath ? 'Attack path' : 'Attached evidence';
}
function bucketField(inPath: boolean): string {
  return inPath ? 'attackPath' : 'attachedEvidence';
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
      const recCounts = recommendationCountsByFinding(eng.strategicRecommendations);
      return findings.map((f) => serializeFinding(f, slug, recCounts.get(f.uuid) ?? 0));
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
      // Only attach tags that actually belong to this engagement — a foreign id is
      // dropped rather than rejected, exactly as on evidence. Distinct by primary
      // key, so a duplicated id in the payload collapses for free. The names ride
      // along for the audit entry.
      const validTags =
        input.tagIds.length > 0
          ? await app.db.tag.findMany({
              where: { id: { in: input.tagIds }, engagementId: eng.id },
              select: { id: true, name: true },
              orderBy: TAG_ORDER_BY,
            })
          : [];
      // The category upsert runs BEFORE the audit scope below, on purpose: it may
      // mint a category (or revive a soft-deleted one), and that is an event of
      // its own which the backstop records — inside the scope it would be silenced
      // as part of the create, and a scope that only names `finding` would not
      // even claim it.
      const categoryId = await categoryIdFor(app, eng.id, input.category);

      // Hand-written rather than left to the backstop: the backstop would list a
      // dozen default-valued columns and say "Tags created: 2" about the nested
      // join rows, when what happened is that someone created a finding of a
      // kind, in a category, with these tags. The nested tag rows are part of the
      // one create statement and never reach the backstop as writes of their own,
      // so `finding` is the only model to claim.
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      const finding = await withIntent(['finding'], async () => {
        const created = await app.db.finding.create({
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
            categoryId,
            position: (max._max.position ?? -1) + 1,
            tags: { create: validTags.map((t) => ({ tagId: t.id })) },
          },
          include: findingInclude,
        });
        const changes: AuditChange[] = [
          { kind: 'field', field: 'kind', from: null, to: created.kind },
        ];
        if (created.category) {
          changes.push({
            kind: 'field',
            field: 'category',
            from: null,
            to: created.category.category,
          });
        }
        if (created.kind !== 'strength') {
          changes.push({ kind: 'field', field: 'fixEffort', from: null, to: created.fixEffort });
        }
        if (validTags.length > 0) {
          changes.push({ kind: 'items', label: 'Tags', items: validTags.map((t) => t.name) });
        }
        await recordAudit(ctx, {
          action: 'create',
          entityType: 'finding',
          entity: { id: created.uuid, label: created.title },
          summary: `Created finding ${q(created.title)}${created.kind === 'strength' ? ' (strength)' : ''}`,
          changes,
        });
        return created;
      });
      reply.status(201);
      // In practice 0 — nothing can address a uuid that didn't exist a moment ago —
      // but derived like everywhere else rather than hard-coded, so this stays right
      // if creation ever accepts a caller-supplied uuid (the import path already does).
      const recCounts = recommendationCountsByFinding(eng.strategicRecommendations);
      return serializeFinding(finding, slug, recCounts.get(finding.uuid) ?? 0);
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
      const recCounts = recommendationCountsByFinding(eng.strategicRecommendations);
      return {
        ...serializeFinding(finding, slug, recCounts.get(finding.uuid) ?? 0),
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
      const finding = await app.db.finding.findFirst({
        where: { uuid, engagementId: eng.id },
        include: auditInclude,
      });
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
        // The category upsert stays outside the transaction and the audit scope
        // below (pre-existing, and the right place: a category minted or revived
        // here is the backstop's own event to record).
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

      // The audit entry: one coalescable entry per changed field, through
      // `diffFinding` — the same differ the backstop would use, hand-written here
      // because the row and its tag join rows move in one transaction, which the
      // backstop cannot see into, and because the category reads by name here
      // rather than by id.
      //
      // The save is gated on a PREDICTED diff first. The editor autosaves, so
      // "type a letter, delete it" lands here as an update that changes nothing;
      // `recordUpdate` writes nothing for an empty diff (a no-op save is not an
      // event), and a `withIntent` scope that writes its model and records
      // nothing is exactly the "forgot the entry" condition the tripwire exists
      // for. So a save the diff says is empty takes the other path: one plain
      // update outside any scope and any transaction, where the backstop sees it,
      // diffs the real before/after and stays silent because only `updatedAt`
      // (and the derived `cvssScore`) moved. That path also skips the tag
      // rewrite — an empty diff means the tag set is the one already stored, and
      // a delete-and-recreate of identical join rows inside a transaction would
      // be an unwrapped transactional write for nothing. The prediction is
      // faithful because `data` holds plain column values the transaction writes
      // verbatim, the category name is the exact string the upsert stored, and
      // the tag names are filtered by the same engagement check and read in the
      // same curated order as the read-back.
      const tagsAfter = body.tagIds
        ? (
            await app.db.tag.findMany({
              where: { id: { in: body.tagIds }, engagementId: eng.id },
              select: { name: true },
              orderBy: TAG_ORDER_BY,
            })
          ).map((t) => ({ tag: { name: t.name } }))
        : finding.tags;
      const predictedAfter: FindingAuditRow = {
        title: data.title ?? finding.title,
        description: data.description ?? finding.description,
        kind: data.kind ?? finding.kind,
        affectedTarget: data.affectedTarget ?? finding.affectedTarget,
        impact: data.impact ?? finding.impact,
        fixEffort: data.fixEffort ?? finding.fixEffort,
        remediation: data.remediation ?? finding.remediation,
        readyToReport: data.readyToReport ?? finding.readyToReport,
        severity: data.severity === undefined ? finding.severity : data.severity,
        cvssVector: data.cvssVector === undefined ? finding.cvssVector : data.cvssVector,
        iso21434Refs: data.iso21434Refs ?? finding.iso21434Refs,
        unr155Refs: data.unr155Refs ?? finding.unr155Refs,
        category:
          body.category === undefined
            ? finding.category
            : body.category
              ? { category: body.category }
              : null,
        tags: tagsAfter,
      };
      const predicted = diffFinding(finding, predictedAfter);
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      const updated =
        predicted.length === 0
          ? await app.db.finding.update({
              where: { id: finding.id },
              data,
              include: findingInclude,
            })
          : // The row and its tags move together: a join rewrite that failed after
            // the row update would leave the finding saved with stale tags. Both
            // models are claimed, and the entries are written through `tx` from a
            // read-back of the row as the transaction left it, so a rolled-back
            // save records nothing and a committed one records what was stored.
            await withIntent(['finding', 'findingTag'], () =>
              app.db.$transaction(async (tx) => {
                await tx.finding.update({ where: { id: finding.id }, data });
                // `if (body.tagIds)`, not `?.length`: an explicit `[]` must clear the tags.
                // That is the set-replace contract, the same as on evidence.
                if (body.tagIds) {
                  const valid = await tx.tag.findMany({
                    where: { id: { in: body.tagIds }, engagementId: eng.id },
                    select: { id: true },
                  });
                  await tx.findingTag.deleteMany({ where: { findingId: finding.id } });
                  await tx.findingTag.createMany({
                    data: valid.map((t) => ({ findingId: finding.id, tagId: t.id })),
                  });
                }
                // Read back inside the transaction: the update's own `include` would have
                // been resolved before the join rewrite, so the response would carry the
                // tags the finding had a moment ago.
                const after = await tx.finding.findUniqueOrThrow({
                  where: { id: finding.id },
                  include: findingInclude,
                });
                await recordUpdate(inTx(ctx, tx), {
                  entityType: 'finding',
                  entity: { id: finding.uuid, label: finding.title },
                  noun: 'finding',
                  changes: diffFinding(finding, after),
                });
                return after;
              }),
            );
      const recCounts = recommendationCountsByFinding(eng.strategicRecommendations);
      return serializeFinding(updated, slug, recCounts.get(updated.uuid) ?? 0);
    },
  );

  app.delete(
    '/engagements/:slug/findings/:uuid',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const finding = await app.db.finding.findFirst({
        where: { uuid, engagementId: eng.id },
        include: { _count: { select: { evidence: true, goals: true } } },
      });
      if (!finding) throw new HttpError(404, 'Finding not found');
      // The evidence links, goal links and tag rows go by database cascade,
      // invisible to the backstop, so the entry carries their counts; the kind,
      // rating and report-readiness ride along so the log shows what kind of
      // finding was removed. Best-effort after the delete, as for evidence — a
      // finding delete is not one of the destructive admin flows whose record
      // must commit with the work.
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      await withIntent(['finding'], async () => {
        await app.db.finding.delete({ where: { id: finding.id } });
        const rating =
          finding.kind === 'strength'
            ? ' (strength)'
            : finding.severity
              ? ` (${SEVERITY_LABELS[finding.severity]})`
              : '';
        const links = finding._count.evidence;
        const changes: AuditChange[] = [
          { kind: 'field', field: 'kind', from: finding.kind, to: null },
          ...(finding.severity
            ? [{ kind: 'field' as const, field: 'severity', from: finding.severity, to: null }]
            : []),
          { kind: 'field', field: 'readyToReport', from: finding.readyToReport, to: null },
          { kind: 'count', label: 'Evidence links', count: links },
          { kind: 'count', label: 'Goal links', count: finding._count.goals },
        ];
        await recordAudit(ctx, {
          action: 'delete',
          entityType: 'finding',
          entity: { id: finding.uuid, label: finding.title },
          summary:
            `Deleted finding ${q(finding.title)}${rating}` +
            (links > 0 ? `; ${n(links, 'evidence', 'evidence')} detached` : ''),
          changes,
        });
      });
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
        select: { id: true, uuid: true, title: true, contentType: true },
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
      // listed the evidence. A uuid repeated in the payload is kept once.
      const byUuid = new Map(evidence.map((e) => [e.uuid, e]));
      const toAttach: typeof evidence = [];
      for (const u of evidenceUuids) {
        const ev = byUuid.get(u);
        if (ev && !attachedIds.has(ev.id)) {
          attachedIds.add(ev.id);
          toAttach.push(ev);
        }
      }
      // Nothing new to attach is nothing to write and nothing to record: the
      // scope below is only entered when a link row will land.
      if (toAttach.length === 0) return { ok: true, attached: 0 };

      // One entry for the whole attach, however many items — the backstop would
      // say the same for a `createMany`, but it says it per owner from the row
      // ids and cannot name the bucket.
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      await withIntent(['evidenceFinding'], async () => {
        await app.db.evidenceFinding.createMany({
          data: toAttach.map((ev) => ({
            evidenceId: ev.id,
            findingId: finding.id,
            position: nextPos++,
            inPath,
          })),
          skipDuplicates: true,
        });
        const labels = toAttach.map(evidenceLabel);
        const what =
          labels.length === 1
            ? `evidence ${q(labels[0]!)}`
            : n(labels.length, 'evidence', 'evidence');
        await recordAudit(ctx, {
          action: 'link',
          entityType: 'finding',
          entity: { id: finding.uuid, label: finding.title },
          summary: `Attached ${what} to finding ${q(finding.title)} (${bucketName(inPath)})`,
          changes: [{ kind: 'items', label: bucketLabel(inPath), items: labels }],
        });
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
        select: { id: true, uuid: true, title: true, contentType: true },
      });
      if (!finding || !evidence) throw new HttpError(404, 'Not found');
      const where = { evidenceId_findingId: { evidenceId: evidence.id, findingId: finding.id } };
      const link = await app.db.evidenceFinding.findUnique({ where });
      if (!link) throw new HttpError(404, 'Evidence is not attached to this finding');

      const data: { caption?: string; inPath?: boolean; position?: number } = {};
      const captioned = body.caption !== undefined && body.caption !== link.caption;
      if (body.caption !== undefined) data.caption = body.caption;
      // Moving buckets: append to the end of the target bucket so positions stay
      // dense per bucket. A no-op move (same bucket) leaves position untouched.
      const moved = body.inPath !== undefined && body.inPath !== link.inPath;
      if (moved) {
        const count = await app.db.evidenceFinding.count({
          where: { findingId: finding.id, inPath: body.inPath },
        });
        data.inPath = body.inPath;
        data.position = count;
      }

      const update = () =>
        app.db.evidenceFinding.update({
          where,
          data,
          include: { evidence: { include: evidenceInclude(req.authedUser!.id) } },
        });
      // A patch that changes nothing (the same caption again, the bucket it is
      // already in) runs outside the scope: the backstop sees an update with no
      // diff and writes nothing, and a scope with a listed write and no entry
      // would trip.
      if (!moved && !captioned) return serializeFindingEvidence(await update(), slug);

      // Two different events on the link row, identified by both uuids as the
      // backstop would. A bucket move is a deliberate flip and never folds
      // (`recordAudit`); a caption edit is typed into a field and folds per
      // (actor, link) within the window, so its summary never embeds the new
      // text. The label matches the backstop's for the same row, so one row's
      // history filters as one thread whichever layer wrote it.
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      const evLabel = evidenceLabel(evidence);
      const entity = {
        id: `${finding.uuid}:${evidence.uuid}`,
        label: `${finding.title} ↔ ${evLabel}`,
      };
      const updated = await withIntent(['evidenceFinding'], async () => {
        const row = await update();
        if (moved) {
          await recordAudit(ctx, {
            action: 'update',
            entityType: 'finding_evidence',
            entity,
            summary: `Moved evidence ${q(evLabel)} to the ${bucketName(body.inPath!)} of finding ${q(finding.title)}`,
            changes: [{ kind: 'field', field: 'inPath', from: link.inPath, to: body.inPath! }],
          });
        }
        if (captioned) {
          await coalesceOrInsert(ctx, {
            action: 'update',
            entityType: 'finding_evidence',
            entity,
            summary: `Edited the caption of evidence ${q(evLabel)} on finding ${q(finding.title)}`,
            changes: [{ kind: 'field', field: 'caption', from: link.caption, to: body.caption! }],
            coalesceKey: 'caption',
          });
        }
        return row;
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
      // Read in the list's own order, which is the `from` side of the entry.
      const findings = await app.db.finding.findMany({
        where: { engagementId: eng.id },
        select: { id: true, uuid: true, title: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      });
      const byUuid = new Map(findings.map((f) => [f.uuid, f]));
      if (byUuid.size !== orderedUuids.length || orderedUuids.some((u) => !byUuid.has(u))) {
        throw new HttpError(400, 'Order must list exactly the findings in this engagement');
      }
      // The same order again (a drag dropped back where it started) moves
      // nothing: no write, no entry. Compared by uuid, not by title — two
      // findings may share a title and still swap places.
      if (
        sameOrder(
          findings.map((f) => f.uuid),
          orderedUuids,
        )
      ) {
        return { ok: true };
      }

      // ONE entry for the reorder, with the titles before and after, written
      // through the transaction so it commits with the positions. The backstop
      // would otherwise be silent (an unwrapped transaction) or, unwrapped and
      // outside one, say "Edited finding: Position" N times.
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      await withIntent(['finding'], () =>
        app.db.$transaction(async (tx) => {
          for (let i = 0; i < orderedUuids.length; i++) {
            await tx.finding.update({
              where: { id: byUuid.get(orderedUuids[i]!)!.id },
              data: { position: i },
            });
          }
          await recordAudit(inTx(ctx, tx), {
            action: 'reorder',
            entityType: 'engagement',
            entity: { id: String(eng.id), label: eng.name },
            summary: `Reordered ${n(orderedUuids.length, 'finding')}`,
            changes: [
              {
                kind: 'order',
                field: 'findings',
                from: findings.map((f) => orderLabel(f.title)),
                to: orderedUuids.map((u) => orderLabel(byUuid.get(u)!.title)),
              },
            ],
          });
        }),
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
        select: {
          evidenceId: true,
          inPath: true,
          evidence: { select: { uuid: true, title: true, contentType: true } },
        },
        orderBy: [{ position: 'asc' }, { evidenceId: 'asc' }],
      });
      const byUuid = new Map(links.map((l) => [l.evidence.uuid, l]));
      // Every submitted uuid must be linked to this finding, but the submitted set
      // need not be every link — it's a single bucket's ordering.
      if (orderedUuids.some((u) => !byUuid.has(u))) {
        throw new HttpError(400, 'Order references evidence not attached to this finding');
      }
      // The bucket is the one the first submitted link sits in; its current
      // order is the `from` side of the entry. The same order again is no write
      // and no entry.
      const inPath = byUuid.get(orderedUuids[0]!)!.inPath;
      const bucket = links.filter((l) => l.inPath === inPath);
      if (
        sameOrder(
          bucket.map((l) => l.evidence.uuid),
          orderedUuids,
        )
      ) {
        return { ok: true };
      }

      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      await withIntent(['evidenceFinding'], () =>
        app.db.$transaction(async (tx) => {
          for (let i = 0; i < orderedUuids.length; i++) {
            await tx.evidenceFinding.update({
              where: {
                evidenceId_findingId: {
                  evidenceId: byUuid.get(orderedUuids[i]!)!.evidenceId,
                  findingId: finding.id,
                },
              },
              data: { position: i },
            });
          }
          await recordAudit(inTx(ctx, tx), {
            action: 'reorder',
            entityType: 'finding',
            entity: { id: finding.uuid, label: finding.title },
            summary: `Reordered ${n(orderedUuids.length, 'evidence', 'evidence')} in the ${bucketName(inPath)} of finding ${q(finding.title)}`,
            changes: [
              {
                kind: 'order',
                field: bucketField(inPath),
                from: bucket.map((l) => orderLabel(evidenceLabel(l.evidence))),
                to: orderedUuids.map((u) => orderLabel(evidenceLabel(byUuid.get(u)!.evidence))),
              },
            ],
          });
        }),
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
        select: { id: true, uuid: true, title: true, contentType: true },
      });
      if (!finding || !evidence) throw new HttpError(404, 'Not found');
      const where = { evidenceId_findingId: { evidenceId: evidence.id, findingId: finding.id } };
      // Detaching evidence that is not attached is a no-op, not an error — and
      // not an entry: nothing is written, so the scope below is never entered.
      const link = await app.db.evidenceFinding.findUnique({ where, select: { inPath: true } });
      if (!link) return { ok: true };

      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      const evLabel = evidenceLabel(evidence);
      await withIntent(['evidenceFinding'], async () => {
        // Idempotent delete: the link existed at the pre-check, and `deleteMany`
        // does not throw if a concurrent detach removed it first, so the scope
        // always reaches `recordAudit`. A swallowed `delete` error would leave
        // the backstop's tally of this write unmatched and trip the tripwire.
        await app.db.evidenceFinding.deleteMany({
          where: { evidenceId: evidence.id, findingId: finding.id },
        });
        await recordAudit(ctx, {
          action: 'unlink',
          entityType: 'finding',
          entity: { id: finding.uuid, label: finding.title },
          summary: `Detached evidence ${q(evLabel)} from finding ${q(finding.title)} (${bucketName(link.inPath)})`,
          changes: [{ kind: 'items', label: bucketLabel(link.inPath), items: [evLabel] }],
        });
      });
      return { ok: true };
    },
  );
}
