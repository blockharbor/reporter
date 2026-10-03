import { Badge } from '@reporter/ui';
import type { Evidence } from '@reporter/shared';

/** The one wording for the report-exclusion state, shared by every surface that
 *  lists evidence so the timeline, finding cards and the pickers all agree. */
export const EXCLUDED_FROM_REPORT_LABEL = 'Excluded from reports';

/** What the flag actually does — the hint under the detail-page toggle and the
 *  tooltip on every badge. Precise about the two edges an operator would
 *  otherwise have to guess at: linked evidence under it is withheld too, and the
 *  deliberate exception is a backup export, which carries the exclusion with the
 *  evidence so an import restores it. */
export const EXCLUDED_FROM_REPORT_HINT =
  'Never include this evidence — or linked evidence under it — in any generated report or ' +
  'supporting-files archive. Only an explicit backup export can carry it, flagged, so it stays ' +
  'excluded after an import.';

/** Why a piece of evidence is excluded without carrying the flag itself: it is
 *  linked evidence under an excluded capture, and exclusion is inherited. */
export const EXCLUDED_FROM_REPORT_INHERITED_HINT =
  'Excluded from reports because the evidence it is linked to is excluded. Un-exclude that ' +
  'evidence to bring this back into reports.';

/**
 * Marks evidence that has been withheld from report output. Excluded evidence
 * stays fully visible and selectable everywhere in the app, so this badge is the
 * only cue that it will not reach the client deliverable — which is why it
 * appears on every surface that lists evidence, with identical wording.
 *
 * `inherited` marks an item that is withheld because its parent is, not because
 * it carries the flag: same consequence, different thing to do about it, so only
 * the tooltip differs. Most callers should reach for {@link EvidenceExclusionBadge}
 * rather than deciding that themselves.
 */
export function ExcludedFromReportBadge({ inherited = false }: { inherited?: boolean }) {
  return (
    <span
      title={inherited ? EXCLUDED_FROM_REPORT_INHERITED_HINT : EXCLUDED_FROM_REPORT_HINT}
      className="inline-flex"
    >
      <Badge tone="warning" className="whitespace-nowrap">
        <span aria-hidden>⊘</span> {EXCLUDED_FROM_REPORT_LABEL}
      </Badge>
    </span>
  );
}

/**
 * The badge for one piece of evidence as it appears in a list, or nothing when it
 * will reach the report. Covers both halves of report exclusion from the serialized
 * flags, which is the whole point of having it: a surface that tested
 * `excludeFromReport` alone silently showed linked evidence under an excluded
 * capture as report-bound, and that bug was easy to reintroduce once per list.
 */
export function EvidenceExclusionBadge({
  evidence,
}: {
  evidence: Pick<Evidence, 'excludeFromReport' | 'parentExcludedFromReport'>;
}) {
  if (!evidence.excludeFromReport && !evidence.parentExcludedFromReport) return null;
  return <ExcludedFromReportBadge inherited={!evidence.excludeFromReport} />;
}
