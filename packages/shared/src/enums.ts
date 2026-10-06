import { z } from 'zod';

/** The kinds of evidence reporter can store. Mirrors ASHIRT's content types. */
export const EVIDENCE_TYPES = [
  'image',
  'codeblock',
  'terminal-recording',
  'http-request-cycle',
  'event',
  'none',
] as const;
export const evidenceTypeSchema = z.enum(EVIDENCE_TYPES);
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

/** Human labels for evidence types (glossary-consistent). */
export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  image: 'Screenshot',
  codeblock: 'Code block',
  'terminal-recording': 'Terminal recording',
  'http-request-cycle': 'HTTP request',
  event: 'Event',
  none: 'Note',
};

/** A user's role within a single engagement. */
export const ENGAGEMENT_ROLES = ['admin', 'write', 'read'] as const;
export const engagementRoleSchema = z.enum(ENGAGEMENT_ROLES);
export type EngagementRole = z.infer<typeof engagementRoleSchema>;

/** Ordered from most to least privileged; used for `requireEngagementRole` checks. */
export const ROLE_RANK: Record<EngagementRole, number> = { admin: 3, write: 2, read: 1 };

/**
 * Stand-in name for a user who has been deleted. Deleting a user is a hard delete,
 * but the evidence and comments they authored survive it (the evidence is the
 * client deliverable), so `operator` / `author` go null and every surface — web,
 * and the generated report — renders this instead. One definition so the web UI
 * and the PDF never disagree about what a vanished author is called.
 */
export const DELETED_USER_LABEL = 'Deleted user';

/**
 * Why a user cannot be deleted (or demoted / disabled). The server raises these as
 * its 400 message and the Admin panel shows the same string as the disabled
 * button's tooltip, so they live here: if the two ever drifted, the UI would
 * explain the refusal differently from the request that was actually refused.
 */
export const CANNOT_DELETE_SELF = 'You cannot delete yourself';
export const LAST_ADMIN_REASON =
  'This is the last admin who can sign in — promote another user to admin first.';

export const ENGAGEMENT_STATUSES = ['active', 'complete', 'archived'] as const;
export const engagementStatusSchema = z.enum(ENGAGEMENT_STATUSES);
export type EngagementStatus = z.infer<typeof engagementStatusSchema>;

/** Authentication schemes an identity can use. */
export const AUTH_SCHEMES = ['local', 'oidc', 'recovery'] as const;
export const authSchemeSchema = z.enum(AUTH_SCHEMES);
export type AuthScheme = z.infer<typeof authSchemeSchema>;

/** Saved queries target either the evidence timeline or the findings list. */
export const SAVED_QUERY_TYPES = ['evidence', 'findings'] as const;
export const savedQueryTypeSchema = z.enum(SAVED_QUERY_TYPES);
export type SavedQueryType = z.infer<typeof savedQueryTypeSchema>;

/**
 * How the report's "Assessment Execution" evidence timeline is organized:
 * `chronological` (a flat, time-ordered log), `tag` (grouped by evidence tag),
 * or `type` (grouped by evidence content type).
 */
export const EVIDENCE_GROUPINGS = ['chronological', 'tag', 'type'] as const;
export const evidenceGroupingSchema = z.enum(EVIDENCE_GROUPINGS);
export type EvidenceGrouping = z.infer<typeof evidenceGroupingSchema>;

/** Human labels for the report evidence groupings. */
export const EVIDENCE_GROUPING_LABELS: Record<EvidenceGrouping, string> = {
  chronological: 'Chronological',
  tag: 'By tag',
  type: 'By type',
};

/**
 * How findings are organized in the report's Assessment Findings summary and
 * Detailed Findings sections: `severity` (the default — most-severe first, a
 * flat list), `category` (grouped under weakness-category headings), or
 * `target` (grouped by each finding's affected target). Strengths always follow
 * their author order; grouping applies to the severity-ranked weaknesses.
 */
