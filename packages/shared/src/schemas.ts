import { z } from 'zod';
import {
  EVIDENCE_TYPES,
  MAX_REPORT_CUSTOM_SECTIONS,
  MAX_REPORT_SECTION_ENTRIES,
  WATERMARK_MAX_CHARS,
  evidenceTypeSchema,
  engagementRoleSchema,
  engagementStatusSchema,
  evidenceGroupingSchema,
  findingGroupingSchema,
  executionSubsectionKindSchema,
  goalStatusSchema,
  savedQueryTypeSchema,
  severitySchema,
  fixEffortSchema,
  findingKindSchema,
  watermarkLayerSchema,
  watermarkOpacitySchema,
  reportPresetSchema,
  generatedReportFormatSchema,
  attestationFrameworkSchema,
  type ReportPreset,
} from './enums.js';
import { cvssVectorSchema } from './cvss.js';
import { TAG_COLOR_NAMES } from './tags.js';

/**
 * Longest slug any route accepts. Exported because the server derives slugs
 * (`uniqueSlug`, which appends a `-2`, `-3`, … suffix) and has to keep the result
 * inside the same bound it will later be validated against.
 */
export const SLUG_MAX_LENGTH = 64;

/** A URL-safe slug: lowercase alphanumerics and hyphens. */
export const slugSchema = z
  .string()
  .min(1)
  .max(SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase alphanumerics separated by hyphens');

export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// Structured report content (engagement-level; stored as JSON, edited in Settings)
//
// These item shapes back the JSON columns on an engagement. They are validated on
// write (updateEngagementInput) and returned on the engagement-detail read shape.
// Rendered into the exported PDF; each list defaults to empty.
// ---------------------------------------------------------------------------

/** A strategic recommendation shown in the report (numbered R1, R2, …). */
export const recommendationItemSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(10_000).default(''),
  /**
   * The findings this recommendation addresses, by finding `uuid`. Every
   * recommendation must correlate with at least one finding — the editor enforces
   * this on save — but the field stays lenient here (defaults to `[]`) so
   * recommendations authored before the link existed still parse on read. Dangling
   * uuids (the finding was deleted) are skipped when the report is rendered.
   */
  findingUuids: z.array(uuidSchema).max(100).default([]),
});
export type RecommendationItem = z.infer<typeof recommendationItemSchema>;

/** A scope target and its in-scope subsystems (rendered as the Service Scope). */
export const scopeTargetSchema = z.object({
  name: z.string().min(1).max(255),
  subsystems: z.array(z.string().max(255)).max(200).default([]),
});
export type ScopeTarget = z.infer<typeof scopeTargetSchema>;

/** A person listed in the report front-matter (provider or client side). Fields
 *  are lenient (any may be blank) so contacts can be entered incrementally. */
export const contactSchema = z.object({
  name: z.string().max(255).default(''),
  title: z.string().max(255).default(''),
  email: z.string().max(320).default(''),
});
export type Contact = z.infer<typeof contactSchema>;

/** A piece of software with its version (client software tested / 3rd-party used). */
export const softwareItemSchema = z.object({
  name: z.string().min(1).max(255),
  version: z.string().max(120).default(''),
});
export type SoftwareItem = z.infer<typeof softwareItemSchema>;

/**
 * A threat-model diagram: an inline image data URI plus a caption. Capped at
 * ~2 MB of base64 per image (recommend PNG/SVG ≲1600px wide) so a handful of
 * diagrams still embed cleanly in the exported PDF.
 */
export const threatDiagramSchema = z.object({
  imageDataUri: z
    .string()
    .max(2_800_000)
    .regex(/^data:image\/(png|jpeg|jpg|webp|svg\+xml|gif);base64,/, 'must be an image data URI'),
  caption: z.string().max(500).default(''),
});
export type ThreatDiagram = z.infer<typeof threatDiagramSchema>;

/**
 * A reference from an Assessment Execution subsection to a piece of the
 * engagement's evidence, by uuid, with an optional caption. Resolved at render
 * time; refs whose evidence no longer exists are skipped.
 */
export const executionEvidenceRefSchema = z.object({
  evidenceUuid: uuidSchema,
  caption: z.string().max(2000).default(''),
});
export type ExecutionEvidenceRef = z.infer<typeof executionEvidenceRefSchema>;

/**
 * Filters for a `timeline`-kind Assessment Execution subsection: it renders the
 * engagement's captured evidence (not hand-picked), narrowed and grouped. Empty
 * `tags`/`types` mean "no restriction". `starred` is resolved against the user
 * generating the report.
 */
export const executionTimelineConfigSchema = z.object({
  /** Restrict to evidence carrying all of these tags (empty = any tag). */
  tags: z.array(z.string().max(64)).max(50).default([]),
  /** Restrict to these evidence content types (empty = any type). */
  types: z.array(evidenceTypeSchema).max(EVIDENCE_TYPES.length).default([]),
  /** How items are grouped in the report (chronological / by tag / by type). */
  group: evidenceGroupingSchema.default('chronological'),
  /** Include follow-up comment evidence; default shows only top-level items. */
  includeComments: z.boolean().default(false),
  /** Only include evidence the report's author has starred. */
  starredOnly: z.boolean().default(false),
});
export type ExecutionTimelineConfig = z.infer<typeof executionTimelineConfigSchema>;

/**
 * One titled subsection of the Assessment Execution narrative. A `narrative`
 * subsection (the default and legacy shape) groups hand-authored prose plus
 * embedded evidence by topic/interface; a `timeline` subsection instead renders
 * a filtered, grouped view of the engagement's captured evidence (see
 * `timeline`). Legacy rows lack `kind` and parse as `narrative`.
 */
export const executionSubsectionSchema = z.object({
  kind: executionSubsectionKindSchema.default('narrative'),
  title: z.string().min(1).max(255),
  // Narrative fields: present for `narrative`; ignored (and empty) for `timeline`.
  body: z.string().max(20_000).default(''),
  evidence: z.array(executionEvidenceRefSchema).max(200).default([]),
  // Timeline config: present for `timeline` subsections.
  timeline: executionTimelineConfigSchema.optional(),
});
export type ExecutionSubsection = z.infer<typeof executionSubsectionSchema>;

// ---------------------------------------------------------------------------
// Report composition config (per-engagement; drives the Reports section)
// ---------------------------------------------------------------------------

/** A free-text custom section a user can insert into the report flow. */
export const reportCustomSectionSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(255),
  body: z.string().max(50_000).default(''),
});
export type ReportCustomSection = z.infer<typeof reportCustomSectionSchema>;

/**
 * One entry in the ordered report section list. `key` is a built-in
 * `ReportSection` value or `custom:<id>` referencing a `customSections` entry.
 */
export const reportSectionEntrySchema = z.object({
  key: z.string().min(1).max(80),
  enabled: z.boolean().default(true),
  /**
   * Per-section sub-item toggles, keyed by the item ids in `REPORT_SECTION_ITEMS`.
   * An absent key (or `true`) includes that piece; `false` excludes it. Only
   * meaningful for built-in sections that expose sub-items; ignored otherwise.
   */
  options: z.record(z.boolean()).optional(),
});
export type ReportSectionEntry = z.infer<typeof reportSectionEntrySchema>;

/**
 * The default section order — this reproduces the current ("Kia") report flow
 * exactly. The one new section, `scopeCoverage`, ships disabled so an
 * unconfigured engagement's report is byte-for-byte the same as before.
 */
export const DEFAULT_REPORT_SECTIONS: ReportSectionEntry[] = [
  { key: 'executiveSummary', enabled: true },
  { key: 'assessmentFindings', enabled: true },
  { key: 'methodology', enabled: true },
  { key: 'threatModel', enabled: true },
  { key: 'assessmentExecution', enabled: true },
  { key: 'scopeCoverage', enabled: false },
  { key: 'detailedFindings', enabled: true },
  { key: 'supportingInformation', enabled: true },
  { key: 'appendix', enabled: true },
];

/**
 * Per-engagement report configuration. Every field has a default, so
 * `reportConfigSchema.parse(eng.reportConfig ?? {})` yields the canonical default
 * for an engagement that has never been configured.
 */
export const reportConfigSchema = z.object({
  sections: z
    .array(reportSectionEntrySchema)
    .max(MAX_REPORT_SECTION_ENTRIES)
    .default(DEFAULT_REPORT_SECTIONS),
  customSections: z.array(reportCustomSectionSchema).max(MAX_REPORT_CUSTOM_SECTIONS).default([]),
  /** Include every finding; otherwise only "Ready to report" findings. */
  includeAllFindings: z.boolean().default(false),
  /** Include the auto-generated evidence log in Assessment Execution. */
  includeEvidenceTimeline: z.boolean().default(false),
  /** How that evidence log is grouped. */
  evidenceGroup: evidenceGroupingSchema.default('chronological'),
  /**
   * Number the Assessment Execution subsection titles — "1. Infotainment head
   * unit", "2. CAN gateway", … — in the order they already render.
   *
   * Purely a labelling change: it reorders nothing, renumbers nothing else, and
   * never touches the stored titles. It applies to the hand-authored subsection
   * headings only — every entry in `executionNarrative`, whichever `kind` it is,
   * since a written narrative and an activity timeline each carry a title their
   * author wrote — and never to the individual evidence items inside them.
   *
   * Defaults to `false`, so an engagement that has never set it keeps the
   * unnumbered headings its reports have always had.
   */
  numberExecutionSubsections: z.boolean().default(false),
  /**
   * Sanitize option: show each evidence item's capture timestamp in the rendered
   * report (the `when` label on evidence-log items). Defaults to `false` (hidden)
   * so a report never leaks capture times unless the author opts in.
   */
  showEvidenceTimestamps: z.boolean().default(false),
  /**
   * Sanitize option: show each evidence item's operator (capturer) name in the
   * rendered report (the `who` label on evidence-log items). Defaults to `false`
   * (hidden) so operator identities stay out of the report unless opted in.
   */
  showEvidenceOperators: z.boolean().default(false),
  /**
   * How findings are organized in the Assessment Findings + Detailed Findings
   * sections. Defaults to `severity`, reproducing the prior flat, most-severe-
   * first layout, so an unconfigured engagement's report is unchanged.
   */
  findingGroup: findingGroupingSchema.default('severity'),
  /**
   * Print, under each weakness in Detailed Findings, the engagement goals that
   * finding is linked to — the goal title plus its Target · Activity context.
   *
   * Defaults to `true`: a finding's objectives are standard report content you
   * opt *out* of, not a section sub-item you opt in to. So an engagement
   * configured before this field existed gains the block in its next report —
   * deliberate, and the one behavior change this flag carries.
   *
   * It is captured by a saved report template automatically, because
   * `reportTemplateConfigSchema` is derived from this schema with `.omit`.
   */
  showFindingLinkedGoals: z.boolean().default(true),
  /**
   * Render a detail card per **strength** in Detailed Findings — description,
   * affected target and category, plus whichever of that section's own sub-items
   * a strength can fill, including its ordered, captioned steps (printed under
   * `Steps Taken` rather than `Attack Path`, which would assert an exploitation).
   * Without it a strength appears only as a row in the Summary of Strengths
   * table, which is all any report has ever shown.
   *
   * Defaults to `false`, so no existing report changes: a strength's detail is
   * extra pages in the deliverable, opted *in* to. It can't be a sub-item of
   * `detailedFindings` for that reason — a section sub-item is absent-means-shown,
   * so a new key there would turn the cards on for every engagement at once.
   *
   * It is captured by a saved report template automatically, because
   * `reportTemplateConfigSchema` is derived from this schema with `.omit`.
   */
  showStrengthDetailCards: z.boolean().default(false),
  /**
   * Report-readiness items the author has explicitly marked "Not applicable".
   * Keyed by the readiness item ids (see the web app's report-readiness helper);
   * an N/A item counts as satisfied toward the report's "Ready" status. Stored
   * here (rather than a new column) so it round-trips with the rest of the report
   * configuration.
   */
  readinessNa: z.array(z.string().max(80)).max(50).default([]),
});
export type ReportConfig = z.infer<typeof reportConfigSchema>;

