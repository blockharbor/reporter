/**
 * Report readiness: the checklist of content a report must have before it's
 * considered "ready to generate". Shared by the Content tab's progress checklist
 * (computed from live form state) and the Generate tab's gate (computed from the
 * saved engagement), so both agree on what "ready" means.
 *
 * This is intentionally UI-only: readiness never blocks the API, it only warns —
 * see the Generate tab's confirm-before-generate flow.
 */

import type { Finding } from '@reporter/shared';

const nonEmpty = (s: string | null | undefined): boolean => Boolean(s && s.trim());

/** The normalized values every readiness item is evaluated against. */
export interface ReadinessInput {
  clientName: string;
  assessmentType: string;
  location: string;
  scope: string;
  executiveSummary: string;
  methodology: string;
  watermarkEnabled: boolean;
  scopeTargets: { name: string }[];
  recommendations: { title: string; findingUuids?: string[] }[];
  threatModelNarrative: string;
  threatModelDiagrams: { imageDataUri: string }[];
  executionNarrative: { title: string }[];
  providerContacts: { name: string }[];
  clientContacts: { name: string }[];
  thirdPartySoftware: { name: string }[];
  /** How many findings are currently marked "Ready to report". */
  readyFindingCount: number;
}

/** Static metadata for one readiness item (order = display order). */
interface ReadinessItemDef {
  key: string;
  label: string;
  /**
   * DOM id in the Content tab to scroll to when the row is activated. Omitted for
   * items that live outside the Content form (e.g. the ready-finding gate, which
   * points at the Findings tab instead).
   */
  anchor?: string;
  /** Whether the item's underlying content is present. */
  complete: (i: ReadinessInput) => boolean;
}

/** Every readiness item, in the order the user listed them. */
export const READINESS_ITEMS: ReadinessItemDef[] = [
  { key: 'clientName', label: 'Client / organization name', anchor: 'r-client', complete: (i) => nonEmpty(i.clientName) },
  { key: 'assessmentType', label: 'Assessment type', anchor: 'r-type', complete: (i) => nonEmpty(i.assessmentType) },
  { key: 'location', label: 'Location / environment', anchor: 'r-location', complete: (i) => nonEmpty(i.location) },
  { key: 'scope', label: 'Additional scope notes', anchor: 'sec-service-scope', complete: (i) => nonEmpty(i.scope) },
  { key: 'executiveSummary', label: 'Executive summary', anchor: 'r-exec', complete: (i) => nonEmpty(i.executiveSummary) },
  { key: 'methodology', label: 'Methodology', anchor: 'r-method', complete: (i) => nonEmpty(i.methodology) },
  { key: 'watermark', label: 'Watermark', anchor: 'wm-text', complete: (i) => i.watermarkEnabled },
  {
    key: 'serviceScope',
    label: 'Service scope',
    anchor: 'sec-service-scope',
    complete: (i) => i.scopeTargets.some((t) => nonEmpty(t.name)),
  },
  {
    key: 'recommendations',
    label: 'Strategic recommendations',
    anchor: 'sec-recommendations',
    // ≥1 recommendation, and every (title-bearing) recommendation is linked to a finding.
    complete: (i) => {
      const valid = i.recommendations.filter((r) => nonEmpty(r.title));
      return valid.length > 0 && valid.every((r) => (r.findingUuids?.length ?? 0) > 0);
    },
  },
  {
    key: 'threatModel',
    label: 'Threat model',
    anchor: 'sec-threat-model',
    complete: (i) =>
      nonEmpty(i.threatModelNarrative) ||
      i.threatModelDiagrams.some((d) => d.imageDataUri.startsWith('data:image/')),
  },
  {
    key: 'assessmentExecution',
    label: 'Assessment execution',
    anchor: 'sec-assessment-execution',
    complete: (i) => i.executionNarrative.some((s) => nonEmpty(s.title)),
  },
  {
    key: 'providerContacts',
    label: 'Provider contacts',
    anchor: 'sec-provider-contacts',
    complete: (i) => i.providerContacts.some((c) => nonEmpty(c.name)),
  },
  {
    key: 'clientContacts',
    label: 'Client contacts',
    anchor: 'sec-client-contacts',
    complete: (i) => i.clientContacts.some((c) => nonEmpty(c.name)),
  },
  {
    key: 'testTools',
    label: 'Test tools used',
    anchor: 'sec-test-tools',
    complete: (i) => i.thirdPartySoftware.some((s) => nonEmpty(s.name)),
  },
  {
    key: 'readyFinding',
    label: 'At least one finding marked “Ready to report”',
    // Lives on the Findings tab, not the Content form.
    complete: (i) => i.readyFindingCount > 0,
  },
];

/** One evaluated readiness item. */
export interface ReadinessItem {
  key: string;
  label: string;
  anchor?: string;
  /** The content is present. */
  complete: boolean;
  /** The author explicitly marked this item "Not applicable". */
  na: boolean;
  /** complete || na — counts toward "ready". */
  satisfied: boolean;
}

export interface ReadinessResult {
  items: ReadinessItem[];
  /** Number of satisfied (complete or N/A) items. */
  satisfiedCount: number;
  total: number;
  /** Every item is satisfied. */
  ready: boolean;
  /** Satisfied ÷ total, 0–100 (integer). */
  percent: number;
}

