import {
  FINDING_GROUPING_LABELS,
  MAX_REPORT_CUSTOM_SECTIONS,
  MAX_REPORT_SECTION_ENTRIES,
  type ReportConfig,
  type ReportTemplateConfig,
} from '@reporter/shared';
import { customSectionKey } from './report-sections.js';

/**
 * The rules a **report template** follows when it meets an engagement: what a
 * template reveals that the engagement currently hides, what applying one does to
 * the engagement's own custom sections, and the one-line digest both the Reports tab
 * and the Admin library show.
 *
 * Pure functions, kept out of the components that render them so the merge rules —
 * the part that can destroy an author's work if it is wrong — are unit-testable.
 */

/** The two sanitize toggles — the only part of a configuration that can leak. */
export type SanitizeToggles = Pick<
  ReportTemplateConfig,
  'showEvidenceTimestamps' | 'showEvidenceOperators'
>;

/**
 * One specific sentence naming what `next` would reveal that `current` hides, or
 * null when it reveals nothing new.
 *
 * `showEvidenceTimestamps` and `showEvidenceOperators` decide whether evidence
 * capture times and operator identities appear in a client deliverable; both
 * default to off deliberately. A template carries them like any other option, so
 * applying one — or generating a single report from one — can switch them on
 * without the author having touched the Sanitize control. That is a leak risk, not
 * a formatting change, so every caller renders this as its own line rather than
 * folding it into generic confirm copy.
 *
 * The comparison is against `current` rather than against "off", so a template that
 * matches what this engagement already shows warns about nothing — there is no new
 * disclosure to warn about, and a warning that fires on every report would stop
 * being read by the time one mattered. A template that turns an option on is still
 * labelled unconditionally by the sanitize badge next to its name.
 */
export function templateSanitizeWarning(
  current: SanitizeToggles,
  next: SanitizeToggles,
): string | null {
  const timestamps = next.showEvidenceTimestamps && !current.showEvidenceTimestamps;
  const operators = next.showEvidenceOperators && !current.showEvidenceOperators;
  if (!timestamps && !operators) return null;
  const reveals =
    timestamps && operators
      ? 'evidence capture dates and times, and the operator who captured each evidence item,'
      : timestamps
        ? 'evidence capture dates and times'
        : 'the operator who captured each evidence item';
  return `This template turns ${
    timestamps && operators ? 'both sanitize options' : 'a sanitize option'
  } on: ${reveals} will appear in the report. They are off by default so a client deliverable carries neither.`;
}

/**
 * The engagement's live configuration with `config` applied.
 *
 * - The template's section selection and order win wholesale — that *is* the
 *   configuration being reproduced.
 * - Custom sections are MERGED, not replaced: the template's version wins on an id
 *   collision, and the engagement's own are kept in their existing order, because
 *   silently dropping authored prose that happened not to be in the template would
 *   be destroying work the template says nothing about.
 * - A kept custom section the template's section list never mentions would
 *   otherwise have no row in the Sections list at all — invisible, neither in the
 *   report nor reorderable — so it gets one, disabled: the template did not ask for
 *   it in the report, but the author can still find and re-enable it.
 * - `readinessNa` is carried over untouched. The template omits it by design.
 */
export function applyTemplateConfig(
  current: ReportConfig,
  config: ReportTemplateConfig,
): ReportConfig {
  const fromTemplate = new Map(config.customSections.map((s) => [s.id, s]));
  const customSections = [
    ...current.customSections.map((own) => fromTemplate.get(own.id) ?? own),
    ...config.customSections.filter((s) => !current.customSections.some((own) => own.id === s.id)),
  ];
  const referenced = new Set(config.sections.map((s) => s.key));
  const orphans = customSections
    .filter((s) => !referenced.has(customSectionKey(s.id)))
    .map((s) => ({ key: customSectionKey(s.id), enabled: false }));
  return {
    ...config,
    customSections,
    sections: [...config.sections, ...orphans],
    readinessNa: current.readinessNa,
  };
}

/**
 * Why the merged configuration can't be saved, or null when it fits.
 *
 * Merging a template's custom sections into an engagement that already has its own
 * is the realistic way to cross `reportConfigSchema`'s caps, so an apply that would
 * overflow is refused up front with an explanation instead of surfacing later as a
 * failed autosave.
 */
export function overflowReason(next: ReportConfig): string | null {
  if (next.customSections.length > MAX_REPORT_CUSTOM_SECTIONS)
    return `Applying it would leave ${next.customSections.length} custom sections, and an engagement can hold ${MAX_REPORT_CUSTOM_SECTIONS}. Delete a few of this engagement’s own custom sections first.`;
  if (next.sections.length > MAX_REPORT_SECTION_ENTRIES)
    return `Applying it would leave ${next.sections.length} section rows, and an engagement can hold ${MAX_REPORT_SECTION_ENTRIES}.`;
  return null;
}

/** One-line digest of what a configuration produces, for a template row. */
export function configSummary(config: ReportTemplateConfig): string {
  const enabled = config.sections.filter((s) => s.enabled).length;
  const parts = [
    `${enabled} of ${config.sections.length} sections`,
    `findings ${FINDING_GROUPING_LABELS[config.findingGroup].toLowerCase()}`,
  ];
  if (config.customSections.length > 0)
    parts.push(
      `${config.customSections.length} custom section${config.customSections.length === 1 ? '' : 's'}`,
    );
  if (config.includeEvidenceTimeline) parts.push('evidence log');
  if (config.includeAllFindings) parts.push('every finding');
  return parts.join(' · ');
}