/**
 * The slice of a report configuration a saved **report template** carries:
 * everything in `reportConfigSchema` except `readinessNa`. Derived with `.omit`
 * rather than retyped, so a field added to the report config is captured by
 * templates automatically and the two cannot drift.
 *
 * `readinessNa` is excluded deliberately. It records which report-readiness
 * checklist items *one engagement* waived as not applicable — per-engagement
 * bookkeeping about specific items, not a reporting choice — so a template neither
 * captures it nor disturbs the engagement's own waivers when it is applied.
 *
 * `.omit` preserves each surviving field's default, so
 * `reportTemplateConfigSchema.parse({})` yields the same canonical defaults as an
 * unconfigured engagement's `reportConfigSchema.parse({})`.
 */
export const reportTemplateConfigSchema = reportConfigSchema.omit({ readinessNa: true });
export type ReportTemplateConfig = z.infer<typeof reportTemplateConfigSchema>;

// ---------------------------------------------------------------------------
// Report history + attestation letters
// ---------------------------------------------------------------------------

/**
 * A snapshot of the findings tallies behind a generated report, captured when
 * the report is produced. It is stored on the `GeneratedReport` record so an
 * attestation letter issued later stays consistent with the report as
 * generated, even if the engagement's findings change afterwards. Counts are
 * weaknesses only (strengths carry no severity); `none` is the "informational"
 * band. `overallRisk` seeds the letter's overall-risk statement and defaults to
 * the highest severity present.
 */
export const reportSummarySchema = z.object({
  findingsTotal: z.number().int().nonnegative(),
  weaknessesTotal: z.number().int().nonnegative(),
  strengthsTotal: z.number().int().nonnegative(),
  bySeverity: z.object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    none: z.number().int().nonnegative(),
  }),
  highestCvss: z.number().nullable(),
  highestSeverity: severitySchema.nullable(),
  overallRisk: severitySchema.nullable(),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

/**
 * One entry in an engagement's report history — a record that a report document
 * (PDF, ZIP, or JSON) was generated. `version` is an auto-assigned, human label
 * (`v1.0`, `v2.0`, …) so a letter can name the exact deliverable it attests to,
 * and `summary` snapshots the findings tallies as generated. The rendered
 * artifact bytes are stored so the exact file can be re-downloaded:
 * `downloadable` is true when those bytes are available (older records generated
 * before artifact storage are not), and `sizeBytes` is the stored file size for
 * display. `generatedBy` is the operator's display name (null if that user was
 * later removed).
 */
export const generatedReportSchema = z.object({
  uuid: uuidSchema,
  preset: reportPresetSchema,
  label: z.string(),
  version: z.string(),
  format: generatedReportFormatSchema,
  summary: reportSummarySchema,
  generatedBy: z.string().nullable(),
  createdAt: isoDateSchema,
  /** True when the stored artifact bytes are available to re-download. */
  downloadable: z.boolean().default(false),
  /** Size of the stored artifact in bytes (null when not stored). */
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
});
export type GeneratedReport = z.infer<typeof generatedReportSchema>;

/**
 * The inputs that shape an attestation letter, supplied as query params on the
 * letter download. All are optional: `framework` defaults to SOC 2, the report
 * defaults to the latest in history, the signatory/recipient default to the
 * engagement's first provider/client contact, and the overall-risk statement
 * defaults to the snapshot's highest severity. `frameworkLabel` names the
 * framework when `framework` is `custom`. `recipientName`/`recipientTitle` set
 * the "Attn:" line; `salutationName` sets the "Dear …" greeting independently
 * (falling back to the recipient name). `showExclusions` opts the scope
 * exclusions into the letter — they are omitted by default.
 */
export const attestationLetterInputSchema = z.object({
  framework: attestationFrameworkSchema.default('soc2'),
  frameworkLabel: z.string().max(120).optional(),
  reportUuid: uuidSchema.optional(),
  signatoryName: z.string().max(255).optional(),
  signatoryTitle: z.string().max(255).optional(),
  signatoryEmail: z.string().max(320).optional(),
  recipientName: z.string().max(255).optional(),
  recipientTitle: z.string().max(255).optional(),
  salutationName: z.string().max(255).optional(),
  overallRisk: severitySchema.optional(),
  showExclusions: z.boolean().default(false),
});
export type AttestationLetterInput = z.infer<typeof attestationLetterInputSchema>;

/**
 * The ordered section list for a canned report "type" (everything but `custom`,
 * which renders the engagement's saved configuration). `full` reproduces the
 * default report; `executive` and `findings` are focused subsets.
 *
 * A preset decides *which* sections appear and in what order. It deliberately
 * says nothing about what each one shows inside itself, so `configured` — the
 * engagement's own section list — is read for its per-section sub-item `options`,
 * which are carried onto every section the preset keeps (matched by `key`;
 * `enabled` and the order stay the preset's).
 *
 * Without that carry-over a sub-item set to `false` is silently dropped the moment
 * a built-in report type is picked, because these entries have no `options` map
 * and the render convention is absent-means-on. For a formatting sub-item that is
 * merely surprising; for a *suppression* one it is a disclosure: an author who
 * turned "Script contents" off because a deploy script carries a client
 * credential would get every script body printed in full by choosing "Full
 * report" from the Report type dropdown, with nothing saying so. The two sanitize
 * flags have always been forwarded onto a preset for precisely that reason, and a
 * sub-item is the same kind of choice.
 */
export function reportPresetSections(
  preset: Exclude<ReportPreset, 'custom'>,
  configured: ReportSectionEntry[] = [],
): ReportSectionEntry[] {
  const optionsByKey = new Map(
    configured.filter((s) => s.options !== undefined).map((s) => [s.key, s.options]),
  );
  const withOptions = (s: ReportSectionEntry): ReportSectionEntry => {
    const options = optionsByKey.get(s.key);
    // Keep the key absent rather than `undefined`-valued: the entry is persisted
    // and compared as-is in places (report history, template digests), and an
    // explicit `options: undefined` is not the same JSON as no `options` at all.
    return options ? { ...s, options: { ...options } } : { ...s };
  };
  switch (preset) {
    case 'full':
      return DEFAULT_REPORT_SECTIONS.map(withOptions);
    case 'executive':
      return [withOptions({ key: 'executiveSummary', enabled: true })];
    case 'findings':
      return [
        withOptions({ key: 'assessmentFindings', enabled: true }),
        withOptions({ key: 'detailedFindings', enabled: true }),
      ];
  }
}

// ---------------------------------------------------------------------------
// Goals: Target → Activity → Goal (engagement scope & objectives)
// ---------------------------------------------------------------------------

/** A goal / area of interest under an activity — the trackable unit. */
export const goalSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(500),
  status: goalStatusSchema,
  /** Carried over from a prior report as a retest item (e.g. a "W1-…" goal). */
  isRetest: z.boolean(),
  notes: z.string(),
  position: z.number().int().nonnegative(),
  numEvidence: z.number().int().nonnegative(),
  numFindings: z.number().int().nonnegative(),
});
export type Goal = z.infer<typeof goalSchema>;

/** A testing activity on a target, with its category and correlation tag. */
export const activitySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(255),
  category: z.string(),
  /** The engagement tag auto-created for this activity (timeline correlation). */
  tagId: z.number().int().positive().nullable(),
  position: z.number().int().nonnegative(),
  goals: z.array(goalSchema),
});
export type Activity = z.infer<typeof activitySchema>;

/** A system/device under scope, with its activities. */
export const targetSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(255),
  description: z.string(),
  position: z.number().int().nonnegative(),
  activities: z.array(activitySchema),
});
export type Target = z.infer<typeof targetSchema>;

/** Rolled-up goal progress for an engagement (or a subtree). */
export const engagementProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  notStarted: z.number().int().nonnegative(),
  notApplicable: z.number().int().nonnegative(),
  /** complete / (total − notApplicable), as a whole percent; 0 when nothing to do. */
  percent: z.number().int().min(0).max(100),
});
export type EngagementProgress = z.infer<typeof engagementProgressSchema>;

/** The full goals tree for an engagement, plus its rolled-up progress. */
export const goalsTreeSchema = z.object({
  targets: z.array(targetSchema),
  progress: engagementProgressSchema,
});
export type GoalsTree = z.infer<typeof goalsTreeSchema>;

/** A goal as referenced from an evidence/finding "linked goals" list. */
export const linkedGoalSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  status: goalStatusSchema,
  targetName: z.string(),
  activityName: z.string(),
});
export type LinkedGoal = z.infer<typeof linkedGoalSchema>;

// ---------------------------------------------------------------------------
// Entities (server → client shapes)
// ---------------------------------------------------------------------------

export const userSchema = z.object({
  slug: slugSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  admin: z.boolean(),
  disabled: z.boolean(),
  headless: z.boolean(),
  /**
   * Only populated on `/web/me`: true after a recovery-link sign-in, until the
   * user sets a new password (which then doesn't require the current one).
   */
  mustResetPassword: z.boolean().optional(),
});
export type User = z.infer<typeof userSchema>;

/**
 * A user as seen from the admin console: the base user plus whether they have
 * a TOTP secret enrolled (drives the admin "Reset TOTP" action).
 */
