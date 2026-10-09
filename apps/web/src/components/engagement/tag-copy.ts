import type { MergeTagResult, Tag, UnapplyTagResult } from '@reporter/shared';

/**
 * Every blast-radius sentence the tag manager and the merge dialog show, as pure
 * functions, so pluralisation and the evidence/findings split are unit-tested
 * without a DOM. The house pattern — `goalCountTitle` lives beside its badge in
 * `components/evidence/GoalCountBadge.tsx` for exactly this reason.
 *
 * Counts are read with `?? 0` throughout: `findingCount` is absent from the wire
 * until findings can carry tags, and the sentence has to stay truthful rather
 * than printing "undefined findings".
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The non-zero halves of an evidence/findings split, in order, so "3 pieces of
 * evidence and 1 finding" never degrades to "3 pieces of evidence and 0 findings"
 * before the finding-tags slice lands.
 */
function countParts(evidenceCount: number, findingCount: number): string[] {
  const parts: string[] = [];
  if (evidenceCount > 0) {
    parts.push(plural(evidenceCount, 'piece of evidence', 'pieces of evidence'));
  }
  if (findingCount > 0) parts.push(plural(findingCount, 'finding', 'findings'));
  return parts;
}

/** Split usage, e.g. "on 3 pieces of evidence and 1 finding". Absent counts read as zero. */
export function tagUsageSentence(tag: Pick<Tag, 'evidenceCount' | 'findingCount'>): string {
  const ev = tag.evidenceCount ?? 0;
  const fi = tag.findingCount ?? 0;
  if (ev === 0 && fi === 0) return 'not applied to anything yet';
  return `on ${countParts(ev, fi).join(' and ')}`;
}

/**
 * The row-sized form of the split for the Settings list, where the figure has to
 * share one line with a chip and five buttons inside a half-width card:
 * "unused", "2 evidence", "2 evidence · 1 finding". The row carries the full
 * {@link tagUsageSentence} as its tooltip, and every confirmation still uses the
 * full sentence.
 */
export function tagUsageShort(tag: Pick<Tag, 'evidenceCount' | 'findingCount'>): string {
  const ev = tag.evidenceCount ?? 0;
  const fi = tag.findingCount ?? 0;
  if (ev === 0 && fi === 0) return 'unused';
  const parts: string[] = [];
  if (ev > 0) parts.push(`${ev} evidence`);
  if (fi > 0) parts.push(plural(fi, 'finding', 'findings'));
  return parts.join(' · ');
}

/** True when the tag is on nothing — the branch every confirmation words differently. */
function isUnused(tag: Pick<Tag, 'evidenceCount' | 'findingCount'>): boolean {
  return (tag.evidenceCount ?? 0) === 0 && (tag.findingCount ?? 0) === 0;
}

/** The delete confirmation. States what the tag is on, because the join rows go with it. */
export function deleteTagMessage(tag: Tag): string {
  if (isUnused(tag)) return `Delete the tag “${tag.name}”? It isn’t applied to anything yet.`;
  const total = (tag.evidenceCount ?? 0) + (tag.findingCount ?? 0);
  const from = total === 1 ? 'that item' : 'all of them';
  return `The tag “${tag.name}” is ${tagUsageSentence(tag)}. Deleting it removes it from ${from}. This cannot be undone.`;
}

/**
 * The extra sentence the delete confirmation adds when the tag is also addressed
 * by NAME somewhere: saved queries keep their text and stop matching; the report's
 * timeline sections have the name dropped from their filter. Null when nothing
 * names it, so the plain confirmation is unchanged.
 */
export function deleteTagReferencesNote(refs: {
  savedQueries: { name: string }[];
  timelineSections: { title: string }[];
}): string | null {
  const quoted = (names: string[]) => names.map((n) => `“${n}”`).join(', ');
  const parts: string[] = [];
  if (refs.savedQueries.length > 0) {
    const noun = refs.savedQueries.length === 1 ? 'query' : 'queries';
    const names = quoted(refs.savedQueries.map((q) => q.name));
    parts.push(`the saved ${noun} ${names} will stop matching (saved queries are not rewritten)`);
  }
  if (refs.timelineSections.length > 0) {
    const one = refs.timelineSections.length === 1;
    const names = quoted(refs.timelineSections.map((s) => s.title));
    parts.push(
      `the report timeline ${one ? 'section' : 'sections'} ${names} will drop it from ${one ? 'its' : 'their'} filter`,
    );
  }
  if (parts.length === 0) return null;
  return `It is also referred to by name: ${parts.join('; ')}.`;
}