export const FINDING_GROUPINGS = ['severity', 'category', 'target'] as const;
export const findingGroupingSchema = z.enum(FINDING_GROUPINGS);
export type FindingGrouping = z.infer<typeof findingGroupingSchema>;

/** Human labels for the report finding groupings. */
export const FINDING_GROUPING_LABELS: Record<FindingGrouping, string> = {
  severity: 'By severity',
  category: 'By category',
  target: 'By affected target',
};

/**
 * An Assessment Execution subsection is either a hand-authored `narrative` block
 * (title + prose + embedded evidence — the legacy shape) or an auto-generated
 * `timeline` of captured evidence filtered by tag/type, grouped, with comment and
 * starred toggles. Rows saved before this existed lack the discriminator and
 * default to `narrative`.
 */
export const EXECUTION_SUBSECTION_KINDS = ['narrative', 'timeline'] as const;
export const executionSubsectionKindSchema = z.enum(EXECUTION_SUBSECTION_KINDS);
export type ExecutionSubsectionKind = z.infer<typeof executionSubsectionKindSchema>;
export const EXECUTION_SUBSECTION_KIND_LABELS: Record<ExecutionSubsectionKind, string> = {
  narrative: 'Written narrative',
  timeline: 'Activity timeline',
};
export const EXECUTION_SUBSECTION_KIND_HINTS: Record<ExecutionSubsectionKind, string> = {
  narrative: 'A titled block of prose with evidence you embed by hand.',
  timeline: 'The timeline of captured evidence, filtered by tag or type and grouped.',
};

/**
 * Max length of the per-engagement watermark text. Kept short so the single
 * diagonal, rotated word always fits the printable page — the renderer scales the
 * font size down as the text lengthens, and this cap bounds how small it can get.
 */
export const WATERMARK_MAX_CHARS = 32;

/** Report watermark transparency — three fixed levels mapped to opacities by the renderer. */
export const WATERMARK_OPACITIES = ['light', 'medium', 'strong'] as const;
export const watermarkOpacitySchema = z.enum(WATERMARK_OPACITIES);
export type WatermarkOpacity = z.infer<typeof watermarkOpacitySchema>;
export const WATERMARK_OPACITY_LABELS: Record<WatermarkOpacity, string> = {
  light: 'Light',
  medium: 'Medium',
  strong: 'Strong',
};

/** Whether the watermark sits under (behind) or above (front of) the page content. */
export const WATERMARK_LAYERS = ['behind', 'front'] as const;
export const watermarkLayerSchema = z.enum(WATERMARK_LAYERS);
export type WatermarkLayer = z.infer<typeof watermarkLayerSchema>;
export const WATERMARK_LAYER_LABELS: Record<WatermarkLayer, string> = {
  behind: 'Under content',
  front: 'Above content',
};

/**
 * Qualitative finding severity, matching the CVSS v3.1 severity rating scale.
 * Stored as the canonical, sortable severity of a finding; when a full CVSS
 * vector is present it is derived from the base score (see `severityFromScore`).
 */
export const SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

/** Human labels for severities (glossary-consistent, Title Case). */
export const SEVERITY_LABELS: Record<Severity, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/** Ordered from most to least severe; used to sort findings by risk. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

/**
 * Map a CVSS v3.1 base score (0.0–10.0) to its qualitative severity rating,
 * using the official v3.1 severity bands.
 */
export function severityFromScore(score: number): Severity {
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'high';
  if (score >= 4.0) return 'medium';
  if (score >= 0.1) return 'low';
  return 'none';
}

/** Estimated effort to remediate a finding, shown per-weakness in the report. */
export const FIX_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
export const fixEffortSchema = z.enum(FIX_EFFORTS);
export type FixEffort = z.infer<typeof fixEffortSchema>;
export const FIX_EFFORT_LABELS: Record<FixEffort, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/**
 * Whether a finding records a security *weakness* (the default) or a *strength*.
 * Weaknesses carry severity/CVSS and appear in the report's weaknesses tables and
 * detailed cards; strengths are listed in a separate strengths summary table.
 */