export const adminUserSchema = userSchema.extend({
  hasTotp: z.boolean(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const engagementSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(255),
  status: engagementStatusSchema,
  numUsers: z.number().int().nonnegative().optional(),
  numEvidence: z.number().int().nonnegative().optional(),
  numFindings: z.number().int().nonnegative().optional(),
  favorite: z.boolean().optional(),
  role: engagementRoleSchema.optional(),
  createdAt: isoDateSchema,
  /** When the engagement began (defaults to creation time; user-editable). */
  startedAt: isoDateSchema,
  /** Operator-entered target end date; null until set. */
  projectedEndAt: isoDateSchema.nullable(),
  /**
   * When the engagement actually wrapped up. The server stamps this to "now" on
   * any transition into `complete`/`archived` and clears it on a return to
   * `active`; it can also be overridden manually. Null while still active.
   */
  actualEndAt: isoDateSchema.nullable(),
  // Optional report metadata (surfaced on the exported findings-report PDF).
  // Present-or-null on every engagement; edited on the Settings page.
  clientName: z.string().nullable().optional(),
  assessmentType: z.string().nullable().optional(),
  testApproach: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
  executiveSummary: z.string().nullable().optional(),
  methodology: z.string().nullable().optional(),
  /** Narrative statement of engagement objectives (heads the Goals tab). */
  objectivesNarrative: z.string().nullable().optional(),
  // Structured report content. Present on the engagement-detail read shape; omitted
  // from lean list responses (hence optional). Each list defaults to empty server-side.
  scopeTargets: z.array(scopeTargetSchema).optional(),
  scopeExclusions: z.array(z.string()).optional(),
  strategicRecommendations: z.array(recommendationItemSchema).optional(),
  threatModelNarrative: z.string().nullable().optional(),
  threatModelDiagrams: z.array(threatDiagramSchema).optional(),
  executionNarrative: z.array(executionSubsectionSchema).optional(),
  providerContacts: z.array(contactSchema).optional(),
  clientContacts: z.array(contactSchema).optional(),
  softwareTested: z.array(softwareItemSchema).optional(),
  thirdPartySoftware: z.array(softwareItemSchema).optional(),
  // Per-engagement report watermark (drawn on every exported-PDF page but the cover).
  watermarkEnabled: z.boolean().optional(),
  watermarkText: z.string().nullable().optional(),
  watermarkColor: z.string().nullable().optional(),
  watermarkOpacity: watermarkOpacitySchema.optional(),
  watermarkLayer: watermarkLayerSchema.optional(),
  // Report composition config. Always present on responses (normalized to the
  // canonical default for an unconfigured engagement).
  reportConfig: reportConfigSchema.optional(),
  // Rolled-up goal progress; present on list + detail once goals exist.
  progress: engagementProgressSchema.optional(),
  /** Whether a proposal JSON has been imported (raw kept server-side for provenance). */
  hasProposalImport: z.boolean().optional(),
});
export type Engagement = z.infer<typeof engagementSchema>;

/**
 * An engagement as seen from the admin console: every engagement site-wide,
 * plus whether the requesting admin is themselves a member (non-members don't
 * see it on their main Engagements page).
 */
export const adminEngagementSchema = engagementSchema.extend({
  amMember: z.boolean(),
});
export type AdminEngagement = z.infer<typeof adminEngagementSchema>;

/** A user attached to an engagement, with their role on it. */
export const engagementMemberSchema = z.object({
  user: userSchema,
  role: engagementRoleSchema,
});
export type EngagementMember = z.infer<typeof engagementMemberSchema>;

/** Add (or re-role) a member on an engagement by their account email. */
export const addEngagementMemberInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: engagementRoleSchema,
});
export type AddEngagementMemberInput = z.infer<typeof addEngagementMemberInput>;

/**
 * A `colorName` restricted to the shared 12-swatch palette. Inputs only — see
 * `tagSchema.colorName`, which stays a loose string on the way out.
 */
export const tagColorNameSchema = z.enum(TAG_COLOR_NAMES);

export const tagSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(64),
  /**
   * Loose on purpose: rows predating palette validation (and imported
   * engagements, whose `exportedTagSchema.colorName` is still a free string) may
   * hold an off-palette value, which `tagColor()` degrades to `slate`. Inputs are
   * constrained — see `tagColorNameSchema`.
   */
  colorName: z.string(),
  /**
   * Total applications: `evidenceCount + findingCount`. Present on list
   * responses. Kept as the sum so every existing reader of this field means what
   * it always meant.
   */
  usageCount: z.number().int().nonnegative().optional(),
  /**
   * How many pieces of evidence carry this tag. Present on the web list response;
   * drives the delete / merge / unapply blast-radius wording.
   */
  evidenceCount: z.number().int().nonnegative().optional(),
  /**
   * How many findings carry this tag. Present only once findings can carry tags
   * (there is no finding↔tag relation before that); readers treat absent as zero.
   */
  findingCount: z.number().int().nonnegative().optional(),
  /**
   * Names of the Goals activities using this tag as their correlation tag
   * (`TargetActivity.tagId`). Present on the web list response only; the rename
   * editor and the merge dialog quote it, because renaming the *activity* later
   * mints a fresh tag rather than following this one (`ensureActivityTag`).
   */
  activityNames: z.array(z.string()).optional(),
});
export type Tag = z.infer<typeof tagSchema>;

