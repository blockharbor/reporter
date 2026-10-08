import { z } from 'zod';

/**
 * The kinds of evidence reporter can store. Mirrors ASHIRT's content types, plus
 * `script`.
 *
 * `Evidence.contentType` is a plain TEXT column, so adding a value here needs no
 * migration — but it does need a value in every exhaustive map below, which is
 * the point of their being exhaustive.
 *
 * Order is display order: it drives the evidence-type filter's checkbox list, so
 * `script` sits next to `codeblock` — the two text-code types read as a pair.
 */
export const EVIDENCE_TYPES = [
  'image',
  'codeblock',
  'script',
  'terminal-recording',
  'http-request-cycle',
  'event',
  'none',
] as const;
export const evidenceTypeSchema = z.enum(EVIDENCE_TYPES);
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

/**
 * Human labels for evidence types (glossary-consistent, Title Case, one noun).
 *
 * `script` is "Script", not "Script file" or "Shell script": it has to read as
 * plainly distinct from "Code block" in a filter list and in a report caption,
 * and the distinction users care about is what the thing *is* — a program that
 * runs, rendered verbatim — not where it came from or which interpreter it wants
 * (that is `contentSubtype`).
 */
export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  image: 'Screenshot',
  codeblock: 'Code block',
  script: 'Script',
  'terminal-recording': 'Terminal recording',
  'http-request-cycle': 'HTTP request',
  event: 'Event',
  none: 'Note',
};

/** Lookup set behind {@link isEvidenceType}; built once. */
const EVIDENCE_TYPE_VALUES: ReadonlySet<string> = new Set(EVIDENCE_TYPES);

/**
 * Narrow a raw string to an `EvidenceType`. Every server-side read of
 * `Evidence.contentType` starts as a `string` (the column is TEXT, with no enum
 * or CHECK behind it), so this is the one place that decides whether such a value
 * is a type we know — instead of casting `contentType as EvidenceType` and
 * indexing a map that may not hold it.
 */
export function isEvidenceType(value: string): value is EvidenceType {
  return EVIDENCE_TYPE_VALUES.has(value);
}

/**
 * Glyph shown beside a piece of evidence in dense lists — timeline rows, the
 * reparent picker, the finding evidence picker, finding evidence cards.
 *
 * Exhaustive `Record<EvidenceType, string>`, and that is the whole point: this
 * map previously existed as four byte-identical `Record<string, string>` copies
 * in the web app, each ending in `?? '•'`, so adding an evidence type compiled
 * clean and then quietly rendered a bullet in four places. Keyed by the enum, a
 * new type is a compile error here until it is given a glyph.
 *
 * Text symbols rather than emoji wherever one reads clearly at 1em. `❯` is the
 * shell-prompt chevron: it says "this runs" without colliding with the filled
 * play triangle that marks a recording.
 */
export const EVIDENCE_TYPE_ICONS: Record<EvidenceType, string> = {
  image: '🖼',
  codeblock: '⌨',
  script: '❯',
  'terminal-recording': '▸',
  'http-request-cycle': '⇄',
  event: '⚑',
  none: '✎',
};

/**
 * Whether a type's body is editable text — a UTF-8 blob the operator can edit in
 * place — rather than opaque bytes (a screenshot, an asciicast).
 *
 * Exhaustive so a new type cannot be added without deciding this. The two
 * hand-copied lists it replaces (the web evidence body and the server's
 * update-evidence route) would otherwise have disagreed by default: the new type
 * would render read-only on one surface while the other rejected `content`
 * updates for it, with nothing failing to compile.
 */
export const EVIDENCE_TEXT_EDITABLE: Record<EvidenceType, boolean> = {
  image: false,
  codeblock: true,
  // An uploaded script is decoded to UTF-8 at create time and stored exactly like
  // typed content, so it stays editable afterwards however it arrived.
  script: true,
  'terminal-recording': false,
  'http-request-cycle': true,
  event: true,
  none: true,
};

/** The editable-text types, in `EVIDENCE_TYPES` order. Derived, never hand-listed. */
export const EDITABLE_TEXT_EVIDENCE_TYPES: readonly EvidenceType[] = EVIDENCE_TYPES.filter(
  (t) => EVIDENCE_TEXT_EDITABLE[t],
);

/**
 * {@link EVIDENCE_TEXT_EDITABLE} as a membership test over any string, because
 * the server holds `Evidence.contentType` as a `string` straight from the
 * database. An unrecognized type is not editable.
 */
export function isEditableTextEvidence(contentType: string): boolean {
  return isEvidenceType(contentType) && EVIDENCE_TEXT_EDITABLE[contentType];
}