/** Evaluate readiness for the given content + the set of item keys marked N/A. */
export function computeReadiness(input: ReadinessInput, naKeys: readonly string[]): ReadinessResult {
  const na = new Set(naKeys);
  const items: ReadinessItem[] = READINESS_ITEMS.map((def) => {
    const complete = def.complete(input);
    const isNa = na.has(def.key);
    return {
      key: def.key,
      label: def.label,
      anchor: def.anchor,
      complete,
      na: isNa,
      // An item that is genuinely complete shouldn't also read as "N/A".
      satisfied: complete || isNa,
    };
  });
  const satisfiedCount = items.filter((i) => i.satisfied).length;
  const total = items.length;
  return {
    items,
    satisfiedCount,
    total,
    ready: satisfiedCount === total,
    percent: total === 0 ? 100 : Math.round((satisfiedCount / total) * 100),
  };
}

// ---------------------------------------------------------------------------
// Finding warnings — advisory, deliberately NOT readiness items
// ---------------------------------------------------------------------------

/**
 * The ways a finding the author has already marked "Ready to report" still renders
 * worse than they expect. These are advisory and sit *outside* {@link READINESS_ITEMS}
 * on purpose: every readiness item is a hard gate (`ready` is "all satisfied") and
 * can be waived into `reportConfig.readinessNa`, so folding warnings in would move
 * the progress bar for content nobody asked for and mint N/A keys for findings that
 * may be gone tomorrow. Generation is never blocked by either.
 *
 * All four are scoped to **weaknesses**. The detailed finding block — the only place
 * a severity pill, a Remediation section or an evidence section is rendered — runs
 * over weaknesses only; a strength appears as one row of the Summary of Strengths
 * table (title + description). So warning about a strength's missing severity or
 * remediation would be pure noise, the more so because the server *clears* both on
 * any finding switched to `strength`.
 *
 * A partially-withheld finding (some evidence excluded, some still shown) is not a
 * warning either: the report renders the remaining evidence and the author already
 * sees the exclusion badges on the finding page. Only an actually degraded render
 * earns a row here.
 */
export const FINDING_WARNING_KINDS = [
  'evidenceAllWithheld',
  'noEvidence',
  'noSeverity',
  'noRemediation',
] as const;
export type FindingWarningKind = (typeof FINDING_WARNING_KINDS)[number];

/** Just enough of a finding to label and deep-link one row of the panel. */
export interface WarnedFinding {
  uuid: string;
  title: string;
}

/** Static metadata for one warning (order = display order). */
interface FindingWarningDef {
  kind: FindingWarningKind;
  /** What is missing. */
  label: string;
  /** What the report does about it — the reason this is worth a row. */
  consequence: string;
  applies: (f: FindingWarningSubject) => boolean;
}

/**
 * Exactly the fields a warning reads, so a test fixture (and a future caller with
 * something less than a full finding) doesn't have to supply the rest. A `Finding`
 * satisfies it as-is.
 */
export type FindingWarningSubject = Pick<
  Finding,
  | 'uuid'
  | 'title'
  | 'kind'
  | 'readyToReport'
  | 'severity'
  | 'remediation'
  | 'numEvidence'
  | 'numEvidenceInReport'
>;

const FINDING_WARNINGS: FindingWarningDef[] = [
  {
    kind: 'evidenceAllWithheld',
    label: 'All linked evidence is withheld from reports',
    // The report deliberately prints nothing here rather than "No evidence
    // attached." — true, but it would read as a false statement about the finding —
    // so without this warning the gap is invisible until someone reads the PDF.
    consequence:
      'Every evidence item linked to this finding is excluded from reports, directly or because the capture it hangs off is. The report renders the finding with no evidence section and no explanation.',
    applies: (f) => f.numEvidence > 0 && f.numEvidenceInReport === 0,
  },
  {
    kind: 'noEvidence',
    label: 'No linked evidence',
    consequence: 'The report prints a bare “No evidence attached.” under the finding.',
    applies: (f) => f.numEvidence === 0,
  },
  {
    kind: 'noSeverity',
    label: 'No severity rating',
    consequence:
      'The finding is headed by an “Unrated” pill and folds into the informational band of every severity tally.',
    applies: (f) => f.severity === null,
  },
  {
    kind: 'noRemediation',
    label: 'No remediation guidance',
    consequence: 'The report omits the Remediation section, leaving nothing in its place.',
    applies: (f) => f.remediation.trim() === '',
  },
];

/** One warning, with every finding that raises it. Never empty. */
export interface FindingWarningGroup {
  kind: FindingWarningKind;
  label: string;
  consequence: string;
  findings: WarnedFinding[];
}

export interface FindingWarningsResult {
  /** Only the warnings that fired, in {@link FINDING_WARNING_KINDS} order. */
  groups: FindingWarningGroup[];
  /** Total (finding, warning) pairs — one finding can raise several. */
  total: number;
  /** How many distinct findings raise at least one warning. */
  findingCount: number;
}

/**
 * Evaluate {@link FINDING_WARNINGS} over an engagement's findings. Takes the whole
 * list and does its own scoping (ready-to-report weaknesses) so no caller has to
 * remember which findings the report actually renders in full.
 */
export function computeFindingWarnings(
  findings: readonly FindingWarningSubject[],
): FindingWarningsResult {
  const subjects = findings.filter((f) => f.readyToReport && f.kind === 'weakness');
  const groups: FindingWarningGroup[] = [];
  const warned = new Set<string>();
  let total = 0;
  for (const def of FINDING_WARNINGS) {
    const hits = subjects.filter((f) => def.applies(f));
    if (hits.length === 0) continue;
    groups.push({
      kind: def.kind,
      label: def.label,
      consequence: def.consequence,
      findings: hits.map((f) => ({ uuid: f.uuid, title: f.title })),
    });
    total += hits.length;
    for (const f of hits) warned.add(f.uuid);
  }
  return { groups, total, findingCount: warned.size };
}