export const evidenceSchema = z.object({
  uuid: uuidSchema,
  engagementSlug: slugSchema,
  /** Who captured this evidence, or null once that user has been deleted (the
   *  evidence outlives its author; the UI renders "Deleted user"). */
  operator: userSchema.pick({ slug: true, firstName: true, lastName: true }).nullable(),
  /** Short label for the evidence — the primary heading shown in lists, cards, and
   *  the report. May be empty on evidence created before titles existed (the UI then
   *  falls back to the description, then the content-type label). */
  title: z.string(),
  /** Longer prose about the evidence, shown in full on the detail view and as a
   *  snippet elsewhere. */
  description: z.string(),
  contentType: evidenceTypeSchema,
  /**
   * The language of a code block or the interpreter of a script (`bash`,
   * `python3`), or null. Only the two text-code types carry one — see
   * `evidenceCarriesSubtype`.
   *
   * Serialized because it is not merely decorative: for a script it decides the
   * extension the supporting-files ZIP entry gets (`evidenceFileExtension`), so it
   * names a file handed to a client, and it prints as the report's language chip.
   * A value the operator can neither see nor correct would mean a script filed
   * under a typo'd interpreter is stuck being delivered as `.txt` with nothing on
   * any screen explaining why. `optional` for the same reason as
   * `originalFilename`: a client built against this schema should still parse a
   * response from a server that predates the field.
   */
  contentSubtype: z.string().nullable().optional(),
  /** Original uploaded filename, when known (used to name files in the report ZIP). */
  originalFilename: z.string().nullable().optional(),
  occurredAt: isoDateSchema,
  createdAt: isoDateSchema,
  /** Last modification time; equals `createdAt` until the evidence is edited. */
  updatedAt: isoDateSchema,
  /** Who last edited this evidence (any field), or null if never edited since creation. */
  lastEditedBy: userSchema.pick({ slug: true, firstName: true, lastName: true }).nullable(),
  tags: z.array(tagSchema),
  /** Present when the evidence has a stored blob (image/recording/har). */
  hasContent: z.boolean(),
  hasThumbnail: z.boolean(),
  /**
   * When this evidence is a comment on another piece of evidence, the parent's
   * uuid; otherwise null. Comments are themselves full evidence, linked to a
   * single parent (see `createEvidenceInput.parentEvidenceUuid`).
   */
  parentEvidenceUuid: uuidSchema.nullable(),
  /** How many comments (linked evidence) point at this piece of evidence. */
  commentCount: z.number().int().nonnegative(),
  /** How many engagement goals this evidence is linked to (`GoalEvidence` rows).
   *  Here so a list can show that the link exists without a per-item request —
   *  only the detail view loads the goals themselves, with their names and their
   *  Target · Activity context. */
  numGoals: z.number().int().nonnegative(),
  /** Whether the requesting user starred this evidence (per-user, like engagement favorites). */
  starred: z.boolean().optional(),
  /** When true this evidence is omitted from every report output — the PDF, the
   *  supporting-files ZIP and the JSON export — as is any linked evidence hanging
   *  off it. It stays fully visible in the app, badged, so it can be un-excluded.
   *  The one way to get it into a file is an explicit backup export, which carries
   *  the flag so an import restores the exclusion with the evidence. */
  excludeFromReport: z.boolean(),
  /** True when this is linked evidence hanging off a parent that is itself excluded
   *  from reports. Exclusion is inherited downwards (the server's one definition of
   *  report visibility is `REPORT_VISIBLE_EVIDENCE`), so such an item is withheld
   *  from every report output even though its own `excludeFromReport` is false —
   *  which is exactly the state a badge has to spell out, since nothing else about
   *  the row looks withheld. The client can't derive it from `parentEvidenceUuid`
   *  alone (it never holds the parent row), so the server resolves it. Always false
   *  for a top-level capture. */
  parentExcludedFromReport: z.boolean(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

/**
 * Evidence as it appears attached to a finding: the base evidence shape plus the
 * per-link bucket fields. `inPath` splits a finding's evidence into two buckets —
 * the ordered, captioned Attack Path (`true`) and plain Attached Evidence
 * (`false`); `caption` describes the step in the Attack Path.
 */
export const findingEvidenceSchema = evidenceSchema.extend({
  caption: z.string(),
  inPath: z.boolean(),
});
export type FindingEvidence = z.infer<typeof findingEvidenceSchema>;

export const findingCategorySchema = z.object({
  id: z.number().int().positive(),
  category: z.string().min(1).max(255),
});
export type FindingCategory = z.infer<typeof findingCategorySchema>;

export const findingSchema = z.object({
  uuid: uuidSchema,
  engagementSlug: slugSchema,
  title: z.string().min(1).max(255),
  description: z.string(),
  /** Whether this finding is a weakness (default) or a security strength. */
  kind: findingKindSchema,
  /** System/component the finding applies to (may be empty). */
  affectedTarget: z.string(),
  /** Business/technical impact if exploited — distinct from the description (weaknesses). */
  impact: z.string(),
  /** Estimated remediation effort (weaknesses). */
  fixEffort: fixEffortSchema,
  /** Mapped ISO/SAE 21434 reference ids (see the standards catalog). */
  iso21434Refs: z.array(z.string()),
  /** Mapped UN R155 reference ids (see the standards catalog). */
  unr155Refs: z.array(z.string()),
  /** Recommended remediation / fix guidance (may be empty). */
  remediation: z.string(),
  category: z.string().nullable(),
  /** Qualitative severity (CVSS v3.1 scale); null when not yet rated. */
  severity: severitySchema.nullable(),
  /** Full CVSS v3.1 base vector string, when rated via the calculator. */
  cvssVector: z.string().nullable(),
  /** CVSS v3.1 base score (0.0–10.0), derived from the vector. */
  cvssScore: z.number().min(0).max(10).nullable(),
  readyToReport: z.boolean(),
  /** Manual sort position within the engagement's findings (ascending). */
  position: z.number().int().nonnegative(),
  numEvidence: z.number().int().nonnegative(),
  /** How many of those evidence links will actually reach report output — the
   *  subset matching the server's `REPORT_VISIBLE_EVIDENCE` predicate, so it also
   *  discounts *inherited* exclusion (linked evidence under an excluded parent is
   *  withheld with its own flag clear). Always ≤ `numEvidence`; a plain
   *  "not excluded" count would overstate it. `numEvidence > 0` with this at 0 is
   *  the case worth warning about: the report renders the finding with no evidence
   *  section and says nothing about why. */
  numEvidenceInReport: z.number().int().nonnegative(),
  /** How many engagement goals this finding is linked to (drives the Findings
   *  page's linked-goals filter/sort). */
  numGoals: z.number().int().nonnegative(),
  /** How many of the engagement's strategic recommendations address this finding —
   *  the ones whose `findingUuids` include this `uuid`. Not a relation: the source
   *  is the engagement's `strategicRecommendations` JSON column, so the server
   *  derives this per request rather than counting rows. A recommendation may
   *  address several findings, so these counts legitimately sum to more than the
   *  number of recommendations; a dangling uuid (the finding was deleted) simply
   *  never matches and is counted nowhere. */
  numRecommendations: z.number().int().nonnegative(),
  createdAt: isoDateSchema,
  /** Last modification time; equals `createdAt` until the finding is edited. */
  updatedAt: isoDateSchema,
});
export type Finding = z.infer<typeof findingSchema>;

/**
 * A finding plus its attached evidence, as returned by the finding-detail route.
 * Evidence is a flat list carrying each link's bucket (`inPath`) and `caption`;
 * the client splits it into Attack Path (inPath=true) and Attached Evidence
 * (inPath=false), each ordered by the link's stored position.
 */
export const findingDetailSchema = findingSchema.extend({
  evidence: z.array(findingEvidenceSchema),
});
export type FindingDetail = z.infer<typeof findingDetailSchema>;

export const apiKeySchema = z.object({
  accessKey: z.string(),
  /** Only returned once, at creation time. */
  secretKey: z.string().optional(),
  lastAuth: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const savedQuerySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(255),
  query: z.string(),
  type: savedQueryTypeSchema,
});
export type SavedQuery = z.infer<typeof savedQuerySchema>;

// ---------------------------------------------------------------------------
// Request payloads (client → server)
// ---------------------------------------------------------------------------

export const createEngagementInput = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(255),
  /** Optional target end date, set at creation time. */
  projectedEndAt: isoDateSchema.nullable().optional(),
});
export type CreateEngagementInput = z.infer<typeof createEngagementInput>;

/**
 * Partial update of an engagement's details. Dates are nullable so the client
 * can clear them. Moving `status` into `complete`/`archived` makes the server
 * stamp `actualEndAt`; a return to `active` clears it — unless `actualEndAt` is
 * given explicitly in the same request, which always wins.
 */
export const updateEngagementInput = z.object({
  name: z.string().min(1).max(255).optional(),
  status: engagementStatusSchema.optional(),
  startedAt: isoDateSchema.optional(),
  projectedEndAt: isoDateSchema.nullable().optional(),
  actualEndAt: isoDateSchema.nullable().optional(),
  // Report metadata. Each is nullable so an empty field clears it.
  clientName: z.string().max(255).nullable().optional(),
  assessmentType: z.string().max(255).nullable().optional(),
  testApproach: z.string().max(255).nullable().optional(),
  location: z.string().max(255).nullable().optional(),
  scope: z.string().max(20_000).nullable().optional(),
  executiveSummary: z.string().max(20_000).nullable().optional(),
  methodology: z.string().max(20_000).nullable().optional(),
  objectivesNarrative: z.string().max(20_000).nullable().optional(),
  // Structured report content (JSON lists). Each is optional so a request can set
  // just one; sending an empty array clears that list. Sizes are capped to bound
  // the engagement row + PDF payload.
  scopeTargets: z.array(scopeTargetSchema).max(100).optional(),
  scopeExclusions: z.array(z.string().max(500)).max(100).optional(),
  strategicRecommendations: z.array(recommendationItemSchema).max(200).optional(),
  threatModelNarrative: z.string().max(20_000).nullable().optional(),
  threatModelDiagrams: z.array(threatDiagramSchema).max(12).optional(),
  executionNarrative: z.array(executionSubsectionSchema).max(100).optional(),
  providerContacts: z.array(contactSchema).max(50).optional(),
  clientContacts: z.array(contactSchema).max(50).optional(),
  softwareTested: z.array(softwareItemSchema).max(200).optional(),
  thirdPartySoftware: z.array(softwareItemSchema).max(200).optional(),
  // Report watermark. Text/color are nullable so an empty field restores the default.
  // Text is capped short so the diagonal word always fits the page (see WATERMARK_MAX_CHARS).
  watermarkEnabled: z.boolean().optional(),
  watermarkText: z.string().max(WATERMARK_MAX_CHARS).nullable().optional(),
  watermarkColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex color')
    .nullable()
    .optional(),
  watermarkOpacity: watermarkOpacitySchema.optional(),
  watermarkLayer: watermarkLayerSchema.optional(),
  // Report composition config (Reports section). Replaces the whole config.
  reportConfig: reportConfigSchema.optional(),
});
export type UpdateEngagementInput = z.infer<typeof updateEngagementInput>;

// ---------------------------------------------------------------------------
// Goals request payloads (client → server)
// ---------------------------------------------------------------------------

export const createTargetInput = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(10_000).default(''),
});
export type CreateTargetInput = z.infer<typeof createTargetInput>;

export const updateTargetInput = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(10_000).optional(),
});
export type UpdateTargetInput = z.infer<typeof updateTargetInput>;

export const createActivityInput = z.object({
  name: z.string().min(1).max(255),
  category: z.string().max(120).default(''),
});
export type CreateActivityInput = z.infer<typeof createActivityInput>;

export const updateActivityInput = z.object({
  name: z.string().min(1).max(255).optional(),
  category: z.string().max(120).optional(),
});
export type UpdateActivityInput = z.infer<typeof updateActivityInput>;

export const createGoalInput = z.object({
  title: z.string().min(1).max(500),
  isRetest: z.boolean().default(false),
  notes: z.string().max(10_000).default(''),
});
export type CreateGoalInput = z.infer<typeof createGoalInput>;

export const updateGoalInput = z.object({
  title: z.string().min(1).max(500).optional(),
  status: goalStatusSchema.optional(),
  isRetest: z.boolean().optional(),
  notes: z.string().max(10_000).optional(),
});
export type UpdateGoalInput = z.infer<typeof updateGoalInput>;

/** Link one or more pieces of evidence to a goal. */
export const linkGoalEvidenceInput = z.object({
  evidenceUuids: z.array(uuidSchema).min(1).max(500),
});
export type LinkGoalEvidenceInput = z.infer<typeof linkGoalEvidenceInput>;

/** Link one or more findings to a goal. */
export const linkGoalFindingInput = z.object({
  findingUuids: z.array(uuidSchema).min(1).max(500),
});
export type LinkGoalFindingInput = z.infer<typeof linkGoalFindingInput>;

/** Reorder request keyed by numeric ids (targets, activities, or goals). */
export const reorderIdsInput = z.object({
  orderedIds: z.array(z.number().int().positive()).min(1),
});
export type ReorderIdsInput = z.infer<typeof reorderIdsInput>;

export const createTagInput = z.object({
  name: z.string().min(1).max(64),
  colorName: tagColorNameSchema,
});
export type CreateTagInput = z.infer<typeof createTagInput>;

/**
 * Rename and/or recolor an existing tag. Both fields are optional so the settings
 * row editor can save a swatch without re-sending the name, and at least one must
 * be present — an empty body used to be an expensive no-op UPDATE.
 *
 * `name` trims here but not in `createTagInput`: tightening create would change
 * what an already-shipped desktop/CLI payload produces, while a rename is a new
 * code path, and `"  alpha"` renaming to the same visible label as `"alpha"` is
 * exactly the collision the 409 pre-check exists to catch.
 */
export const updateTagInput = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    colorName: tagColorNameSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.colorName !== undefined, {
    message: 'Provide a name or a colorName',
  });
export type UpdateTagInput = z.infer<typeof updateTagInput>;

/** Merge the tag named in the path INTO `intoTagId`, then delete it. */
export const mergeTagInput = z.object({
  intoTagId: z.number().int().positive(),
});
export type MergeTagInput = z.infer<typeof mergeTagInput>;

/** What a merge actually moved — reported back so the toast can be specific. */
export const mergeTagResult = z.object({
  /** The surviving tag, with refreshed counts. */
  tag: tagSchema,
  /** Evidence that gained the survivor's chip. */
  movedEvidence: z.number().int().nonnegative(),
  /** Evidence that already carried both tags, so nothing was created for it. */
  evidenceAlreadyTagged: z.number().int().nonnegative(),
  movedFindings: z.number().int().nonnegative(),
  findingsAlreadyTagged: z.number().int().nonnegative(),
  /** Goals activities whose correlation tag was re-pointed at the survivor. */
  repointedActivities: z.number().int().nonnegative(),
  /** Assessment Execution timeline subsections whose `tags` array was rewritten. */
  rewrittenTimelineSections: z.number().int().nonnegative(),
});
export type MergeTagResult = z.infer<typeof mergeTagResult>;

/** What a bulk unapply stripped. The tag itself survives. */
export const unapplyTagResult = z.object({
  evidenceCleared: z.number().int().nonnegative(),
  findingsCleared: z.number().int().nonnegative(),
});
export type UnapplyTagResult = z.infer<typeof unapplyTagResult>;

/**
 * Everywhere a tag is addressed by NAME rather than id, so the UI can warn before
 * a rename or a merge changes that name out from under them. Saved-query strings
 * are reported but never rewritten (see the server's `services/tags.ts`).
 */
export const tagReferences = z.object({
  savedQueries: z.array(
    z.object({ id: z.number().int().positive(), name: z.string(), type: savedQueryTypeSchema }),
  ),
  /** Assessment Execution timeline subsections naming the tag, by array index. */
  timelineSections: z.array(z.object({ index: z.number().int().nonnegative(), title: z.string() })),
});
export type TagReferences = z.infer<typeof tagReferences>;

