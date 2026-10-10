import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  createTagInput,
  mergeTagInput,
  reorderIdsInput,
  updateTagInput,
  type AuditChange,
} from '@reporter/shared';
import { HttpError, requireAuth, requireEngagementRole } from '../../auth/guards.js';
import { serializeTag } from '../../services/serializers.js';
import {
  DUPLICATE_TAG_NAME,
  TAG_ORDER_BY,
  mergeTagInto,
  nextTagPosition,
  rethrowDuplicateTagName,
  rewriteTimelineTagNames,
  tagReferencesFor,
  unapplyTag,
} from '../../services/tags.js';
import { auditCtx, inTx, n, orderLabel, q, recordAudit, withIntent } from '../../services/audit.js';

/**
 * Tag management for the web UI. Roles: `read` for the two GETs, `write` for
 * every mutation — engagement writers can manage tags today, and only Details,
 * Members and the danger zone are gated on `admin`.
 *
 * The list route is the one every picker and chip row follows, which is why it
 * orders by the curated `position` rather than by name, and why it carries the
 * split usage counts and the activity hint that the delete / merge / unapply
 * confirmations quote.
 *
 * AUDIT. Create is left to the backstop: one plain write whose row-level truth
 * ("Created tag “recon”") is the right sentence. Every other mutation runs in a
 * transaction — the backstop cannot see into one — and each describes itself:
 * a reorder is ONE entry with the names before and after, a rename and recolor
 * is one discrete entry (dialog-driven, so it never folds), and delete, merge
 * and unapply are one entry each carrying the counts of what they touched,
 * including the by-name timeline rewrite that otherwise surfaces as an
 * engagement edit. Each `withIntent` names exactly the models its transaction
 * writes, and the entry is written through `tx` so it commits with the work.
 */
