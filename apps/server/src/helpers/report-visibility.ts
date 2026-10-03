import type { Prisma } from '@prisma/client';

/**
 * The one definition of "this evidence may appear in report output".
 *
 * Two conditions, and the second is the easy one to forget:
 *
 * 1. The row is not itself flagged `excludeFromReport`.
 * 2. It is not linked evidence (a follow-up capture) hanging off a parent that is
 *    flagged. Exclusion is inherited downwards because a report renders linked
 *    evidence standalone — as its own supporting file, its own timeline entry, its
 *    own figure — so a child whose parent was withheld would ship as a dangling
 *    fragment of a withheld capture. Inheritance is read-time rather than a
 *    cascade on write, so it also covers linked evidence captured (or re-parented)
 *    *after* the parent was excluded.
 *
 * Every whole-engagement report sweep and every report-scoped relation count
 * filters on this; `findings-import` uses it to decide which finding links a
 * report-filtered export file is entitled to detach. It deliberately lives apart
 * from `buildEvidenceWhere` (`helpers/timeline-filter.ts`), which is shared with
 * the interactive Evidence tab where excluded evidence stays visible, badged, so
 * it can be un-excluded.
 *
 * It contains an `OR`, so when combining it with another filter that may have its
 * own top-level `OR`, nest both inside an `AND` rather than spreading it.
 */
export const REPORT_VISIBLE_EVIDENCE = {
  excludeFromReport: false,
  OR: [{ parentEvidenceId: null }, { parent: { excludeFromReport: false } }],
} satisfies Prisma.EvidenceWhereInput;
