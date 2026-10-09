/**
 * Tag management: the curated order, and the two operations that reach beyond
 * the tag row itself — rename (which has to follow the tag into the places that
 * name it) and merge (which has to move everything it is applied to).
 *
 * Tags are addressed by NAME in three places outside the `tags` table, and the
 * three are treated differently on purpose:
 *
 *  - `TargetActivity.tagId` — an id, so a rename follows it for free and a merge
 *    re-points it before the source row is deleted.
 *  - `executionNarrative[].timeline.tags` — the report's Assessment Execution
 *    timeline config, a string array. Rewritten on rename and merge, because a
 *    stale name there would silently empty a report section.
 *  - `SavedQuery.query` — a string a person wrote. Reported, never rewritten:
 *    `parseQuery` → `stringifyQuery` is not a lossless round trip (it canonicalizes
 *    term order and drops unrecognized `type:` tokens), so rewriting could quietly
 *    change what the query matches. The UI lists them and says the `tag:` term
 *    will stop matching.
 */
import { Prisma } from '@prisma/client';
import {
  parseQuery,
  type ExecutionSubsection,
  type SavedQueryType,
  type TagReferences,
} from '@reporter/shared';
import { HttpError } from '../auth/guards.js';

/**
 * The engagement's curated tag order (Settings → Tags), with `name` breaking
 * position ties — which is also the order tags had before `position` existed, so
 * an engagement nobody has reordered reads exactly as it always did.
 *
 * Declared as a mutable array and referenced (rather than inlined) because the
 * includes it is used from are `as const`, which would make an inline array a
 * readonly tuple, and Prisma's `Enumerable<T>` does not accept one.
 */
export const TAG_ORDER_BY: Prisma.TagOrderByWithRelationInput[] = [
  { position: 'asc' },
  { name: 'asc' },
];

/** Same order, applied to the evidence join rows, so an item's chips follow it. */
export const EVIDENCE_TAG_ORDER_BY: Prisma.EvidenceTagOrderByWithRelationInput[] = [
  { tag: { position: 'asc' } },
  { tag: { name: 'asc' } },
];

export const DUPLICATE_TAG_NAME = 'A tag with that name already exists';

/**
 * Translate the `@@unique([engagementId, name])` violation into the same 409 the
 * pre-check raises, closing the window between check and write — the pattern
 * `services/report-templates.ts` documents for template names.
 */
export function rethrowDuplicateTagName(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new HttpError(409, DUPLICATE_TAG_NAME);
  }
  throw err;
}

/**
 * The position a newly created tag takes: the end of the engagement's list.
 *
 * `max(position) + 1`, NOT the row count. Delete and merge remove rows without
 * compacting the survivors' positions, so once any tag has ever been removed the
 * count is smaller than the highest stored position and a count-based "next"
 * would land the new tag mid-list, tied with an existing one. Read only on
 * create; two creates racing onto the same number is harmless, because equal
 * positions fall back to the `name` tiebreak.
 */
export async function nextTagPosition(
  db: Prisma.TransactionClient,
  engagementId: number,
): Promise<number> {
  const { _max } = await db.tag.aggregate({ where: { engagementId }, _max: { position: true } });
  return (_max.position ?? -1) + 1;
}

/**
 * Rewrite every Assessment Execution *timeline* subsection so a `tags` array
 * naming `from` names `to` instead, deduping when it already named both. `to =
 * null` drops the term. Pure, so the dedup and no-op cases are unit-tested
 * without a database.
 *
 * A subsection that does not name `from` — and every `narrative` subsection — is
 * returned by identity, so the caller can tell "nothing to write" from "wrote the
 * same thing back".
 */
export function withTagRenamedInTimelines(
  subsections: ExecutionSubsection[],
  from: string,
  to: string | null,
): { next: ExecutionSubsection[]; changed: number } {
  let changed = 0;
  const next = subsections.map((s) => {
    const tags = s.timeline?.tags;
    if (s.kind !== 'timeline' || !Array.isArray(tags) || !tags.includes(from)) return s;
    const rewritten: string[] = [];
    for (const t of tags) {
      const mapped = t === from ? to : t;
      if (mapped !== null && !rewritten.includes(mapped)) rewritten.push(mapped);
    }
    changed++;
    return { ...s, timeline: { ...s.timeline!, tags: rewritten } };
  });
  return { next, changed };
}

/**
 * Persist {@link withTagRenamedInTimelines} against one engagement. Reads the
 * JSON column with a cast rather than a zod parse — the house pattern for this
 * column — precisely so an untouched subsection is written back byte-identical
 * instead of being normalized by zod defaults. Writes nothing when nothing matched.
 */
export async function rewriteTimelineTagNames(
  tx: Prisma.TransactionClient,
  engagementId: number,
  from: string,
  to: string | null,
): Promise<number> {
  const eng = await tx.engagement.findUniqueOrThrow({
    where: { id: engagementId },
    select: { executionNarrative: true },
  });
  const current = (eng.executionNarrative as unknown as ExecutionSubsection[] | null) ?? [];
  const { next, changed } = withTagRenamedInTimelines(current, from, to);
  if (changed === 0) return 0;
  await tx.engagement.update({
    where: { id: engagementId },
    data: { executionNarrative: next as unknown as Prisma.InputJsonValue },
  });
  return changed;
}