export async function tagRoutes(app: FastifyInstance): Promise<void> {
  const engBySlug = (slug: string) => app.db.engagement.findUniqueOrThrow({ where: { slug } });

  /** Parse a positive-integer route param or 400. */
  function intParam(v: string, what: string): number {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${what} id`);
    return n;
  }

  /**
   * Load a tag scoped to the engagement (404 if it belongs elsewhere). Takes the
   * client explicitly so a mutation can read the row INSIDE its own transaction:
   * rename, merge and delete all go on to write the tag's *name* into the report
   * timeline config, and a name read before the transaction opened could have
   * been renamed by a concurrent request in between — leaving the config naming
   * a tag that no longer exists.
   */
  async function getTag(db: Prisma.TransactionClient, engagementId: number, id: number) {
    const t = await db.tag.findFirst({ where: { id, engagementId } });
    if (!t) throw new HttpError(404, 'Tag not found');
    return t;
  }

  /** The list-shaped include: split counts and the activity names. */
  const listInclude = {
    // Split counts: the delete, merge and unapply confirmations all state the
    // blast radius, and "3 evidence" reads very differently from "3 evidence and
    // 11 findings".
    _count: { select: { evidence: true, findings: true } },
    // Which Goals activities use this as their correlation tag — quoted as a hint
    // in the rename editor, because renaming the *activity* later mints a fresh
    // tag rather than following this one (`ensureActivityTag`).
    activities: { select: { name: true } },
  } as const;

  type ListRow = Prisma.TagGetPayload<{ include: typeof listInclude }>;

  function serializeListRow(t: ListRow) {
    const evidenceCount = t._count.evidence;
    const findingCount = t._count.findings;
    // `usageCount` stays the total, so every reader of that field means what it
    // always meant; the split is what the confirmations quote.
    return serializeTag(t, evidenceCount + findingCount, {
      evidenceCount,
      findingCount,
      activityNames: t.activities.map((a) => a.name),
    });
  }

  app.get(
    '/engagements/:slug/tags',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const eng = await engBySlug(slug);
      const tags = await app.db.tag.findMany({
        where: { engagementId: eng.id },
        // Curated order, not alphabetical — this list is what every picker and
        // every chip row follows.
        orderBy: TAG_ORDER_BY,
        include: listInclude,
      });
      return tags.map(serializeListRow);
    },
  );

  app.post(
    '/engagements/:slug/tags',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const input = createTagInput.parse(req.body);
      const eng = await engBySlug(slug);
      const existing = await app.db.tag.findUnique({
        where: { engagementId_name: { engagementId: eng.id, name: input.name } },
      });
      if (existing) throw new HttpError(409, DUPLICATE_TAG_NAME);
      const tag = await app.db.tag
        .create({
          data: {
            engagementId: eng.id,
            name: input.name,
            colorName: input.colorName,
            // A new tag lands at the end of the curated list.
            position: await nextTagPosition(app.db, eng.id),
          },
        })
        .catch(rethrowDuplicateTagName);
      reply.status(201);
      return serializeTag(tag);
    },
  );

  // Reorder the engagement's tags. Body is the FULL ordered id list: tags have no
  // uuid, so the body schema is goals' `reorderIdsInput`, but the validation is
  // findings' strict form — a partial list would leave the omitted tags holding
  // positions that collide with the reassigned ones. The duplicate check is an
  // addition: a list with a repeat would silently drop whichever id it displaced.
  //
  // Registered before the `:id` routes for readability; the router prefers the
  // static segment either way.
  app.patch(
    '/engagements/:slug/tags/reorder',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const { orderedIds } = reorderIdsInput.parse(req.body);
      const eng = await engBySlug(slug);
      // Read in the list's own order, which is the `from` side of the entry.
      const tags = await app.db.tag.findMany({
        where: { engagementId: eng.id },
        select: { id: true, name: true },
        orderBy: TAG_ORDER_BY,
      });
      const byId = new Map(tags.map((t) => [t.id, t]));
      if (
        byId.size !== orderedIds.length ||
        new Set(orderedIds).size !== orderedIds.length ||
        orderedIds.some((tid) => !byId.has(tid))
      ) {
        throw new HttpError(400, 'Order must list exactly the tags in this engagement, once each');
      }
      // The same order again (a drag dropped back where it started) moves
      // nothing: no write, no entry.
      if (tags.every((t, i) => t.id === orderedIds[i])) return { ok: true };

      // ONE entry for the reorder, with the names before and after, written
      // through the transaction so it commits with the positions.
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      await withIntent(['tag'], () =>
        app.db.$transaction(async (tx) => {
          for (let i = 0; i < orderedIds.length; i++) {
            await tx.tag.update({ where: { id: orderedIds[i]! }, data: { position: i } });
          }
          await recordAudit(inTx(ctx, tx), {
            action: 'reorder',
            entityType: 'engagement',
            entity: { id: String(eng.id), label: eng.name },
            summary: `Reordered ${n(orderedIds.length, 'tag')}`,
            changes: [
              {
                kind: 'order',
                field: 'tags',
                from: tags.map((t) => orderLabel(t.name)),
                to: orderedIds.map((id) => orderLabel(byId.get(id)!.name)),
              },
            ],
          });
        }),
      );
      return { ok: true };
    },
  );

  app.put(
    '/engagements/:slug/tags/:id',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const input = updateTagInput.parse(req.body);
      const eng = await engBySlug(slug);
      const tagId = intParam(id, 'tag');
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      // `engagement` is claimed as well as `tag`: a rename rewrites the report's
      // timeline config, which would otherwise surface as an engagement edit.
      const updated = await withIntent(['tag', 'engagement'], () =>
        app.db.$transaction(async (tx) => {
          const tag = await getTag(tx, eng.id, tagId);
          const renamedTo = input.name !== undefined && input.name !== tag.name ? input.name : null;
          const recolorTo =
            input.colorName !== undefined && input.colorName !== tag.colorName
              ? input.colorName
              : null;
          if (renamedTo) {
            // Pre-check the @@unique([engagementId, name]) constraint. Without it a
            // rename collision reached app.ts's catch-all as a 500 — and the rename
            // UI would hit that on day one. `rethrowDuplicateTagName` below covers
            // the race between this read and the write.
            const clash = await tx.tag.findUnique({
              where: { engagementId_name: { engagementId: eng.id, name: renamedTo } },
            });
            if (clash) throw new HttpError(409, DUPLICATE_TAG_NAME);
          }
          // A save that changes nothing — the dialog's Save with nothing edited,
          // the tag's own name again — writes nothing and records nothing. The
          // row has no timestamp to bump, so skipping the update is invisible,
          // and a scope that wrote its model and recorded nothing would trip.
          if (!renamedTo && !recolorTo) return tag;

          // `{ ...input }` rather than `input`: `updateTagInput` is a ZodEffects, and
          // zod has already stripped anything but `name` / `colorName`.
          const u = await tx.tag
            .update({ where: { id: tag.id }, data: { ...input } })
            .catch(rethrowDuplicateTagName);
          // The report's Assessment Execution timeline config names tags by string,
          // so a rename that didn't follow it would silently empty that section.
          // Saved queries are deliberately NOT rewritten — see services/tags.ts.
          const rewritten = renamedTo
            ? await rewriteTimelineTagNames(tx, eng.id, tag.name, renamedTo)
            : 0;

          // One discrete entry for the save, through `recordAudit` and never the
          // fold: a rename comes from a dialog, and "a → b" then "b → c" must
          // stay two lines.
          const changes: AuditChange[] = [];
          if (renamedTo)
            changes.push({ kind: 'field', field: 'name', from: tag.name, to: renamedTo });
          if (recolorTo) {
            changes.push({ kind: 'field', field: 'colorName', from: tag.colorName, to: recolorTo });
          }
          if (rewritten > 0) {
            changes.push({ kind: 'count', label: 'Timeline sections rewritten', count: rewritten });
          }
          const what =
            renamedTo && recolorTo
              ? `Renamed tag ${q(tag.name)} to ${q(renamedTo)} and changed its color from ${tag.colorName} to ${recolorTo}`
              : renamedTo
                ? `Renamed tag ${q(tag.name)} to ${q(renamedTo)}`
                : `Changed the color of tag ${q(tag.name)} from ${tag.colorName} to ${recolorTo}`;
          await recordAudit(inTx(ctx, tx), {
            action: 'update',
            entityType: 'tag',
            entity: { id: String(tag.id), label: tag.name },
            summary:
              rewritten > 0 ? `${what}; ${n(rewritten, 'timeline section')} rewritten` : what,
            changes,
          });
          return u;
        }),
      );
      return serializeTag(updated);
    },
  );

  // Delete. `EvidenceTag` rows go by FK cascade and `TargetActivity.tagId` becomes
  // NULL. The report's timeline config is the one by-name reference that is
  // rewritten: the deleted name is dropped from any `tags` array that lists it,
  // so a section filtered on this tag plus others keeps the others rather than
  // silently matching nothing. Saved queries are left alone, as for rename and
  // merge; the confirmation copy names them.
  app.delete(
    '/engagements/:slug/tags/:id',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const eng = await engBySlug(slug);
      const tagId = intParam(id, 'tag');
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      // The cascades (chips) and the SetNull (activity correlations) are the
      // database's and invisible to the backstop, so they are counted inside the
      // transaction, before the row goes, and the entry is written before the
      // delete: a failed insert fails the delete, never the other way round.
      await withIntent(['tag', 'engagement'], () =>
        app.db.$transaction(async (tx) => {
          const tag = await getTag(tx, eng.id, tagId);
          const onEvidence = await tx.evidenceTag.count({ where: { tagId: tag.id } });
          const onFindings = await tx.findingTag.count({ where: { tagId: tag.id } });
          const onActivities = await tx.targetActivity.count({ where: { tagId: tag.id } });
          const rewritten = await rewriteTimelineTagNames(tx, eng.id, tag.name, null);
          const changes: AuditChange[] = [
            { kind: 'field', field: 'name', from: tag.name, to: null },
            { kind: 'field', field: 'colorName', from: tag.colorName, to: null },
            { kind: 'count', label: 'Evidence', count: onEvidence },
            { kind: 'count', label: 'Findings', count: onFindings },
          ];
          if (onActivities > 0) {
            changes.push({ kind: 'count', label: 'Activities uncorrelated', count: onActivities });
          }
          if (rewritten > 0) {
            changes.push({ kind: 'count', label: 'Timeline sections rewritten', count: rewritten });
          }
          await recordAudit(inTx(ctx, tx), {
            action: 'delete',
            entityType: 'tag',
            entity: { id: String(tag.id), label: tag.name },
            summary:
              `Deleted tag ${q(tag.name)} (on ${n(onEvidence, 'evidence', 'evidence')} and ${n(onFindings, 'finding')})` +
              (onActivities > 0
                ? `; ${n(onActivities, 'activity', 'activities')} lost its correlation`
                : '') +
              (rewritten > 0 ? `; ${n(rewritten, 'timeline section')} rewritten` : ''),
            changes,
          });
          await tx.tag.delete({ where: { id: tag.id } });
        }),
      );
      return { ok: true };
    },
  );

  // Everywhere this tag is addressed by name, so the rename/merge dialogs can warn
  // before that name changes or disappears.
  app.get(
    '/engagements/:slug/tags/:id/references',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const eng = await engBySlug(slug);
      const tag = await getTag(app.db, eng.id, intParam(id, 'tag'));
      return tagReferencesFor(app.db, eng.id, tag.name);
    },
  );

  // Merge the path tag INTO `intoTagId`, then delete it. Destructive and
  // irreversible — see `mergeTagInto` for what moves and why join rows are
  // copied rather than re-pointed.
  app.post(
    '/engagements/:slug/tags/:id/merge',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const { intoTagId } = mergeTagInput.parse(req.body);
      const eng = await engBySlug(slug);
      const sourceId = intParam(id, 'tag');
      if (sourceId === intoTagId) throw new HttpError(400, 'A tag cannot be merged into itself');

      // ONE entry on the surviving tag for the whole merge, never one per
      // copied chip: the scope names every model `mergeTagInto` writes (the two
      // join tables, the activity re-point, the timeline rewrite on the
      // engagement, and the source row's delete).
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      const moved = await withIntent(
        ['tag', 'evidenceTag', 'findingTag', 'targetActivity', 'engagement'],
        () =>
          app.db.$transaction(async (tx) => {
            // Both rows are read inside the transaction, so the names written into
            // the timeline config are the names as of this merge, not as of a read
            // that a concurrent rename could have overtaken.
            const source = await getTag(tx, eng.id, sourceId);
            const target = await getTag(tx, eng.id, intoTagId);
            const outcome = await mergeTagInto(tx, eng.id, source, target);
            await recordAudit(inTx(ctx, tx), {
              action: 'merge',
              entityType: 'tag',
              entity: { id: String(target.id), label: target.name },
              summary:
                `Merged tag ${q(source.name)} into ${q(target.name)}: ` +
                `${n(outcome.movedEvidence, 'evidence', 'evidence')} and ${n(outcome.movedFindings, 'finding')} relinked` +
                (outcome.repointedActivities > 0
                  ? `, ${n(outcome.repointedActivities, 'activity', 'activities')} re-pointed`
                  : '') +
                (outcome.rewrittenTimelineSections > 0
                  ? `, ${n(outcome.rewrittenTimelineSections, 'timeline section')} rewritten`
                  : ''),
              changes: [
                { kind: 'items', label: 'Merged from', items: [source.name] },
                { kind: 'count', label: 'Evidence moved', count: outcome.movedEvidence },
                {
                  kind: 'count',
                  label: 'Evidence already tagged',
                  count: outcome.evidenceAlreadyTagged,
                },
                { kind: 'count', label: 'Findings moved', count: outcome.movedFindings },
                {
                  kind: 'count',
                  label: 'Findings already tagged',
                  count: outcome.findingsAlreadyTagged,
                },
                {
                  kind: 'count',
                  label: 'Activities re-pointed',
                  count: outcome.repointedActivities,
                },
                {
                  kind: 'count',
                  label: 'Timeline sections rewritten',
                  count: outcome.rewrittenTimelineSections,
                },
              ],
            });
            return outcome;
          }),
      );

      const fresh = await app.db.tag.findUniqueOrThrow({
        where: { id: intoTagId },
        include: listInclude,
      });
      return { ...moved, tag: serializeListRow(fresh) };
    },
  );

  // Strip this tag from everything it is applied to, keeping the tag itself. The
  // activity correlation is deliberately untouched — see `unapplyTag`.
  app.post(
    '/engagements/:slug/tags/:id/unapply',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, id } = req.params as { slug: string; id: string };
      const eng = await engBySlug(slug);
      const tagId = intParam(id, 'tag');
      // ONE entry with the two counts. Recorded even when both are zero: the
      // two `deleteMany`s still ran, and an explicit unapply of an unused tag
      // is a deliberate action, not an autosave no-op.
      const ctx = auditCtx(req, { id: eng.id, slug, name: eng.name });
      return withIntent(['evidenceTag', 'findingTag'], () =>
        app.db.$transaction(async (tx) => {
          const tag = await getTag(tx, eng.id, tagId);
          const result = await unapplyTag(tx, tag.id);
          await recordAudit(inTx(ctx, tx), {
            action: 'unapply',
            entityType: 'tag',
            entity: { id: String(tag.id), label: tag.name },
            summary: `Removed tag ${q(tag.name)} from ${n(result.evidenceCleared, 'evidence', 'evidence')} and ${n(result.findingsCleared, 'finding')}`,
            changes: [
              { kind: 'count', label: 'Evidence', count: result.evidenceCleared },
              { kind: 'count', label: 'Findings', count: result.findingsCleared },
            ],
          });
          return result;
        }),
      );
    },
  );
}