/**
 * Metadata for a new piece of evidence. Sent as the JSON `notes` part of the
 * multipart upload; the binary blob (if any) is the `file` part. For the
 * editable-text types (`EVIDENCE_TEXT_EDITABLE`), `content` may be provided
 * inline instead of a file — both paths converge on the same content blob.
 */
export const createEvidenceInput = z.object({
  /** Short label for the evidence (required). Shown as the heading everywhere. */
  title: z.string().min(1).max(255),
  description: z.string().default(''),
  contentType: evidenceTypeSchema,
  occurredAt: isoDateSchema.optional(),
  tagIds: z.array(z.number().int().positive()).default([]),
  /** Inline text content for the editable-text types — note, event, code block,
   *  script, HTTP (see `EVIDENCE_TEXT_EDITABLE`). Stored as a blob exactly like an
   *  uploaded file, so one content endpoint serves either origin. */
  content: z.string().optional(),
  /** Language hint for a code block, or the interpreter for a script (`bash`,
   *  `python3`). Free text; read by the report's language chip and by the extension
   *  the supporting-files ZIP names the entry with (`evidenceFileExtension`), and
   *  readable + editable afterwards (`evidenceSchema.contentSubtype`,
   *  `updateEvidenceInput.contentSubtype`) because it names a client-facing file. */
  contentSubtype: z.string().optional(),
  /** Original filename of an uploaded file, when the client knows it (used to name
   *  files in the report's supporting-files ZIP). File uploads also capture it
   *  from the multipart part server-side. */
  originalFilename: z.string().max(255).optional(),
  /**
   * When set, this evidence becomes a comment on the referenced (top-level)
   * evidence in the same engagement — a way to link evidence together and track
   * follow-ups/updates. The parent must not itself be a comment (one level deep).
   */
  parentEvidenceUuid: uuidSchema.optional(),
  /** Create the evidence already excluded from every report output. Defaults to
   *  false; set by findings-import so an export → import round trip restores the
   *  flag along with the evidence. */
  excludeFromReport: z.boolean().default(false),
});
export type CreateEvidenceInput = z.infer<typeof createEvidenceInput>;
/**
 * What a *caller* has to supply to create evidence — the schema's INPUT type, so
 * fields carrying a `.default()` are optional.
 *
 * `CreateEvidenceInput` is the output type, where a defaulted field is required.
 * That is right for the server, which reads a parsed payload, and wrong for a
 * client building one: adding `excludeFromReport: z.boolean().default(false)` was
 * a backward-compatible change on the wire, yet it broke the desktop and
 * terminal apps at compile time until both were edited to pass a value the
 * server would have supplied anyway. Clients take this type instead.
 */
export type CreateEvidenceInputArg = z.input<typeof createEvidenceInput>;

/**
 * Partial update of a piece of evidence's editable metadata. Every field is
 * optional so the client can autosave one at a time; `title`, when present, must
 * be non-empty (it is required on the record).
 *
 * `parentEvidenceUuid` re-links the evidence after the fact (three states):
 * omitted leaves the link unchanged, a uuid makes this evidence a comment on the
 * referenced (top-level, same-engagement) evidence — moving it if it was already
 * a comment — and `null` detaches it back to standalone top-level evidence. The
 * server enforces the one-level-deep rule (the target must be top-level, not
 * itself; and evidence that already has its own comments cannot become a comment).
 */
export const updateEvidenceInput = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  occurredAt: isoDateSchema.optional(),
  tagIds: z.array(z.number().int().positive()).optional(),
  parentEvidenceUuid: uuidSchema.nullable().optional(),
  /**
   * New text body for editable text evidence — note, event, code block, script,
   * HTTP (`EVIDENCE_TEXT_EDITABLE` is the list; `isEditableTextEvidence` is the
   * check). Stored as the content blob, replacing the previous one; empty string
   * clears it. Only valid for those types — the server rejects it for a
   * screenshot or a terminal recording.
   */
  content: z.string().optional(),
  /**
   * New language / interpreter, or null to clear it. A *value* is only valid for
   * the types that carry one (`evidenceCarriesSubtype`) — the server rejects it for
   * anything else rather than storing something nothing will ever read. Clearing is
   * always allowed: a null says there is no interpreter, which every type agrees
   * with, and refusing it would make "become a Note and drop the interpreter" an
   * error even though omitting the field clears the column anyway.
   *
   * Bounded here even though `createEvidenceInput.contentSubtype` is not: the
   * create path is fed by capture clients, while this one is an operator typing
   * into a text field, and the only thing the value is used for is a token of at
   * most 8 characters.
   */
  contentSubtype: z.string().max(120).nullable().optional(),
  /**
   * Re-label the evidence's type — code block ↔ script above all, now that the two
   * render differently (a code block goes through the markdown renderer, a script
   * prints verbatim).
   *
   * Only the text-backed types may be changed, and in either direction:
   * `isEditableTextEvidence` (`EVIDENCE_TEXT_EDITABLE`) is that set, and every type
   * in it stores an editable text body, so the stored content is left untouched and
   * the change is metadata only. The server refuses a change to *or* from a
   * screenshot or a terminal recording: what is stored for those is a file only
   * their own viewer reads — a PNG, an asciicast — not a body anyone edits.
   *
   * Not a cosmetic relabel: the type decides how the body renders in the report,
   * and `contentSubtype` rides along with it — carried over when the new type reads
   * one too (`evidenceCarriesSubtype`), cleared when it does not. Becoming a
   * `script` additionally has to satisfy that type's own invariant about its bytes
   * (UTF-8, no NULs, under `MAX_SCRIPT_BYTES`), which not every text body does: the
   * server refuses the re-type rather than relabel bytes the report would print as
   * replacement characters into a client PDF.
   */
  contentType: evidenceTypeSchema.optional(),
  /** Hide (true) or re-include (false) this evidence in every report output. */
  excludeFromReport: z.boolean().optional(),
});
export type UpdateEvidenceInput = z.infer<typeof updateEvidenceInput>;

/**
 * A plain-text discussion comment on a piece of evidence (the user-facing
 * "Comments" thread — distinct from linked evidence). Internal only; never
 * appears in the exported report. `edited` is true once the body has been changed
 * after posting.
 */
export const evidenceCommentSchema = z.object({
  uuid: uuidSchema,
  body: z.string(),
  /** Who wrote the comment, or null once that user has been deleted (the UI
   *  renders "Deleted user"). */
  author: userSchema.pick({ slug: true, firstName: true, lastName: true }).nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  edited: z.boolean(),
});
export type EvidenceComment = z.infer<typeof evidenceCommentSchema>;

export const createEvidenceCommentInput = z.object({
  body: z.string().min(1).max(20_000),
});
export type CreateEvidenceCommentInput = z.infer<typeof createEvidenceCommentInput>;

export const updateEvidenceCommentInput = z.object({
  body: z.string().min(1).max(20_000),
});
export type UpdateEvidenceCommentInput = z.infer<typeof updateEvidenceCommentInput>;

export const createFindingInput = z.object({
  title: z.string().min(1).max(255),
  description: z.string().default(''),
  category: z.string().nullable().default(null),
  /** Weakness (default) or strength. */
  kind: findingKindSchema.default('weakness'),
  affectedTarget: z.string().max(255).default(''),
  impact: z.string().max(20_000).default(''),
  fixEffort: fixEffortSchema.default('none'),
  iso21434Refs: z.array(z.string().max(120)).max(100).default([]),
  unr155Refs: z.array(z.string().max(120)).max(100).default([]),
});
export type CreateFindingInput = z.infer<typeof createFindingInput>;

/**
 * Partial update of a finding. `cvssScore` is never accepted from the client —
 * the server derives it from `cvssVector` so the number can't drift from the
 * vector. Setting `cvssVector` recomputes both score and severity server-side;
 * setting `severity` without a vector records a manual (simple-mode) rating.
 */
export const updateFindingInput = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  kind: findingKindSchema.optional(),
  affectedTarget: z.string().max(255).optional(),
  impact: z.string().max(20_000).optional(),
  fixEffort: fixEffortSchema.optional(),
  iso21434Refs: z.array(z.string().max(120)).max(100).optional(),
  unr155Refs: z.array(z.string().max(120)).max(100).optional(),
  remediation: z.string().max(20_000).optional(),
  category: z.string().nullable().optional(),
  severity: severitySchema.nullable().optional(),
  cvssVector: cvssVectorSchema.nullable().optional(),
  readyToReport: z.boolean().optional(),
});
export type UpdateFindingInput = z.infer<typeof updateFindingInput>;

/**
 * Reorder request. For findings it lists every finding in the engagement; for a
 * finding's evidence it lists one bucket's links in their new order (the server
 * assigns positions by array index within that bucket).
 */
export const reorderInput = z.object({
  orderedUuids: z.array(uuidSchema).min(1),
});
export type ReorderInput = z.infer<typeof reorderInput>;

/**
 * Attach one or more pieces of evidence to a finding. `inPath` picks the target
 * bucket: the ordered Attack Path (`true`) or plain Attached Evidence (`false`,
 * the default). New links append to the end of that bucket.
 */
export const attachEvidenceInput = z.object({
  evidenceUuids: z.array(uuidSchema).min(1),
  inPath: z.boolean().default(false),
});
export type AttachEvidenceInput = z.infer<typeof attachEvidenceInput>;

/**
 * Update a single evidence↔finding link. `caption` sets the Attack Path step
 * text; changing `inPath` moves the link to the other bucket (appended to its
 * end). Both are optional so the client can set either independently.
 */
export const updateFindingEvidenceInput = z.object({
  caption: z.string().max(2000).optional(),
  inPath: z.boolean().optional(),
});
export type UpdateFindingEvidenceInput = z.infer<typeof updateFindingEvidenceInput>;

// ---------------------------------------------------------------------------
// Client API responses
// ---------------------------------------------------------------------------

export const checkConnectionResult = z.object({
  ok: z.literal(true),
  user: userSchema.pick({ slug: true, firstName: true, lastName: true, email: true }),
  serverVersion: z.string(),
});
export type CheckConnectionResult = z.infer<typeof checkConnectionResult>;

/** Standard paginated envelope for list endpoints. */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  });
}

// ---------------------------------------------------------------------------
// Findings export / import envelope (report.json)
// ---------------------------------------------------------------------------

/** Bump when the export shape changes incompatibly; import validates it. */
export const FINDINGS_EXPORT_VERSION = 4;

/**
 * The version an export is stamped with when nothing in it needs v4 semantics —
 * i.e. when no evidence item carries `excludeFromReport: true`.
 *
 * v4 exists only to stop a backup containing report-excluded evidence from
 * importing *quietly* into a pre-exclusion server: that server validates
 * `schemaVersion <= 3` and strips the `excludeFromReport` field it has never
 * heard of, which would recreate the evidence un-excluded and re-admit it to its
 * reports. Nothing else about the shape changed, so every export that carries no
 * excluded evidence keeps the older stamp and keeps importing there.
 */