/** The bulk-unapply confirmation. The tag survives; only its applications go. */
export function unapplyTagMessage(tag: Tag): string {
  if (isUnused(tag)) {
    return `“${tag.name}” isn’t applied to anything yet, so there is nothing to remove.`;
  }
  return `Remove “${tag.name}” from everything it is applied to? It is ${tagUsageSentence(tag)}. The tag itself stays, so you can apply it again. This cannot be undone.`;
}

/**
 * The merge confirmation: names both tags and sums the counts. "Up to", because
 * an item carrying both tags ends up with one chip rather than two, so the real
 * figure can be lower — which is also why the sentence says so explicitly. Zero
 * halves are dropped like everywhere else: "and 0 findings" would read as a
 * warning about findings on every merge until findings can carry tags at all.
 */
export function mergeTagMessage(source: Tag, target: Tag): string {
  const ev = (source.evidenceCount ?? 0) + (target.evidenceCount ?? 0);
  const fi = (source.findingCount ?? 0) + (target.findingCount ?? 0);
  const lead = `Everything tagged “${source.name}” will be tagged “${target.name}” instead.`;
  const parts = countParts(ev, fi);
  if (parts.length === 0) return `${lead} Neither tag is applied to anything yet.`;
  return `${lead} Afterwards “${target.name}” is on up to ${parts.join(' and ')} — items already carrying both keep a single chip.`;
}

/**
 * Why a renamed tag can reappear under its old name. Quoted in the row editor and
 * the merge dialog. The correlation follows the tag ROW (`TargetActivity.tagId`),
 * so renaming here is safe; renaming the activity is what mints a fresh tag
 * (`ensureActivityTag` on the server).
 */
export function activityTagHint(activityNames: string[]): string | null {
  if (activityNames.length === 0) return null;
  const list = activityNames.map((n) => `“${n}”`).join(', ');
  return `Used as the correlation tag for ${activityNames.length === 1 ? 'the activity' : 'the activities'} ${list}. Renaming it here keeps that link — but renaming the activity itself on the Goals tab will create a new tag under the activity's new name rather than following this one.`;
}

/** The success toast after a bulk unapply, quoting what the server actually stripped. */
export function unapplyTagToast(tagName: string, result: UnapplyTagResult): string {
  const parts = countParts(result.evidenceCleared, result.findingsCleared);
  if (parts.length === 0) return `“${tagName}” wasn’t applied to anything.`;
  return `Removed “${tagName}” from ${parts.join(' and ')}.`;
}

/**
 * The success toast after a merge, quoting what the server actually moved. Zero
 * clauses are dropped so the common case stays one short line; the "already
 * carried both" clause explains why the retagged figure can be below the "up to"
 * number the confirmation quoted.
 */
export function mergeTagToast(sourceName: string, targetName: string, r: MergeTagResult): string {
  const moved = countParts(r.movedEvidence, r.movedFindings);
  const already = r.evidenceAlreadyTagged + r.findingsAlreadyTagged;
  const clauses: string[] = [
    moved.length > 0 ? `${moved.join(' and ')} retagged` : 'nothing to retag',
  ];
  if (already > 0) clauses.push(`${plural(already, 'item', 'items')} already carried both`);
  if (r.repointedActivities > 0) {
    clauses.push(`${plural(r.repointedActivities, 'activity', 'activities')} re-pointed`);
  }
  if (r.rewrittenTimelineSections > 0) {
    clauses.push(
      `${plural(r.rewrittenTimelineSections, 'report timeline section', 'report timeline sections')} updated`,
    );
  }
  return `Merged “${sourceName}” into “${targetName}” — ${clauses.join(', ')}.`;
}
