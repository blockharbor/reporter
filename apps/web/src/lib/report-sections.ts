import {
  REPORT_SECTION_LABELS,
  type ReportCustomSection,
  type ReportSection,
} from '@reporter/shared';

/**
 * The `custom:` encoding of a report-configuration section entry, and the label
 * lookup that reads one back.
 *
 * A `reportConfigSchema.sections` entry either names a built-in section (a
 * `ReportSection` key) or points at one of the configuration's own `customSections`
 * as `custom:<id>`. Three surfaces need to read that encoding — the Reports tab's
 * section list, the report-template card, and the Admin library's table — so the
 * prefix lives here once rather than as a literal in each of them.
 */
const CUSTOM_SECTION_PREFIX = 'custom:';

/** The section-entry key for a custom section id. */
export function customSectionKey(id: string): string {
  return `${CUSTOM_SECTION_PREFIX}${id}`;
}

/** The custom id encoded in a `custom:<id>` section key, or null for built-ins. */
export function customIdOf(key: string): string | null {
  return key.startsWith(CUSTOM_SECTION_PREFIX) ? key.slice(CUSTOM_SECTION_PREFIX.length) : null;
}

/**
 * Human label for one section entry, given the configuration's custom sections.
 *
 * Custom sections are named from the copy the configuration carries, so a saved
 * report template reads back the same words the Configure tab showed when it was
 * saved. A key this build doesn't know — a custom entry whose section is missing, or
 * a built-in from a newer server — falls back rather than inventing a title.
 */
export function sectionLabel(key: string, customSections: ReportCustomSection[]): string {
  const id = customIdOf(key);
  if (id !== null) return customSections.find((s) => s.id === id)?.title || 'Custom section';
  return REPORT_SECTION_LABELS[key as ReportSection] ?? key;
}
