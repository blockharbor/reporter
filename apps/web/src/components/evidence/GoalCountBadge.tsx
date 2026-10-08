import type { Evidence } from '@reporter/shared';

/**
 * The badge's full wording — "Linked to 2 goals", "Linked to 1 goal". The tooltip
 * on every surface that lists evidence, defined here once so the four lists can't
 * drift into four spellings of the same sentence.
 */
export function goalCountTitle(count: number): string {
  return `Linked to ${count} goal${count === 1 ? '' : 's'}`;
}

/**
 * How many engagement goals a piece of evidence is linked to, as a compact count:
 * the row carries a glyph and a number, the tooltip carries the sentence. Only the
 * detail page loads the goals themselves (names, Target · Activity context), so a
 * count is all a list can show — and all it needs, since `numGoals` rides along on
 * the evidence row rather than costing a request per item.
 *
 * Nothing renders at zero, exactly like the linked-items badge it sits beside:
 * most evidence is linked to no goal, and a column of "0"s says nothing.
 *
 * Styled as that same muted inline badge rather than as a `Badge` pill, and with
 * no color of its own, so it inherits the meta row's `text-xs text-muted` and the
 * two stay identical in the one place they appear side by side.
 */
export function GoalCountBadge({ evidence }: { evidence: Pick<Evidence, 'numGoals'> }) {
  if (evidence.numGoals === 0) return null;
  return (
    <span className="inline-flex items-center gap-1" title={goalCountTitle(evidence.numGoals)}>
      <span aria-hidden>◎</span> {evidence.numGoals}
    </span>
  );
}