/**
 * Everywhere this tag is addressed by NAME: saved queries whose `tag:` terms
 * include it, and the timeline subsections whose config lists it. A query that
 * merely mentions the name as free text is not a reference — only a parsed `tag:`
 * term counts.
 */
export async function tagReferencesFor(
  db: Prisma.TransactionClient,
  engagementId: number,
  tagName: string,
): Promise<TagReferences> {
  const [queries, eng] = await Promise.all([
    db.savedQuery.findMany({ where: { engagementId }, orderBy: { name: 'asc' } }),
    db.engagement.findUniqueOrThrow({
      where: { id: engagementId },
      select: { executionNarrative: true },
    }),
  ]);
  const subsections = (eng.executionNarrative as unknown as ExecutionSubsection[] | null) ?? [];
  return {
    savedQueries: queries
      .filter((q) => parseQuery(q.query).tags.includes(tagName))
      .map((q) => ({ id: q.id, name: q.name, type: q.type as SavedQueryType })),
    timelineSections: subsections
      .map((s, index) => ({ s, index }))
      .filter(
        ({ s }) =>
          s.kind === 'timeline' &&
          Array.isArray(s.timeline?.tags) &&
          s.timeline.tags.includes(tagName),
      )
      .map(({ s, index }) => ({ index, title: s.title })),
  };
}

/** What {@link mergeTagInto} moved, minus the refreshed survivor the route adds. */
export interface MergeOutcome {
  movedEvidence: number;
  evidenceAlreadyTagged: number;
  movedFindings: number;
  findingsAlreadyTagged: number;
  repointedActivities: number;
  rewrittenTimelineSections: number;
}

/**
 * Merge `source` INTO `target` and delete `source`, inside the caller's
 * transaction. Destructive and irreversible: the source tag's name stops
 * existing, which is why the UI shows the combined usage and the by-name
 * references first.
 *
 * Join rows are COPIED with `skipDuplicates`, not re-pointed. An
 * `updateMany({ data: { tagId: target } })` violates `evidence_tags_pkey` for any
 * item that already carries both tags, and a P2002 there aborts the whole merge.
 *
 * Runs at the database default isolation (READ COMMITTED), so a tag applied to an
 * item between the `findMany` and the `delete` is lost rather than moved.
 * Accepted for a deliberate settings action on an engagement a small team shares;
 * a `SELECT … FOR UPDATE` on the source's join rows would close it if it ever
 * bites.
 */
export async function mergeTagInto(
  tx: Prisma.TransactionClient,
  engagementId: number,
  source: { id: number; name: string },
  target: { id: number; name: string },
): Promise<MergeOutcome> {
  const srcEvidence = await tx.evidenceTag.findMany({
    where: { tagId: source.id },
    select: { evidenceId: true },
  });
  const movedEvidence = srcEvidence.length
    ? (
        await tx.evidenceTag.createMany({
          data: srcEvidence.map((r) => ({ evidenceId: r.evidenceId, tagId: target.id })),
          skipDuplicates: true,
        })
      ).count
    : 0;

  // FINDING-TAGS: once findings carry tags, copy `findingTag` rows here exactly as
  // the evidence rows above. Until then findings cannot carry a tag, so zero is
  // the truthful answer rather than a stub.
  const srcFindingCount = 0;
  const movedFindings = 0;

  // Re-point activity correlation tags BEFORE deleting the source, so
  // `TargetActivity.tag`'s onDelete: SetNull never fires and the activity keeps a
  // correlation rather than losing one.
  const { count: repointedActivities } = await tx.targetActivity.updateMany({
    where: { tagId: source.id },
    data: { tagId: target.id },
  });

  const rewrittenTimelineSections = await rewriteTimelineTagNames(
    tx,
    engagementId,
    source.name,
    target.name,
  );

  // The source's own join rows go by FK cascade.
  await tx.tag.delete({ where: { id: source.id } });

  return {
    movedEvidence,
    evidenceAlreadyTagged: srcEvidence.length - movedEvidence,
    movedFindings,
    findingsAlreadyTagged: srcFindingCount - movedFindings,
    repointedActivities,
    rewrittenTimelineSections,
  };
}

/**
 * Strip a tag from everything it is applied to, keeping the tag itself. The
 * activity correlation (`TargetActivity.tagId`) is deliberately untouched: that is
 * a property of the activity, not an application of the tag, and clearing it
 * would quietly break the Goals timeline correlation.
 */
export async function unapplyTag(
  tx: Prisma.TransactionClient,
  tagId: number,
): Promise<{ evidenceCleared: number; findingsCleared: number }> {
  const ev = await tx.evidenceTag.deleteMany({ where: { tagId } });
  // FINDING-TAGS: `const fi = await tx.findingTag.deleteMany({ where: { tagId } })`.
  return { evidenceCleared: ev.count, findingsCleared: 0 };
}