export const FINDINGS_EXPORT_VERSION_WITHOUT_EXCLUSIONS = 3;

/*
 * A new *evidence type* deliberately gets no stamp of its own, even though a file
 * carrying `script` evidence will not import on a pre-script server.
 *
 * The conditional stamp above exists for the opposite failure mode: an unknown
 * *field*, which zod strips without a word, so the import succeeds while quietly
 * losing the meaning of what it imported. An unknown *enum value* is already
 * loud — `contentType` below is the closed `evidenceTypeSchema`, so an older
 * server refuses the whole file at parse time with an error naming the field and
 * the value. There is nothing silent left to make noisy.
 *
 * Nor could a bump make that refusal nicer on the servers a version stamp is
 * actually for — the already-deployed ones. The findings-import route parses the
 * envelope *before* it reads `schemaVersion` (`routes/web/report.ts`), so the zod
 * error wins the race whatever number the file carries.
 * `ENGAGEMENT_EXPORT_VERSION` gates its manifest first and so would surface a
 * version message instead, but that only trades one hard refusal for another —
 * not worth a second constant and a conditional in two writers. The fix for the
 * message, if it is ever wanted, belongs in the importer, not in the version.
 */

/** One evidence item inside an export. `contentBase64` is present only when the
 *  export was requested with `includeEvidenceContent` (makes it portable across
 *  servers); otherwise evidence is referenced by uuid + metadata only. */
export const exportedEvidenceSchema = z.object({
  uuid: uuidSchema,
  /** Evidence title (report v3+); defaults to empty for exports made before it existed. */
  title: z.string().default(''),
  description: z.string(),
  /** Closed enum on purpose — see the note above `exportedEvidenceSchema` about
   *  why a new evidence type needs no new export-version stamp. */
  contentType: evidenceTypeSchema,
  contentSubtype: z.string().nullable().optional(),
  originalFilename: z.string().nullable().optional(),
  occurredAt: isoDateSchema,
  contentBase64: z.string().optional(),
  /** Attack Path step caption for this link (empty for plain attached evidence). */
  caption: z.string().default(''),
  /** Which bucket the link belongs to: Attack Path (true) vs Attached Evidence (false). */
  inPath: z.boolean().default(false),
  /** Whether the evidence is excluded from report output — its own flag, or its
   *  parent's when it is linked evidence under an excluded capture, since the
   *  export carries no parent links to re-derive it from. Carried through so a
   *  round trip restores the exclusion, and defaults to false for exports made
   *  before the flag existed. Only a backup export (`includesExcludedEvidence`)
   *  can ever set it. */
  excludeFromReport: z.boolean().default(false),
});
export type ExportedEvidence = z.infer<typeof exportedEvidenceSchema>;

/** Per-finding evidence cap on import, so a crafted file can't create unbounded rows/blobs. */
export const MAX_IMPORT_EVIDENCE_PER_FINDING = 1000;
/** Total findings cap on import. */
export const MAX_IMPORT_FINDINGS = 5000;

export const exportedFindingSchema = z.object({
  uuid: uuidSchema,
  title: z.string().min(1).max(255),
  description: z.string(),
  /** Remediation guidance; defaults to empty for exports made before it existed. */
  remediation: z.string().default(''),
  category: z.string().nullable(),
  // Report v2 fields. All default so v1 exports (pre-v2) import cleanly.
  kind: findingKindSchema.default('weakness'),
  affectedTarget: z.string().default(''),
  impact: z.string().default(''),
  fixEffort: fixEffortSchema.default('none'),
  iso21434Refs: z.array(z.string()).default([]),
  unr155Refs: z.array(z.string()).default([]),
  severity: severitySchema.nullable(),
  cvssVector: z.string().nullable(),
  cvssScore: z.number().min(0).max(10).nullable(),
  readyToReport: z.boolean(),
  position: z.number().int().nonnegative(),
  evidence: z.array(exportedEvidenceSchema).max(MAX_IMPORT_EVIDENCE_PER_FINDING),
});
export type ExportedFinding = z.infer<typeof exportedFindingSchema>;

export const findingsExportSchema = z.object({
  schemaVersion: z.number().int().positive(),
  exportedAt: isoDateSchema,
  engagement: z.object({ slug: slugSchema, name: z.string() }),
  includesEvidenceContent: z.boolean(),
  /**
   * Whether this file was allowed to describe evidence flagged
   * `excludeFromReport` (the backup-export opt-in). False — the default, and what
   * every older file parses as — marks the file as a *report-filtered* view: the
   * importer then knows that an excluded item's absence means "withheld from this
   * export", not "unlinked from the finding", and leaves such links alone instead
   * of converging them away.
   */
  includesExcludedEvidence: z.boolean().default(false),
  findings: z.array(exportedFindingSchema).max(MAX_IMPORT_FINDINGS),
});
export type FindingsExport = z.infer<typeof findingsExportSchema>;

// ---------------------------------------------------------------------------
// Report branding (site-wide settings for generated PDFs)
// ---------------------------------------------------------------------------

/** Site-wide report branding, as returned to the web app. */
export const reportSettingsSchema = z.object({
  organizationName: z.string(),
  accentColor: z.string(),
  /** Inline data: URI for the cover logo (small PNG/SVG), or null for a text wordmark. */
  logoDataUri: z.string().nullable(),
  /** Optional confidentiality/footer line; null falls back to a sensible default. */
  footerNote: z.string().nullable(),
});
export type ReportSettings = z.infer<typeof reportSettingsSchema>;

/** Partial update of report branding (site admins only). */
export const updateReportSettingsInput = z.object({
  organizationName: z.string().min(1).max(120).optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex color')
    .optional(),
  // A data: URI (image/png|jpeg|svg+xml or webp). Capped ~1.5 MB of base64 so the
  // logo embeds in every PDF without bloating it. null clears it (text wordmark).
  logoDataUri: z
    .string()
    .max(1_500_000)
    .regex(/^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,/, 'must be an image data URI')
    .nullable()
    .optional(),
  footerNote: z.string().max(200).nullable().optional(),
});
export type UpdateReportSettingsInput = z.infer<typeof updateReportSettingsInput>;

// ---------------------------------------------------------------------------
// Report templates (site-wide library of named report configurations)
//
// The configuration shape itself is `reportTemplateConfigSchema`, up with the
// report-config block it derives from; these read/write shapes live down here
// because they reference `userSchema`, which is declared further down the file.
// ---------------------------------------------------------------------------

/**
 * A saved report template, as returned to the web app. Templates are global — any
 * engagement may apply one or generate with it — so there is no engagement slug on
 * this shape. `createdBy` is null once the author has been deleted (the template
 * survives the hard delete; the UI renders `DELETED_USER_LABEL`).
 */
export const reportTemplateSchema = z.object({
  uuid: uuidSchema,
  name: z.string(),
  description: z.string(),
  config: reportTemplateConfigSchema,
  createdBy: userSchema.pick({ slug: true, firstName: true, lastName: true }).nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type ReportTemplate = z.infer<typeof reportTemplateSchema>;

/**
 * Save a report configuration under a name. `name` is trimmed and unique
 * site-wide (a duplicate is a 409), since the name is the only thing that
 * distinguishes two templates in the Reports tab.
 */
export const createReportTemplateInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(''),
  config: reportTemplateConfigSchema,
});
export type CreateReportTemplateInput = z.infer<typeof createReportTemplateInput>;

/**
 * Rename a template, reword its description, or overwrite its configuration with
 * the one currently configured. Every field is optional; an absent field is left
 * as it was.
 */
export const updateReportTemplateInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  config: reportTemplateConfigSchema.optional(),
});
export type UpdateReportTemplateInput = z.infer<typeof updateReportTemplateInput>;

/** Outcome of importing a findings export into an engagement. */
export const findingsImportResult = z.object({
  findingsCreated: z.number().int().nonnegative(),
  findingsUpdated: z.number().int().nonnegative(),
  /** Findings skipped because their uuid already exists in another engagement. */
  findingsSkipped: z.number().int().nonnegative(),
  /** Evidence recreated from embedded base64 content. */
  evidenceCreated: z.number().int().nonnegative(),
  /** Evidence already present (by uuid) that was linked to the finding. */
  evidenceLinked: z.number().int().nonnegative(),
  /** Evidence skipped: no embedded content to recreate it, or a cross-engagement uuid. */
  evidenceSkipped: z.number().int().nonnegative(),
});
export type FindingsImportResult = z.infer<typeof findingsImportResult>;

// ---------------------------------------------------------------------------
// Full engagement export (the engagement `.zip` container)
//
// A *backup* of one whole engagement: everything the engagement owns, enough to
// recreate it on another reporter server. Deliberately separate from the findings
// export above (`findingsExportSchema`), which is a deliverable-shaped,
// findings-scoped file for moving findings between engagements — the two shapes
// and the two version constants are independent on purpose, so neither use case
// is held back by the other's compatibility story.
//
// The container is a ZIP rather than one JSON document because a real engagement
// carries screenshots and terminal recordings:
//
//   manifest.json      `engagementExportManifestSchema` — format, version, counts
//   engagement.json    `engagementExportSchema` — every record
//   blobs/<sha256>     evidence / thumbnail / report-artifact bytes, named by the
//                      lowercase hex sha-256 of their content
//
// Entry order is part of the format: the two JSON entries come first so a reader
// can validate the version and the records before inflating a single blob.
//
// How the pieces reference each other:
//  - the goal tree uses *file-local* keys (`t0`, `t0.a1`, `t0.a1.g2`). Those three
//    models (EngagementTarget / TargetActivity / ActivityGoal) have no uuid
//    column, and because an import always creates a NEW engagement, keys that are
//    unique within one file are enough — no schema migration is needed to make the
//    tree portable.
//  - evidence, findings, comments and generated reports carry their own `uuid`.
//  - tags are referenced by name (unique within an engagement).
//  - blobs are referenced by content hash, i.e. by the name of a `blobs/` entry.
//  - users are referenced by email only, and an import must never create one: an
//    unmatched email leaves the (nullable, `SET NULL`) author column null, which
//    already renders as the shared "Deleted user" label.
//
// Carries report-excluded evidence. A full engagement export is a backup, not a
// deliverable, so evidence flagged `excludeFromReport` travels with the flag
// intact and needs no `includeExcludedEvidence` opt-in — that opt-in exists on the
// findings export precisely because *that* file is deliverable-shaped and its
// default view is report-filtered.
// ---------------------------------------------------------------------------