export const FINDING_KINDS = ['weakness', 'strength'] as const;
export const findingKindSchema = z.enum(FINDING_KINDS);
export type FindingKind = z.infer<typeof findingKindSchema>;
export const FINDING_KIND_LABELS: Record<FindingKind, string> = {
  weakness: 'Weakness',
  strength: 'Strength',
};

/**
 * Lifecycle state of a single engagement goal (an area of interest under a
 * testing activity). Progress rolls up from these across the engagement.
 * `not_applicable` goals are excluded from the completion denominator.
 */
export const GOAL_STATUSES = ['not_started', 'in_progress', 'complete', 'not_applicable'] as const;
export const goalStatusSchema = z.enum(GOAL_STATUSES);
export type GoalStatus = z.infer<typeof goalStatusSchema>;
export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  complete: 'Complete',
  not_applicable: 'N/A',
};
/** Display order for the goal-status control (workflow order, not alphabetical). */
export const GOAL_STATUS_ORDER: Record<GoalStatus, number> = {
  not_started: 0,
  in_progress: 1,
  complete: 2,
  not_applicable: 3,
};

/**
 * The content sections of the exported report, in their canonical order. The
 * cover, engagement-details, and table-of-contents pages are structural and are
 * always emitted first; these are the sections a report configuration can
 * reorder and toggle. `scopeCoverage` (Scope & Objectives Coverage, driven by the
 * goals tree) is the one new section — off by default so the default report is
 * unchanged.
 */
export const REPORT_SECTIONS = [
  'executiveSummary',
  'assessmentFindings',
  'methodology',
  'threatModel',
  'assessmentExecution',
  'scopeCoverage',
  'detailedFindings',
  'supportingInformation',
  'appendix',
] as const;
export const reportSectionSchema = z.enum(REPORT_SECTIONS);
export type ReportSection = z.infer<typeof reportSectionSchema>;
export const REPORT_SECTION_LABELS: Record<ReportSection, string> = {
  executiveSummary: 'Executive Summary',
  assessmentFindings: 'Assessment Findings',
  methodology: 'Methodology & Approach',
  threatModel: 'Threat Model',
  assessmentExecution: 'Assessment Execution',
  scopeCoverage: 'Scope & Objectives Coverage',
  detailedFindings: 'Detailed Findings',
  supportingInformation: 'Supporting Information',
  appendix: 'Appendix: Severity & CVSS Reference',
};
/** Short hint shown under each toggle in the Reports configurator. */
export const REPORT_SECTION_HINTS: Record<ReportSection, string> = {
  executiveSummary: 'Summary prose, scope, severity distribution and key stats.',
  assessmentFindings:
    'Strengths/weaknesses summary tables, recommendations, standards traceability.',
  methodology: 'The methodology narrative (or a sensible default).',
  threatModel: 'Threat-model narrative and diagrams (only renders when present).',
  assessmentExecution: 'Hand-authored execution narrative and optional evidence log.',
  scopeCoverage: 'Per-target coverage of activities and goals, with status and linked artifacts.',
  detailedFindings: 'Full per-weakness detail cards (attack path, evidence, remediation).',
  supportingInformation: 'Software tested, test tools used, and files attached.',
  appendix: 'Severity & CVSS reference table.',
};

/**
 * Caps on the two lists a report configuration carries (`reportConfigSchema`).
 * Exported rather than inlined in the zod `.max()` calls because the web app needs
 * the same numbers to disable "Add section" at the ceiling and to refuse a report
 * template whose custom sections would overflow the engagement's own — a cap the
 * UI guessed at would either block early or let a save 400.
 *
 * The section-entry cap is the looser of the two: a configuration holds one entry
 * per built-in section plus one per custom section, and may keep a disabled row for
 * a custom section the author is not currently rendering.
 */
export const MAX_REPORT_CUSTOM_SECTIONS = 30;
export const MAX_REPORT_SECTION_ENTRIES = 50;

