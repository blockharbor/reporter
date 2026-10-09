import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { createTagInput, mergeTagInput, reorderIdsInput, updateTagInput } from '@reporter/shared';
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

/**
 * Tag management for the web UI. Roles: `read` for the two GETs, `write` for
 * every mutation — engagement writers can manage tags today, and only Details,
 * Members and the danger zone are gated on `admin`.
 *
 * The list route is the one every picker and chip row follows, which is why it
 * orders by the curated `position` rather than by name, and why it carries the
 * split usage counts and the activity hint that the delete / merge / unapply
 * confirmations quote.
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
      const tags = await app.db.tag.findMany({
        where: { engagementId: eng.id },
        select: { id: true },
      });
      const ids = new Set(tags.map((t) => t.id));
      if (
        ids.size !== orderedIds.length ||
        new Set(orderedIds).size !== orderedIds.length ||
        orderedIds.some((tid) => !ids.has(tid))
      ) {
        throw new HttpError(400, 'Order must list exactly the tags in this engagement, once each');
      }
      await app.db.$transaction(
        orderedIds.map((tid, i) =>
          app.db.tag.update({ where: { id: tid }, data: { position: i } }),
        ),
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
      const updated = await app.db.$transaction(async (tx) => {
        const tag = await getTag(tx, eng.id, tagId);
        const renamedTo = input.name !== undefined && input.name !== tag.name ? input.name : null;
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
        // `{ ...input }` rather than `input`: `updateTagInput` is a ZodEffects, and
        // zod has already stripped anything but `name` / `colorName`.
        const u = await tx.tag
          .update({ where: { id: tag.id }, data: { ...input } })
          .catch(rethrowDuplicateTagName);
        // The report's Assessment Execution timeline config names tags by string,
        // so a rename that didn't follow it would silently empty that section.
        // Saved queries are deliberately NOT rewritten — see services/tags.ts.
        if (renamedTo) await rewriteTimelineTagNames(tx, eng.id, tag.name, renamedTo);
        return u;
      });
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
      await app.db.$transaction(async (tx) => {
        const tag = await getTag(tx, eng.id, tagId);
        await rewriteTimelineTagNames(tx, eng.id, tag.name, null);
        await tx.tag.delete({ where: { id: tag.id } });
      });
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

      const moved = await app.db.$transaction(async (tx) => {
        // Both rows are read inside the transaction, so the names written into
        // the timeline config are the names as of this merge, not as of a read
        // that a concurrent rename could have overtaken.
        const source = await getTag(tx, eng.id, sourceId);
        const target = await getTag(tx, eng.id, intoTagId);
        return mergeTagInto(tx, eng.id, source, target);
      });

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
      return app.db.$transaction(async (tx) => {
        const tag = await getTag(tx, eng.id, tagId);
        return unapplyTag(tx, tag.id);
      });
    },
  );
}