/** Bump when the engagement-export shape changes incompatibly; import gates on it. */
export const ENGAGEMENT_EXPORT_VERSION = 1;

/** Marker in `manifest.json`, so a stray ZIP is rejected before anything is read. */
export const ENGAGEMENT_EXPORT_FORMAT = 'reporter-engagement-export';

/** ZIP entry holding the manifest — written first, readable without inflating the rest. */
export const ENGAGEMENT_EXPORT_MANIFEST_ENTRY = 'manifest.json';
/** ZIP entry holding every record (`engagementExportSchema`). */
export const ENGAGEMENT_EXPORT_DATA_ENTRY = 'engagement.json';
/** Prefix of the blob entries; the rest of the name is the content hash. */
export const ENGAGEMENT_EXPORT_BLOB_PREFIX = 'blobs/';

// Per-collection caps. They bound the work a crafted file can ask an import to do,
// and are set far above any real engagement; the writer validates its own output
// against them so an engagement that outgrows one fails loudly at export time
// rather than producing a file that only fails on the way back in. The findings
// caps are reused rather than restated.
export const MAX_ENGAGEMENT_EXPORT_TARGETS = 500;
export const MAX_ENGAGEMENT_EXPORT_ACTIVITIES_PER_TARGET = 500;
export const MAX_ENGAGEMENT_EXPORT_GOALS_PER_ACTIVITY = 1000;
/** Cap on each goal's evidence and finding link lists (matches `linkGoalEvidenceInput`). */
export const MAX_ENGAGEMENT_EXPORT_GOAL_LINKS = 500;
export const MAX_ENGAGEMENT_EXPORT_TAGS = 1000;
export const MAX_ENGAGEMENT_EXPORT_EVIDENCE = 50_000;
export const MAX_ENGAGEMENT_EXPORT_COMMENTS = 50_000;
export const MAX_ENGAGEMENT_EXPORT_CATEGORIES = 1000;
export const MAX_ENGAGEMENT_EXPORT_SAVED_QUERIES = 500;
export const MAX_ENGAGEMENT_EXPORT_GENERATED_REPORTS = 1000;

/**
 * A `blobs/` entry name minus its prefix: the lowercase hex sha-256 of the entry's
 * bytes. Content-addressed on purpose — identical blobs (the same screenshot
 * captured twice) collapse to one entry, and an importer can verify what it
 * inflated instead of trusting a length or a hash recorded elsewhere in the file.
 */
export const contentHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha-256 digest');

/**
 * A file-local key for a row that has no uuid: dot-separated segments, as in
 * `t0.a1.g2`. Only ever meaningful inside one export file.
 */
export const exportKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/, 'must be dot-separated alphanumeric segments');

/** A user reference inside an export: an email, matched against local accounts. */
const exportedUserEmailSchema = z.string().max(320).email().nullable().default(null);

/** One of the engagement's tags. Referenced from elsewhere in the file by `name`. */
export const exportedTagSchema = z.object({
  name: z.string().min(1).max(64),
  colorName: z.string(),
});
export type ExportedTag = z.infer<typeof exportedTagSchema>;

/**
 * A goal (ActivityGoal) with its links. `key` is file-local (see
 * {@link exportKeySchema}); the links name evidence and findings by uuid.
 */
export const exportedGoalSchema = z.object({
  key: exportKeySchema,
  title: z.string().min(1).max(500),
  status: goalStatusSchema,
  isRetest: z.boolean().default(false),
  notes: z.string().default(''),
  position: z.number().int().nonnegative(),
  /** Evidence linked to this goal (GoalEvidence), by evidence uuid. */
  evidenceUuids: z.array(uuidSchema).max(MAX_ENGAGEMENT_EXPORT_GOAL_LINKS).default([]),
  /** Findings linked to this goal (GoalFinding), by finding uuid. */
  findingUuids: z.array(uuidSchema).max(MAX_ENGAGEMENT_EXPORT_GOAL_LINKS).default([]),
});
export type ExportedGoal = z.infer<typeof exportedGoalSchema>;

/**
 * A testing activity (TargetActivity) and its goals. Its correlation tag travels
 * by name, not id, and is null when the activity had none (the column is
 * `SET NULL`, so a deleted tag already leaves it empty).
 */
export const exportedActivitySchema = z.object({
  key: exportKeySchema,
  name: z.string().min(1).max(255),
  category: z.string().default(''),
  tagName: z.string().max(64).nullable().default(null),
  position: z.number().int().nonnegative(),
  goals: z.array(exportedGoalSchema).max(MAX_ENGAGEMENT_EXPORT_GOALS_PER_ACTIVITY).default([]),
});
export type ExportedActivity = z.infer<typeof exportedActivitySchema>;

/** A scope target (EngagementTarget) — the top of the goal tree — and its activities. */
export const exportedTargetSchema = z.object({
  key: exportKeySchema,
  name: z.string().min(1).max(255),
  description: z.string().default(''),
  position: z.number().int().nonnegative(),
  activities: z
    .array(exportedActivitySchema)
    .max(MAX_ENGAGEMENT_EXPORT_ACTIVITIES_PER_TARGET)
    .default([]),
});
export type ExportedTarget = z.infer<typeof exportedTargetSchema>;

/**
 * One piece of evidence, with its blobs referenced by content hash.
 *
 * `Evidence.sha256` and `Evidence.sizeBytes` are deliberately absent: the full
 * blob's hash *is* that sha256, and its size is the length of the entry that was
 * actually inflated, so an import derives both from the bytes in front of it
 * rather than trusting numbers recorded next to them.
 */
export const exportedEngagementEvidenceSchema = z.object({
  uuid: uuidSchema,
  title: z.string().default(''),
  description: z.string().default(''),
  /** Closed enum, like the findings export's — see the note above
   *  `exportedEvidenceSchema` for why a new evidence type gets no version bump. */
  contentType: evidenceTypeSchema,
  /**
   * Unbounded on purpose: `createEvidenceInput.contentSubtype` is free text, so a
   * stored value can be any length and a bound here would make a legal engagement
   * impossible to back up. No field in this format may be stricter than the write
   * path that produced the row. (`originalFilename` below *is* bounded, because the
   * evidence service truncates it to 255 on the way in.)
   */
  contentSubtype: z.string().nullable().default(null),
  originalFilename: z.string().max(255).nullable().default(null),
  occurredAt: isoDateSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  /** `blobs/<hash>` holding the full content; null when there is none to carry. */
  fullBlobHash: contentHashSchema.nullable().default(null),
  /** `blobs/<hash>` holding the generated thumbnail (images only); null otherwise. */
  thumbBlobHash: contentHashSchema.nullable().default(null),
  /** The evidence's tags (EvidenceTag), by tag name. */
  tagNames: z.array(z.string().max(64)).max(MAX_ENGAGEMENT_EXPORT_TAGS).default([]),
  /** Parent capture when this is linked evidence (one level deep), else null. */
  parentEvidenceUuid: uuidSchema.nullable().default(null),
  /** Who captured it, by email. Unmatched on import → left null ("Deleted user"). */
  operatorEmail: exportedUserEmailSchema,
  /** Who last edited it, by email; null when never edited. */
  lastEditedByEmail: exportedUserEmailSchema,
  /** Carried with the evidence, so an import restores the exclusion rather than
   *  re-admitting the item to every report output. */
  excludeFromReport: z.boolean().default(false),
});
export type ExportedEngagementEvidence = z.infer<typeof exportedEngagementEvidenceSchema>;

/**
 * A plain-text discussion comment (EvidenceComment) — internal notes, never part
 * of a report, but part of a backup. Flat rather than nested under the evidence so
 * the evidence block stays one row per capture.
 */