/**
 * Default file extension (leading dot included) per evidence type, used to name
 * the entry a piece of evidence gets in the report's supporting-files ZIP and in
 * the "Files Attached" table. Exhaustive, so a new type cannot land with no
 * extension and ship an extensionless file in a client deliverable.
 *
 * `image` is `''` rather than `'.png'`: screenshots are embedded in the PDF and
 * excluded from the supporting-files sweep by query, so they are never named
 * here, and the stored bytes may be PNG or JPEG — guessing would be a lie. The
 * empty string reproduces the `?? ''` fallback this map replaces.
 */
export const EVIDENCE_TYPE_EXTENSIONS: Record<EvidenceType, string> = {
  image: '',
  codeblock: '.txt',
  // Fallback only: a script that records its interpreter is named from it (see
  // {@link evidenceFileExtension}). `.txt` rather than `.sh`, because an
  // unspecified interpreter is unknown, not Bourne shell — handing a client a
  // `.sh` that is really Python invites them to run it with the wrong one.
  script: '.txt',
  'terminal-recording': '.cast',
  'http-request-cycle': '.har',
  event: '.txt',
  none: '.txt',
};

/**
 * Interpreter / language token → conventional file extension, for naming a
 * script in the supporting-files ZIP. `contentSubtype` holds whatever the
 * operator typed (`bash`, `python3`, `PowerShell`), which makes a poor extension
 * on its own: `.python` is not a thing.
 *
 * A token that is not in here gets no extension of its own — the script falls back
 * to `.txt` — because the alternative is inventing one from free text, which is the
 * defect this map exists to avoid (see {@link evidenceFileExtension}). Add an entry
 * rather than relying on the token reading like an extension.
 *
 * Deliberately *not* applied to `codeblock`. That type has named its ZIP entries
 * straight from the subtype since before this map existed, and archives already
 * delivered to clients list those names in their "Files Attached" table; mapping
 * them now would silently rename files across re-generated reports.
 */
export const SCRIPT_INTERPRETER_EXTENSIONS: Record<string, string> = {
  sh: 'sh',
  shell: 'sh',
  bash: 'sh',
  zsh: 'sh',
  ksh: 'sh',
  dash: 'sh',
  ash: 'sh',
  fish: 'fish',
  python: 'py',
  python2: 'py',
  python3: 'py',
  py: 'py',
  ruby: 'rb',
  rb: 'rb',
  perl: 'pl',
  pl: 'pl',
  node: 'js',
  nodejs: 'js',
  javascript: 'js',
  js: 'js',
  typescript: 'ts',
  ts: 'ts',
  powershell: 'ps1',
  pwsh: 'ps1',
  ps1: 'ps1',
  batch: 'bat',
  bat: 'bat',
  cmd: 'cmd',
  php: 'php',
  lua: 'lua',
  awk: 'awk',
  expect: 'exp',
  tcl: 'tcl',
  make: 'mk',
  makefile: 'mk',
};

/**
 * Whether this evidence type records a language / interpreter in `contentSubtype`.
 *
 * Only the two text-code types do: a code block's syntax language, and a script's
 * interpreter. Everywhere else the column is either empty or holds something that
 * is not a format hint, which is why the extension helper, the server's update
 * guard and the create form all have to agree — a hand-written `=== 'codeblock' ||
 * === 'script'` in three places is how they would come to disagree.
 *
 * Takes a `string` because the server reads `contentType` from a TEXT column.
 */
export function evidenceCarriesSubtype(contentType: string): boolean {
  return contentType === 'script' || contentType === 'codeblock';
}