/** One independently-toggleable piece of a report section, shown when the section
 *  is expanded in the Reports configurator. */
export interface ReportSectionItem {
  /** Stable id stored in the section entry's `options` map (absent/true = shown). */
  key: string;
  /** Label shown next to the sub-item's include/exclude checkbox. */
  label: string;
  /** One-line sample of what this piece renders, shown under the label. */
  sample: string;
}

/**
 * The independently-toggleable pieces of each built-in section, in render order.
 * Expanding a section row lists these with a sample and an include checkbox; a
 * piece renders unless its section entry's `options[key]` is explicitly `false`.
 * Sections absent here have a single, non-decomposable body (only the whole
 * section toggles) — expanding them shows just the section sample.
 */
export const REPORT_SECTION_ITEMS: Partial<Record<ReportSection, ReportSectionItem[]>> = {
  executiveSummary: [
    { key: 'summary', label: 'Summary prose', sample: 'Your written executive-summary narrative.' },
    {
      key: 'scope',
      label: 'Scope',
      sample: 'Service-scope targets and exclusions (or the scope prose).',
    },
    {
      key: 'severity',
      label: 'Severity distribution',
      sample: 'The severity bar and per-severity count cards.',
    },
    {
      key: 'stats',
      label: 'Key stats',
      sample: 'Weaknesses, highest/average CVSS, evidence count, and window.',
    },
  ],
  assessmentFindings: [
    {
      key: 'strengths',
      label: 'Strengths table',
      sample: 'Summary table of security strengths (S1, S2, …).',
    },
    {
      key: 'weaknesses',
      label: 'Weaknesses table',
      sample: 'Summary table of weaknesses with severity and fix effort.',
    },
    {
      key: 'recommendations',
      label: 'Strategic recommendations',
      sample: 'Numbered high-level recommendations (R1, R2, …).',
    },
    {
      key: 'categories',
      label: 'Category breakdown',
      sample: 'Weakness counts grouped by category.',
    },
    {
      key: 'standards',
      label: 'Standards traceability',
      sample: 'Findings mapped to ISO/SAE 21434 and UN R155.',
    },
  ],
  threatModel: [
    { key: 'narrative', label: 'Narrative', sample: 'The threat-model narrative prose.' },
    { key: 'diagrams', label: 'Diagrams', sample: 'Embedded threat-model diagram figures.' },
  ],
  detailedFindings: [
    { key: 'impact', label: 'Impact', sample: 'The impact statement on each weakness.' },
    {
      key: 'standards',
      label: 'Standards mapping',
      sample: 'Per-finding ISO/SAE 21434 and UN R155 references.',
    },
    { key: 'remediation', label: 'Remediation', sample: 'Remediation guidance on each weakness.' },
    {
      key: 'recommendations',
      label: 'Related recommendations',
      sample: 'Strategic recommendations linked to each finding (R1, R3, …).',
    },
    {
      key: 'attackPath',
      label: 'Attack path',
      sample: 'The ordered, captioned attack-path steps.',
    },
    {
      key: 'attachedEvidence',
      label: 'Attached evidence',
      sample: 'Non-path evidence attached to each finding.',
    },
  ],
  supportingInformation: [
    {
      key: 'softwareTested',
      label: 'Client software tested',
      sample: 'Table of in-scope client software and versions.',
    },
    {
      key: 'thirdParty',
      label: 'Test tools used',
      sample: 'Table of test tools used — 3rd-party software, hardware, etc. — with versions.',
    },
    {
      key: 'filesAttached',
      label: 'Files attached',
      sample: 'Supporting files with SHA-256 hashes.',
    },
  ],
};