export const exportedEvidenceCommentSchema = z.object({
  uuid: uuidSchema,
  /** The evidence this comment hangs off. */
  evidenceUuid: uuidSchema,
  authorEmail: exportedUserEmailSchema,
  body: z.string(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type ExportedEvidenceComment = z.infer<typeof exportedEvidenceCommentSchema>;

/**
 * A finding category (FindingCategory). Carried as its own list, not merely as the
 * name on each finding, so an unused category — or one that was soft-deleted —
 * survives the round trip.
 */
export const exportedFindingCategorySchema = z.object({
  /**
   * Unbounded for the same reason as `contentSubtype` above: a finding's `category`
   * is free text on create/update and is upserted into `FindingCategory` verbatim,
   * so the stored name has no length limit to inherit.
   */
  category: z.string().min(1),
  /** Soft-delete marker; a deleted category stays hidden after an import. */
  deletedAt: isoDateSchema.nullable().default(null),
});
export type ExportedFindingCategory = z.infer<typeof exportedFindingCategorySchema>;

/**
 * One evidence↔finding link (EvidenceFinding): which bucket it sits in
 * (`inPath` — Attack Path vs Attached Evidence), where in that bucket, and the
 * Attack Path step caption.
 */
export const exportedEvidenceLinkSchema = z.object({
  evidenceUuid: uuidSchema,
  position: z.number().int().nonnegative(),
  caption: z.string().default(''),
  inPath: z.boolean().default(false),
});
export type ExportedEvidenceLink = z.infer<typeof exportedEvidenceLinkSchema>;

/**
 * A finding, with its evidence links. Its category travels by name (resolved
 * against `findingCategories`), and it keeps its uuid so the engagement's
 * `strategicRecommendations[].findingUuids` can be remapped on import.
 */
export const exportedEngagementFindingSchema = z.object({
  uuid: uuidSchema,
  title: z.string().min(1).max(255),
  description: z.string().default(''),
  kind: findingKindSchema,
  affectedTarget: z.string().default(''),
  impact: z.string().default(''),
  fixEffort: fixEffortSchema,
  iso21434Refs: z.array(z.string().max(120)).max(100).default([]),
  unr155Refs: z.array(z.string().max(120)).max(100).default([]),
  remediation: z.string().default(''),
  /** Resolved against `findingCategories` by exact name; unbounded, as there. */
  category: z.string().nullable().default(null),
  severity: severitySchema.nullable().default(null),
  cvssVector: z.string().nullable().default(null),
  cvssScore: z.number().min(0).max(10).nullable().default(null),
  readyToReport: z.boolean().default(false),
  position: z.number().int().nonnegative(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  evidenceLinks: z
    .array(exportedEvidenceLinkSchema)
    .max(MAX_IMPORT_EVIDENCE_PER_FINDING)
    .default([]),
});
export type ExportedEngagementFinding = z.infer<typeof exportedEngagementFindingSchema>;

/** A saved timeline/findings query (SavedQuery). */
export const exportedSavedQuerySchema = z.object({
  name: z.string().min(1).max(255),
  query: z.string(),
  type: savedQueryTypeSchema,
});
export type ExportedSavedQuery = z.infer<typeof exportedSavedQuerySchema>;

/**
 * One entry of the engagement's report history (GeneratedReport), including the
 * stored deliverable's bytes as a `blobs/` entry. As with evidence, the recorded
 * `sha256`/`sizeBytes` are not carried — they are derived from the entry.
 */
export const exportedGeneratedReportSchema = z.object({
  uuid: uuidSchema,
  preset: reportPresetSchema,
  label: z.string(),
  version: z.string(),
  format: generatedReportFormatSchema,
  summary: reportSummarySchema,
  generatedByEmail: exportedUserEmailSchema,
  createdAt: isoDateSchema,
  /** The stored artifact, by content hash; null for rows recorded before artifact
   *  storage existed (`downloadable: false`) or whose blob could not be read. */
  artifactBlobHash: contentHashSchema.nullable().default(null),
  filename: z.string().max(255).nullable().default(null),
  contentType: z.string().max(255).nullable().default(null),
});
export type ExportedGeneratedReport = z.infer<typeof exportedGeneratedReportSchema>;

/**
 * The engagement row itself, including every JSON column. Two of those columns
 * hold uuid cross-references into the rest of the file and MUST be remapped on
 * import — `strategicRecommendations[].findingUuids` and
 * `executionNarrative[].evidence[].evidenceUuid`. Both are rendered with
 * skip-if-dangling semantics, so a missed remap reports a successful import and
 * silently empties those parts of the report. `executionNarrative[].timeline.tags`
 * also references other rows, but by tag *name*, which an import preserves.
 *
 * `slug` and `name` describe the source engagement. An import always creates a new
 * engagement and derives its own unique slug, so the slug here is provenance, not
 * an address.
 */
export const exportedEngagementSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(255),
  status: engagementStatusSchema,
  createdAt: isoDateSchema,
  startedAt: isoDateSchema,
  projectedEndAt: isoDateSchema.nullable().default(null),
  actualEndAt: isoDateSchema.nullable().default(null),
  // Report metadata (Settings → report cover/front matter).
  clientName: z.string().nullable().default(null),
  assessmentType: z.string().nullable().default(null),
  testApproach: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  scope: z.string().nullable().default(null),
  executiveSummary: z.string().nullable().default(null),
  methodology: z.string().nullable().default(null),
  objectivesNarrative: z.string().nullable().default(null),
  // Watermark settings.
  watermarkEnabled: z.boolean().default(true),
  watermarkText: z.string().nullable().default(null),
  watermarkColor: z.string().nullable().default(null),
  watermarkOpacity: watermarkOpacitySchema,
  watermarkLayer: watermarkLayerSchema,
  // Structured report content — every JSON column on the engagement, reusing the
  // item schemas that validate them on write rather than restating their fields.
  scopeTargets: z.array(scopeTargetSchema).default([]),
  scopeExclusions: z.array(z.string()).default([]),
  strategicRecommendations: z.array(recommendationItemSchema).default([]),
  threatModelNarrative: z.string().nullable().default(null),
  threatModelDiagrams: z.array(threatDiagramSchema).default([]),
  executionNarrative: z.array(executionSubsectionSchema).default([]),
  providerContacts: z.array(contactSchema).default([]),
  clientContacts: z.array(contactSchema).default([]),
  softwareTested: z.array(softwareItemSchema).default([]),
  thirdPartySoftware: z.array(softwareItemSchema).default([]),
  reportConfig: reportConfigSchema,
  /**
   * The last imported proposal, verbatim, exactly as the column stores it — kept
   * for provenance, never interpreted here. Opaque rather than
   * `proposalSchema`-shaped because the column is deliberately raw: re-validating
   * it would drop fields a future proposal format adds. Absent when there is none.
   */
  proposalImport: z.unknown(),
});
export type ExportedEngagement = z.infer<typeof exportedEngagementSchema>;

/** Row counts in an export, so `manifest.json` describes the file's size cheaply. */
export const engagementExportCountsSchema = z.object({
  targets: z.number().int().nonnegative(),
  activities: z.number().int().nonnegative(),
  goals: z.number().int().nonnegative(),
  tags: z.number().int().nonnegative(),
  evidence: z.number().int().nonnegative(),
  evidenceComments: z.number().int().nonnegative(),
  findingCategories: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  savedQueries: z.number().int().nonnegative(),
  generatedReports: z.number().int().nonnegative(),
  /** Distinct `blobs/` entries, and their total inflated size. */
  blobs: z.number().int().nonnegative(),
  blobBytes: z.number().int().nonnegative(),
});
export type EngagementExportCounts = z.infer<typeof engagementExportCountsSchema>;

/**
 * `manifest.json` — the first entry in the container. It exists so a reader can
 * identify the format, check the version and see how big the import will be
 * *before* inflating anything: yauzl's central-directory access makes reading one
 * small entry cheap, and an unsupported version or an implausible size can then be
 * rejected without touching a blob.
 */
export const engagementExportManifestSchema = z.object({
  format: z.literal(ENGAGEMENT_EXPORT_FORMAT),
  schemaVersion: z.number().int().positive(),
  exportedAt: isoDateSchema,
  /** The source engagement's identity — provenance; the import picks its own slug. */
  engagement: z.object({ slug: slugSchema, name: z.string() }),
  counts: engagementExportCountsSchema,
});
export type EngagementExportManifest = z.infer<typeof engagementExportManifestSchema>;

/**
 * `engagement.json` — every record in the export. Collections are flat lists in
 * dependency order; the goal tree is the one nested block, because its file-local
 * keys are derived from that nesting.
 */
export const engagementExportSchema = z.object({
  schemaVersion: z.number().int().positive(),
  exportedAt: isoDateSchema,
  engagement: exportedEngagementSchema,
  tags: z.array(exportedTagSchema).max(MAX_ENGAGEMENT_EXPORT_TAGS).default([]),
  targets: z.array(exportedTargetSchema).max(MAX_ENGAGEMENT_EXPORT_TARGETS).default([]),
  evidence: z
    .array(exportedEngagementEvidenceSchema)
    .max(MAX_ENGAGEMENT_EXPORT_EVIDENCE)
    .default([]),
  evidenceComments: z
    .array(exportedEvidenceCommentSchema)
    .max(MAX_ENGAGEMENT_EXPORT_COMMENTS)
    .default([]),
  findingCategories: z
    .array(exportedFindingCategorySchema)
    .max(MAX_ENGAGEMENT_EXPORT_CATEGORIES)
    .default([]),
  findings: z.array(exportedEngagementFindingSchema).max(MAX_IMPORT_FINDINGS).default([]),
  savedQueries: z
    .array(exportedSavedQuerySchema)
    .max(MAX_ENGAGEMENT_EXPORT_SAVED_QUERIES)
    .default([]),
  generatedReports: z
    .array(exportedGeneratedReportSchema)
    .max(MAX_ENGAGEMENT_EXPORT_GENERATED_REPORTS)
    .default([]),
});
export type EngagementExport = z.infer<typeof engagementExportSchema>;

/**
 * Optional overrides a caller may send alongside the uploaded archive.
 *
 * Note what is *absent*: there is no field naming an engagement to import into.
 * An import always creates a new engagement — the route has no `:slug` — so the
 * only thing a caller can influence is how the new engagement is named.
 */
export const engagementImportInput = z.object({
  /** Name for the new engagement; defaults to the source engagement's name. */
  name: z.string().min(1).max(255).optional(),
  /**
   * Slug for the new engagement. Omitted, the file's slug is uniquified; supplied
   * and already taken, the import fails rather than silently landing elsewhere.
   */
  slug: slugSchema.optional(),
});
export type EngagementImportInput = z.infer<typeof engagementImportInput>;

/** Row counts actually created, so a caller can report more than "done". */
export const engagementImportCreatedSchema = z.object({
  targets: z.number().int().nonnegative(),
  activities: z.number().int().nonnegative(),
  goals: z.number().int().nonnegative(),
  tags: z.number().int().nonnegative(),
  evidence: z.number().int().nonnegative(),
  evidenceComments: z.number().int().nonnegative(),
  findingCategories: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  /** Evidence↔finding links (Attack Path + attached evidence). */
  evidenceLinks: z.number().int().nonnegative(),
  goalEvidenceLinks: z.number().int().nonnegative(),
  goalFindingLinks: z.number().int().nonnegative(),
  savedQueries: z.number().int().nonnegative(),
  generatedReports: z.number().int().nonnegative(),
  /** Blob-store objects written, and their total size. */
  blobs: z.number().int().nonnegative(),
  blobBytes: z.number().int().nonnegative(),
});
export type EngagementImportCreated = z.infer<typeof engagementImportCreatedSchema>;

/**
 * Everything the import deliberately did NOT carry over. Reported rather than
 * logged so the UI can be honest: all of these are silent at render time, which is
 * exactly why they have to be surfaced here.
 */
export const engagementImportDroppedSchema = z.object({
  /** Exported author emails with no local account (distinct, capped). */
  unmatchedAuthorEmails: z.array(z.string()).default([]),
  /** Author columns left null because of the above. */
  unmatchedAuthorRefs: z.number().int().nonnegative(),
  /** Tag names referenced by evidence or activities that the file never defines. */
  unknownTagRefs: z.number().int().nonnegative(),
  /** Evidence uuids referenced by something in the file that defines no such evidence. */
  danglingEvidenceRefs: z.number().int().nonnegative(),
  /** Finding uuids referenced by something in the file that defines no such finding. */
  danglingFindingRefs: z.number().int().nonnegative(),
  /** Link/name rows collapsed because the file listed the same pair twice. */
  duplicates: z.number().int().nonnegative(),
});
export type EngagementImportDropped = z.infer<typeof engagementImportDroppedSchema>;

/** What an import created, rewrote and dropped — the import route's response. */
export const engagementImportResultSchema = z.object({
  /** The engagement that was created — never one that already existed. */
  engagement: z.object({ slug: slugSchema, name: z.string() }),
  /** Where it came from (the file's own identity) — provenance, not an address. */
  source: z.object({ slug: slugSchema, name: z.string(), exportedAt: z.string() }),
  created: engagementImportCreatedSchema,
  /**
   * The uuid cross-references rewritten to the new rows' uuids. Surfaced because
   * both are skip-if-dangling at render time: a count of zero where the report
   * content referenced rows is the only visible sign that a remap went wrong.
   */
  remapped: z.object({
    recommendationFindingRefs: z.number().int().nonnegative(),
    narrativeEvidenceRefs: z.number().int().nonnegative(),
  }),
  dropped: engagementImportDroppedSchema,
});
export type EngagementImportResult = z.infer<typeof engagementImportResultSchema>;