/** Reduce a free-text `contentSubtype` to a bare token (`Python 3` → `python3`). */
function subtypeToken(contentSubtype: string | null | undefined): string {
  return (contentSubtype ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The file extension a piece of evidence gets in the report's supporting-files
 * ZIP — including the leading dot, or `''` for none.
 *
 * Takes a `string` content type because the caller reads it from the database.
 * For `script` and `codeblock` a recorded `contentSubtype` beats the per-type
 * default, so a Python script lands as `.py`.
 *
 * The two differ in what happens to a token the map does not know:
 *
 * - `script` falls back to the per-type `.txt`. The Interpreter field is free text
 *   ("names the file in the report" is all it promises), so `pyton`, `Bourne Again
 *   Shell`, `nushell` and `C#` are all realistic input, and passing those through
 *   produces exactly what this map exists to prevent — a made-up `.pyton`, a
 *   truncated `.bourneag`, or worse, a *plausible but wrong* `.c` on a C# script.
 *   The same reasoning already rules out defaulting an interpreter-less script to
 *   `.sh`: handing a client a file named for the wrong interpreter invites them to
 *   run it with the wrong one, and `.txt` says only what is true.
 * - `codeblock` keeps its historical raw-token behaviour (`python` → `.python`),
 *   warts and all, because archives already delivered to clients list those entry
 *   names in their "Files Attached" table and mapping them now would rename files
 *   across a re-generated report. Tokens are capped at 8 characters there, so a
 *   junk subtype cannot grow the filename.
 */
export function evidenceFileExtension(contentType: string, contentSubtype?: string | null): string {
  const fallback = isEvidenceType(contentType) ? EVIDENCE_TYPE_EXTENSIONS[contentType] : '';
  if (!evidenceCarriesSubtype(contentType)) return fallback;
  const token = subtypeToken(contentSubtype);
  if (!token) return fallback;
  if (contentType === 'script') {
    const mapped = SCRIPT_INTERPRETER_EXTENSIONS[token];
    return mapped ? '.' + mapped : fallback;
  }
  return '.' + token.slice(0, 8);
}

/**
 * Size cap for script evidence, in bytes — far below the server's
 * `MAX_UPLOAD_BYTES` on purpose. A script is decoded to UTF-8 at create time,
 * held in memory to be edited, and rendered verbatim into the PDF; none of that
 * suits a multi-megabyte blob, and 1 MiB is already orders of magnitude above any
 * real tooling script.
 *
 * Shared so the upload form can refuse an oversized file before sending it and
 * the server can refuse it on arrival, against the same number.
 */
export const MAX_SCRIPT_BYTES = 1024 * 1024;

/**
 * Why an uploaded file was refused as script evidence. Shared for the same reason
 * as {@link LAST_ADMIN_REASON}: the server raises these as its 400 message and the
 * UI shows them inline, so a second copy is how the two would come to describe
 * the same refusal differently.
 */
export const SCRIPT_NOT_TEXT_REASON =
  'That file isn’t UTF-8 text. A script is stored and edited as text — check you picked the source file, not a compiled binary or an archive.';
export const SCRIPT_TOO_LARGE_REASON = `A script is limited to ${MAX_SCRIPT_BYTES / 1024 / 1024} MB of text. Trim it, or split it across separate evidence.`;
/**
 * Why an *empty* file was refused as script evidence.
 *
 * Refused rather than accepted as "a script with no body": the operator picked a
 * file, so their intent was to file its contents, and storing nothing would leave
 * a zero-length entry in the report ZIP with the SHA-256 of the empty string
 * listed beside it in the Files Attached table — a file the client is told to look
 * for and finds blank. Typed content left empty is a different gesture and still
 * means "no body yet".
 */
export const SCRIPT_EMPTY_REASON =
  'That file is empty. Pick the file with the script in it, or type the script into the field instead.';

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
 * The one wording for the report-exclusion state. Every surface that lists
 * evidence shares it — the web timeline, finding cards and pickers, and the
 * desktop tray's "Link to" picker — so none of them can describe the same flag
 * differently. It lives here rather than in the web app because the Electron
 * renderer cannot import from `apps/web`, and a second copy is exactly how the
 * two would drift.
 */
export const EXCLUDED_FROM_REPORT_LABEL = 'Excluded from reports';

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
  assessmentExecution: [
    /*
     * Every item here names a piece of content that *renders*, never its
     * suppression. The convention is fixed — a piece renders unless its section
     * entry's `options[key]` is explicitly `false` — and no existing engagement
     * has an `options` map for this section at all, so every key below is absent
     * and reads as `true`. That is what keeps an already-configured report
     * byte-identical to the one it produced before these toggles existed.
     */
    {
      key: 'evidenceTags',
      label: 'Evidence tags',
      sample: 'Tag chips under each evidence item.',
    },
    {
      key: 'typeCaptions',
      label: 'Evidence type captions',
      sample: 'The “Script” / “Screenshot” caption line under each embedded item.',
    },
    /*
     * Polarity is load-bearing, hence "show the script bodies" rather than "hide
     * scripts": a `hideScripts` key would be read by the same absent-means-true
     * rule as *hiding enabled* for every configuration that predates it, which is
     * exactly backwards. Turning this off never drops a script from the
     * deliverable — it is still swept into `supporting-files/` and still listed
     * in Files Attached; only the inline body is replaced, by a one-line stub
     * naming that ZIP entry.
     */
    {
      key: 'scriptBodies',
      label: 'Script contents',
      sample: 'Each script in full; off, a one-line pointer to the attached file.',
    },
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