/** A one-line preview of a whole section, shown when it's expanded in the configurator. */
export const REPORT_SECTION_SAMPLE: Record<ReportSection, string> = {
  executiveSummary:
    'A high-level overview: summary prose, scope, the severity distribution, and key stats.',
  assessmentFindings:
    'Summary tables of strengths and weaknesses, recommendations, category breakdown, and standards traceability.',
  methodology:
    'The methodology narrative you wrote, or a sensible default paragraph when left blank.',
  threatModel: 'The threat-model narrative and any embedded diagrams. Renders only when present.',
  assessmentExecution:
    'Your hand-authored execution subsections — written narratives and activity timelines.',
  scopeCoverage: 'Per-target coverage of activities and goals, with status and linked artifacts.',
  detailedFindings:
    'A full detail card per weakness: description, impact, standards, remediation, attack path, and evidence.',
  supportingInformation: 'Client software tested, test tools used, and files attached.',
  appendix: 'A CVSS v3.1 severity reference table (critical through informational).',
};

/**
 * A named report "type" the Reports section offers as a one-click download.
 * `custom` renders the engagement's saved section configuration; the others are
 * canned section sets. The chosen preset also names the exported file
 * (`<slug>-<fileLabel>-<timestamp>.<ext>`) so different report types — and
 * repeated exports on the same day — never collide.
 */
export const REPORT_PRESETS = ['full', 'executive', 'findings', 'custom'] as const;
export const reportPresetSchema = z.enum(REPORT_PRESETS);
export type ReportPreset = z.infer<typeof reportPresetSchema>;
export const REPORT_PRESET_LABELS: Record<ReportPreset, string> = {
  full: 'Full report',
  executive: 'Executive summary',
  findings: 'Findings only',
  custom: 'Your configured sections',
};
export const REPORT_PRESET_HINTS: Record<ReportPreset, string> = {
  full: 'Every default section, in the standard order.',
  executive: 'Cover, engagement details, and the executive summary only.',
  findings: 'The findings summary tables plus the full detailed findings.',
  custom: 'The sections you’ve enabled and reordered below.',
};
/** Filesystem-safe filename fragment for each report type. */
export const REPORT_PRESET_FILE_LABELS: Record<ReportPreset, string> = {
  full: 'full-report',
  executive: 'executive-summary',
  findings: 'findings',
  custom: 'custom-report',
};

/**
 * The formats a report document is generated in. These are the exports the
 * Reports tab records as "a report was generated" (and that an attestation
 * letter can attest to). Each generation stores its bytes so the exact
 * deliverable can be re-downloaded later; the JSON export is recorded too so a
 * client-facing data bundle produced alongside the report stays available.
 */
export const GENERATED_REPORT_FORMATS = ['pdf', 'zip', 'json'] as const;
export const generatedReportFormatSchema = z.enum(GENERATED_REPORT_FORMATS);
export type GeneratedReportFormat = z.infer<typeof generatedReportFormatSchema>;

/**
 * Compliance frameworks an attestation letter can be issued in support of. The
 * letter's "Use of this letter" section tailors its wording to the chosen
 * framework; `custom` pairs with a free-text label supplied at download time so
 * a framework not listed here (HITRUST, FedRAMP, a bespoke program, …) can still
 * be named. Selecting a framework never certifies compliance — the letter is a
 * vendor attestation of testing activity (see the server-side letter copy).
 */
export const ATTESTATION_FRAMEWORKS = [
  'soc2',
  'hipaa',
  'pci_dss',
  'iso_27001',
  'nist_csf',
  'gdpr',
  'custom',
] as const;
export const attestationFrameworkSchema = z.enum(ATTESTATION_FRAMEWORKS);
export type AttestationFramework = z.infer<typeof attestationFrameworkSchema>;

/** Human labels for the attestation frameworks (shown in the letter picker). */
export const ATTESTATION_FRAMEWORK_LABELS: Record<AttestationFramework, string> = {
  soc2: 'SOC 2',
  hipaa: 'HIPAA',
  pci_dss: 'PCI DSS',
  iso_27001: 'ISO 27001',
  nist_csf: 'NIST CSF',
  gdpr: 'GDPR',
  custom: 'Other / Custom',
};
