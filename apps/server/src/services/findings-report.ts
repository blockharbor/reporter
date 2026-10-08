/**
 * Findings report generation: a portable JSON export (also the import format)
 * and a self-contained, Block Harbor house-style HTML document rendered to PDF
 * by the report route.
 *
 * The JSON export and the per-finding evidence in the PDF share one gather step
 * so both describe the same findings in the same order. Evidence order follows
 * the per-finding manual order (EvidenceFinding.position).
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  DELETED_USER_LABEL,
  EVIDENCE_GROUPING_LABELS,
  EVIDENCE_TYPE_LABELS,
  FINDINGS_EXPORT_VERSION,
  FINDINGS_EXPORT_VERSION_WITHOUT_EXCLUSIONS,
  FIX_EFFORT_LABELS,
  GOAL_STATUS_LABELS,
  REPORT_SECTION_LABELS,
  SEVERITY_LABELS,
  SEVERITY_RANK,
  evidenceFileExtension,
  executionTimelineConfigSchema,
  isEvidenceType,
  iso21434Ref,
  unr155Ref,
  tagColor,
  type Contact,
  type EngagementProgress,
  type EvidenceGrouping,
  type ExecutionSubsection,
  type ExecutionTimelineConfig,
  type FindingGrouping,
  type FindingsExport,
  type FindingKind,
  type FixEffort,
  type ParsedQuery,
  type RecommendationItem,
  type ReportCustomSection,
  type ReportSectionEntry,
  type ReportSummary,
  type ScopeTarget,
  type Severity,
  type SoftwareItem,
  type StandardRef,
  type Target,
  type ThreatDiagram,
} from '@reporter/shared';
import { evidenceContentMime } from '../routes/shared-evidence.js';
import { buildEvidenceWhere } from '../helpers/timeline-filter.js';
import { REPORT_VISIBLE_EVIDENCE } from '../helpers/report-visibility.js';
import { fetchGoalsTree, progressFromTree } from './goals.js';
import { getReportSettings } from './report-settings.js';
import {
  FONT_LINKS,
  WATERMARK_OPACITY_VALUES,
  esc,
  prose,
  reportCss,
  watermarkCss,
  watermarkFontSize,
  watermarkMarkup,
} from './report-style.js';

interface GatheredEvidence {
  uuid: string;
  title: string;
  description: string;
  contentType: string;
  contentSubtype: string | null;
  originalFilename: string | null;
  occurredAt: Date;
  fullBlobKey: string | null;
  /** Attack Path step caption for this link (empty for plain attached evidence). */
  caption: string;
  /** Which bucket the link is in: Attack Path (true) vs Attached Evidence (false). */
  inPath: boolean;
  /**
   * The evidence's *effective* report exclusion: its own flag, or its parent's
   * when it is linked evidence hanging off an excluded capture (see
   * {@link REPORT_VISIBLE_EVIDENCE} for why exclusion is inherited). False for
   * everything a `report-safe` gather returns (that scope filters excluded
   * evidence out in the query); only a `full-backup` gather — the JSON export's
   * explicit opt-in — can return `true` here.
   *
   * It is the effective value rather than the stored column because this is what
   * an export writes, and an import can only restore it onto the row itself: the
   * export carries no parent links, so an inherited exclusion would otherwise be
   * lost on restore and the evidence would re-enter reports on the target server.
   * See {@link EvidenceScope}.
   */
  excludeFromReport: boolean;
}

interface GatheredFinding {
  uuid: string;
  title: string;
  description: string;
  kind: FindingKind;
  affectedTarget: string;
  impact: string;
  fixEffort: FixEffort;
  iso21434Refs: string[];
  unr155Refs: string[];
  remediation: string;
  category: string | null;
  severity: Severity | null;
  cvssVector: string | null;
  cvssScore: number | null;
  readyToReport: boolean;
  position: number;
  evidence: GatheredEvidence[];
  /**
   * How many of the finding's evidence links `gather` dropped because the
   * evidence is flagged `excludeFromReport`. When this is non-zero `evidence` is
   * a partial view of the finding, so the report must stay silent about evidence
   * rather than assert the finding has none — see {@link renderFinding}.
   *
   * It is a count of what was *filtered out*, not of what is flagged: a
   * `full-backup` gather filters nothing, so it reports 0 even though the
   * evidence it returns may be flagged. That is the value the one consumer
   * needs — "nothing is missing from this list" — and it leaves the PDF path's
   * behaviour unchanged, since the PDF only ever gathers `report-safe`.
   */
  excludedEvidenceCount: number;
}

export interface ReportOptions {
  /** Include every finding; otherwise only `readyToReport` findings. */
  includeAll?: boolean;
  /** How the Assessment Execution evidence timeline is organized. */
  evidenceGroup?: EvidenceGrouping;
  /**
   * How findings are organized in the Assessment Findings + Detailed Findings
   * sections: `severity` (default flat list), `category`, or `target`.
   */
  findingGroup?: FindingGrouping;
  /** Include the hand-authored Assessment Execution narrative (default true). */
  includeNarrative?: boolean;
  /** Include the Assessment Execution auto evidence timeline (default false). */
  includeTimeline?: boolean;
  /** Include the Severity & CVSS reference appendix. */
  includeAppendix?: boolean;
  /**
   * Ordered, toggleable content sections (from a saved report config). When set,
   * this drives section order/enablement and supersedes the boolean flags above
   * (`includeNarrative`/`includeTimeline`/`includeAppendix` are ignored). When
   * absent, the report renders in the fixed default order using those flags — the
   * historical behavior.
   */
  sections?: ReportSectionEntry[];
  /** Free-text custom sections referenced by `custom:<id>` keys in `sections`. */
  customSections?: ReportCustomSection[];
  /**
   * Render a single section's HTML for the on-screen Configure preview instead of
   * the full report document: only this section key is rendered (forced enabled,
   * using its `sections` sub-item options), wrapped in the report stylesheet with
   * no cover / details / TOC / watermark. See {@link buildReportHtml}.
   */
  previewSectionKey?: string;
  /**
   * Sanitize: show each evidence item's capture timestamp in the evidence log's
   * `when` label. When omitted, the historical behavior (shown) applies; the
   * config-driven report routes pass the saved value, whose schema default is
   * hidden — so a configured report hides timestamps unless the author opts in.
   */
  showEvidenceTimestamps?: boolean;
  /**
   * Sanitize: show each evidence item's operator (capturer) name in the evidence
   * log's `who` label. Same default semantics as {@link showEvidenceTimestamps}.
   */
  showEvidenceOperators?: boolean;
  /**
   * Number the Assessment Execution subsection titles (1., 2., 3.) in the order
   * they already render. A labelling change only — it reorders nothing and never
   * numbers individual evidence items. Omitted means off, matching the config
   * schema's `false` default, so an unconfigured report keeps the unnumbered
   * headings it has always had. See {@link renderExecutionNarrative}.
   */
  numberExecutionSubsections?: boolean;
}

export interface JsonExportOptions extends ReportOptions {
  /** Embed evidence blob content as base64 (makes the export portable). */
  includeEvidenceContent?: boolean;
  /**
   * Opt in to exporting evidence flagged `excludeFromReport`, with the flag set,
   * so the JSON file is a complete backup of the findings: an export → import
   * round trip restores the evidence *and* its exclusion instead of dropping it.
   *
   * Default (and the only thing any other code path can produce) is off, in which
   * case excluded evidence never leaves the server. This option lives here, on the
   * JSON-export options only, and NOT on {@link ReportOptions} — see
   * {@link EvidenceScope} for why that separation is load-bearing.
   */
  includeExcludedEvidence?: boolean;
}

/**
 * Which evidence a {@link gather} call is allowed to load:
 *
 * - `report-safe` — evidence the report may not show ({@link
 *   REPORT_VISIBLE_EVIDENCE}) is dropped in the query, so its title/description/
 *   blob key are never even read. Every report output (PDF, supporting-files ZIP,
 *   Files Attached table, timeline subsections, Evidence Log, cover counts, goal
 *   coverage) and the default JSON export.
 * - `full-backup` — excluded evidence is loaded and carries `excludeFromReport:
 *   true`. Reachable only from {@link buildFindingsExport} when the caller
 *   explicitly set `includeExcludedEvidence`.
 *
 * This is a separate parameter of `gather` rather than a field on
 * {@link ReportOptions} on purpose. `ReportOptions` objects are built once per
 * request and handed around (`reportOptionsFromQuery`, `reportOptionsFromConfig`,
 * `reportFor`, report history), and `JsonExportOptions extends ReportOptions`, so
 * a field there could ride along into {@link buildReportHtml} or
 * {@link computeReportSummary} and quietly widen a PDF. A PDF caller cannot
 * express the scope at all: it passes options and nothing else, and the default
 * is `report-safe`. The safety invariant is therefore a property of the
 * signatures, not of a convention someone has to remember.
 */
type EvidenceScope = 'report-safe' | 'full-backup';

interface EngagementRef {
  id: number;
  slug: string;
  name: string;
}

/**
 * Load the report's findings (filtered + ordered) with their ordered evidence.
 *
 * `scope` decides whether report-excluded evidence is readable at all; it
 * deliberately is not part of `opts` (see {@link EvidenceScope}) and defaults to
 * the safe value, so every caller that just passes options gets the filtered view.
 */
async function gather(
  app: FastifyInstance,
  eng: EngagementRef,
  opts: ReportOptions,
  scope: EvidenceScope = 'report-safe',
): Promise<GatheredFinding[]> {
  const findings = await app.db.finding.findMany({
    where: { engagementId: eng.id, ...(opts.includeAll ? {} : { readyToReport: true }) },
    include: {
      category: true,
      // Attack Path first (inPath=true), then Attached Evidence, each ordered by
      // its own position. The export/report split the flat list back by `inPath`.
      //
      // Evidence the report may not show is dropped here, in the query, so its
      // title/description/blob key are never even loaded. This single query feeds
      // both the PDF's finding blocks and the JSON export, so one filter keeps the
      // exclusion honored in both — only an explicit `full-backup` scope lifts it.
      evidence: {
        ...(scope === 'report-safe' ? { where: { evidence: REPORT_VISIBLE_EVIDENCE } } : {}),
        orderBy: [{ inPath: 'desc' }, { position: 'asc' }, { evidenceId: 'asc' }],
        // The parent's flag comes along so the gathered item can state its
        // *effective* exclusion (see `GatheredEvidence.excludeFromReport`); no
        // render path reads it, only the export.
        include: { evidence: { include: { parent: { select: { excludeFromReport: true } } } } },
      },
      // The unfiltered link count, so `excludedEvidenceCount` below is exact
      // without loading the excluded rows we just refused to read. (Under
      // `full-backup` it equals the rows loaded, so that count comes out 0.)
      _count: { select: { evidence: true } },
    },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });

  return findings.map((f) => ({
    uuid: f.uuid,
    title: f.title,
    description: f.description,
    kind: f.kind,
    affectedTarget: f.affectedTarget,
    impact: f.impact,
    fixEffort: f.fixEffort,
    iso21434Refs: (f.iso21434Refs as unknown as string[]) ?? [],
    unr155Refs: (f.unr155Refs as unknown as string[]) ?? [],
    remediation: f.remediation,
    category: f.category?.category ?? null,
    severity: f.severity,
    cvssVector: f.cvssVector,
    cvssScore: f.cvssScore,
    readyToReport: f.readyToReport,
    position: f.position,
    excludedEvidenceCount: f._count.evidence - f.evidence.length,
    evidence: f.evidence.map((link) => ({
      uuid: link.evidence.uuid,
      title: link.evidence.title,
      description: link.evidence.description,
      contentType: link.evidence.contentType,
      contentSubtype: link.evidence.contentSubtype,
      originalFilename: link.evidence.originalFilename,
      occurredAt: link.evidence.occurredAt,
      fullBlobKey: link.evidence.fullBlobKey,
      caption: link.caption,
      inPath: link.inPath,
      excludeFromReport:
        link.evidence.excludeFromReport || (link.evidence.parent?.excludeFromReport ?? false),
    })),
  }));
}

/**
 * Snapshot the findings tallies behind a report, using the same `gather` (and
 * thus the same `includeAll` filter) the PDF does, so the numbers a report shows
 * match the numbers recorded in its history entry and quoted in an attestation
 * letter. Counts are weaknesses-only (strengths carry no severity); `none` is
 * the informational band. `overallRisk` seeds the letter and defaults to the
 * highest severity present — the assessor can override it when issuing a letter.
 */
export async function computeReportSummary(
  app: FastifyInstance,
  eng: EngagementRef,
  opts: ReportOptions,
): Promise<ReportSummary> {
  const findings = await gather(app, eng, opts);
  const weaknesses = findings.filter((f) => f.kind === 'weakness');
  const strengths = findings.filter((f) => f.kind === 'strength');

  // Weakness counts by severity. Unrated weaknesses fold into the informational
  // (`none`) band so the five columns always sum to the weakness total — the
  // attestation letter's results table and its "identified N weaknesses" intro
  // then agree.
  const bySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    none: 0,
  };
  for (const f of weaknesses) bySeverity[f.severity ?? 'none']++;

  // The single most-severe rated weakness (ties broken by CVSS score). The
  // letter's "highest-rated weakness carried a severity of X (Label)" sentence
  // must quote ONE finding, so its severity label and CVSS score come from this
  // same finding — never a label from one weakness paired with a score from
  // another (a manual Critical with no score alongside a scored High would
  // otherwise print "8.9 (Critical)").
  let top: GatheredFinding | null = null;
  for (const f of weaknesses) {
    if (!f.severity) continue;
    if (
      !top ||
      SEVERITY_RANK[f.severity] > SEVERITY_RANK[top.severity!] ||
      (SEVERITY_RANK[f.severity] === SEVERITY_RANK[top.severity!] &&
        (f.cvssScore ?? -1) > (top.cvssScore ?? -1))
    ) {
      top = f;
    }
  }
  const highestSeverity = top?.severity ?? null;
  const highestCvss = top?.cvssScore ?? null;

  return {
    findingsTotal: findings.length,
    weaknessesTotal: weaknesses.length,
    strengthsTotal: strengths.length,
    bySeverity,
    highestCvss,
    highestSeverity,
    overallRisk: highestSeverity,
  };
}

// ---------------------------------------------------------------------------
// JSON export (report.json) — also the import envelope
// ---------------------------------------------------------------------------

/**
 * Build the portable JSON export — the findings and their linked evidence (not
 * the whole engagement: goals, tags, report content and unlinked evidence stay
 * behind). Two modes, picked by `opts.includeExcludedEvidence`:
 *
 * - default — a report-shaped export: report-excluded evidence is filtered out by
 *   `gather` and never leaves the server, exactly like the PDF. The envelope says
 *   so (`includesExcludedEvidence: false`) so an importer knows the file is a
 *   filtered view and must not treat it as the whole truth about a finding's
 *   evidence — see `importFindings`.
 * - opt-in — a complete backup of the findings: excluded evidence is included and
 *   states `excludeFromReport: true`, so importing the file elsewhere restores
 *   both the evidence and its exclusion.
 */
export async function buildFindingsExport(
  app: FastifyInstance,
  eng: EngagementRef,
  exportedAt: Date,
  opts: JsonExportOptions,
): Promise<FindingsExport> {
  // The single place the backup scope is reachable from: an explicit option on the
  // JSON-export options, translated here into the `gather` parameter no
  // report-rendering caller can pass.
  const findings = await gather(
    app,
    eng,
    opts,
    opts.includeExcludedEvidence ? 'full-backup' : 'report-safe',
  );

  const out: FindingsExport['findings'] = [];
  for (const f of findings) {
    const evidence: FindingsExport['findings'][number]['evidence'] = [];
    for (const e of f.evidence) {
      const item: FindingsExport['findings'][number]['evidence'][number] = {
        uuid: e.uuid,
        title: e.title,
        description: e.description,
        // The one place a `contentType` cast stands rather than being narrowed with
        // `isEvidenceType` (see {@link evidenceTypeLabel}), because there is nothing
        // to narrow *to*: the export schema's field is a closed enum, so an unknown
        // value has no representable substitute, and neither available alternative
        // is better than the cast. Re-labelling it (`'none'`) would silently
        // mis-describe evidence in a file used as a backup, and throwing would fail
        // a whole export over one row. The column can only hold a validated value
        // anyway — every write path (`createEvidence`, both importers) parses it
        // through `evidenceTypeSchema` first.
        contentType: e.contentType as (typeof evidence)[number]['contentType'],
        contentSubtype: e.contentSubtype,
        originalFilename: e.originalFilename,
        occurredAt: e.occurredAt.toISOString(),
        caption: e.caption,
        inPath: e.inPath,
        // The effective exclusion. Under the default scope `gather` has already
        // dropped every excluded item, so this is false throughout; under the
        // opt-in backup scope it is the real value, and `true` is how
        // `importFindings` knows to re-exclude the evidence it recreates rather
        // than re-admitting it to every report output.
        excludeFromReport: e.excludeFromReport,
      };
      if (opts.includeEvidenceContent && e.fullBlobKey) {
        const buf = await app.blobs.getBuffer(e.fullBlobKey).catch(() => null);
        if (buf) item.contentBase64 = buf.toString('base64');
      }
      evidence.push(item);
    }
    out.push({
      uuid: f.uuid,
      title: f.title,
      description: f.description,
      kind: f.kind,
      affectedTarget: f.affectedTarget,
      impact: f.impact,
      fixEffort: f.fixEffort,
      iso21434Refs: f.iso21434Refs,
      unr155Refs: f.unr155Refs,
      remediation: f.remediation,
      category: f.category,
      severity: f.severity,
      cvssVector: f.cvssVector,
      cvssScore: f.cvssScore,
      readyToReport: f.readyToReport,
      position: f.position,
      evidence,
    });
  }

  // Whether this file is allowed to describe report-excluded evidence. Two
  // readers depend on it:
  //
  // - `importFindings`, to decide which finding links the file may detach. A
  //   default export is a *filtered* view, so it must not be read as "these are
  //   all the links this finding has".
  // - an older server, which doesn't know the field at all — hence the version
  //   stamp below.
  const carriesExcludedEvidence = out.some((f) => f.evidence.some((e) => e.excludeFromReport));

  return {
    // Only a file that actually carries report-excluded evidence is stamped with
    // the newer version. A pre-exclusion server accepts `schemaVersion <= 3` and
    // strips the `excludeFromReport` field it has never heard of, so importing
    // such a file there would silently re-admit the evidence to its reports;
    // stamping 4 makes it fail loudly instead. Every other export — including an
    // opted-in backup of an engagement that happens to have nothing excluded —
    // stays at 3 and keeps importing on older servers.
    schemaVersion: carriesExcludedEvidence
      ? FINDINGS_EXPORT_VERSION
      : FINDINGS_EXPORT_VERSION_WITHOUT_EXCLUSIONS,
    exportedAt: exportedAt.toISOString(),
    engagement: { slug: eng.slug, name: eng.name },
    includesEvidenceContent: Boolean(opts.includeEvidenceContent),
    includesExcludedEvidence: Boolean(opts.includeExcludedEvidence),
    findings: out,
  };
}

// ---------------------------------------------------------------------------
// HTML report (rendered to PDF) — Block Harbor house style
// ---------------------------------------------------------------------------

/** Severity ordering, most → least severe, used to sort findings and dashboards. */
const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'none'];

/** A severity pill using the CVSS-band color classes from the stylesheet. */
function severityPill(sev: Severity | null, score: number | null): string {
  if (!sev) return '<span class="pill pill-sev-none">Unrated</span>';
  const label = SEVERITY_LABELS[sev];
  const scoreTxt = score != null ? ` ${score.toFixed(1)}` : '';
  return `<span class="pill pill-sev-${sev}">${esc(label)}${esc(scoreTxt)}</span>`;
}

/** A small tag chip using the shared tag palette. */
function tagChip(name: string, colorName: string): string {
  const c = tagColor(colorName);
  return `<span class="chip" style="background:${c.light};color:${c.fg}">${esc(name)}</span>`;
}

/** Format a date as e.g. "August 18, 2026" (UTC, locale-independent). */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export function longDate(d: Date | null | undefined): string {
  if (!d) return '—';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function shortDateTime(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day} ${hh}:${mm}Z`;
}

// Memory bounds so a report with huge evidence can't exhaust the server:
// skip embedding any single image over the per-image cap, and stop embedding
// once the whole report's embedded base64 exceeds the total budget. The budget
// is shared across finding evidence AND the timeline for the whole document.
const IMAGE_EMBED_CAP = 8 * 1024 * 1024; // 8 MB per image
const TOTAL_EMBED_CAP = 64 * 1024 * 1024; // ~64 MB of base64 across the report

interface Budget {
  remaining: number;
}

/**
 * The fields {@link renderEvidence} actually reads — a structural subset of
 * {@link GatheredEvidence}, so the evidence log (whose items are
 * {@link TimelineEvidence}) can render a body without inventing values for the
 * fields it doesn't have. In particular it never has to claim a value for
 * `excludeFromReport`, which only the gather queries are entitled to decide —
 * and whose value now depends on the gather's {@link EvidenceScope}, so a render
 * path reading it would be reading an answer to a question it didn't ask.
 */
type RenderableEvidence = Pick<
  GatheredEvidence,
  'title' | 'description' | 'contentType' | 'contentSubtype' | 'fullBlobKey'
>;

/**
 * The evidence-type label for a stored `contentType`, falling back to the raw
 * column value for a type this build doesn't know. `contentType` is a plain TEXT
 * column, so it is narrowed rather than cast: casting a string into the
 * exhaustive label map would hand back `undefined` for an unknown value and
 * silently print it, which is exactly how a newly added type goes unnoticed.
 */
function evidenceTypeLabel(contentType: string): string {
  return isEvidenceType(contentType) ? EVIDENCE_TYPE_LABELS[contentType] : contentType;
}

/**
 * How an embedded evidence body may render. These are the Assessment Execution
 * section's display sub-items (`typeCaptions`, `scriptBodies` in
 * `REPORT_SECTION_ITEMS`); every other render site — finding attack paths and
 * attached evidence — renders with {@link FULL_EVIDENCE_DISPLAY}, because those
 * belong to the Detailed Findings section and have toggles of their own.
 */
interface EvidenceDisplay {
  /**
   * Render the content-type caption ("Script", "Screenshot", …). This is only
   * ever the *fallback* caption, used when the item has no title or description
   * of its own — a caption the author actually wrote is never suppressed.
   */
  typeCaptions: boolean;
  /** Render a script's contents inline; off, a one-line artifact stub replaces it. */
  scriptBodies: boolean;
  /**
   * Blob key → `supporting-files/` entry name, from the one
   * {@link gatherSupportingFiles} list the ZIP is also built from. Read only by
   * the suppressed-script stub, so it can name the file the reader is being sent
   * to instead of a second, independently derived name that could disagree.
   */
  artifactNames: ReadonlyMap<string, string>;
}

/** Everything on — the default outside the Assessment Execution section. */
const FULL_EVIDENCE_DISPLAY: EvidenceDisplay = {
  typeCaptions: true,
  scriptBodies: true,
  // Never consulted: the stub is only reachable with `scriptBodies: false`.
  artifactNames: new Map(),
};

/** Render one piece of evidence to HTML, loading its blob if needed. */
async function renderEvidence(
  app: FastifyInstance,
  e: RenderableEvidence,
  budget: Budget,
  display: EvidenceDisplay = FULL_EVIDENCE_DISPLAY,
): Promise<string> {
  // The item's own words win; the content-type label is the fallback, and that
  // fallback is what `typeCaptions: false` drops — so the caption line can come
  // out empty here, and every branch below has to cope with having none.
  const own = e.title || e.description;
  const caption = esc(own || (display.typeCaptions ? evidenceTypeLabel(e.contentType) : ''));
  const captionTag = caption ? `<figcaption>${caption}</figcaption>` : '';
  /** The caption alone, for the branches that have no body to hang it under. */
  const captionOnly = caption ? `<div class="ev"><p class="ev-note">${caption}</p></div>` : '';

  // Never read a terminal recording — casts can be large and can't render
  // statically in a PDF. Reference it instead of pulling the blob into memory.
  if (e.contentType === 'terminal-recording') {
    return `<div class="ev"><p class="ev-note"><span class="play">▶</span> Terminal recording — view in reporter.</p>${captionTag}</div>`;
  }

  // Scripts as artifacts only: the body is replaced by a one-line pointer rather
  // than dropped, modelled on the terminal-recording line above. Silence is not
  // an option here — the script is still swept into `supporting-files/` and still
  // listed, with its SHA-256, in the Files Attached table, so omitting it would
  // leave the reader a hash for a file the document never mentions (and a
  // PDF-only download with no ZIP beside it would lose the script entirely).
  // The blob is not read at all on this path.
  if (e.contentType === 'script' && !display.scriptBodies) {
    const entry = e.fullBlobKey ? display.artifactNames.get(e.fullBlobKey) : undefined;
    // The marker reuses the stylesheet's single marker class (`.play`) with a
    // shell prompt in place of the play triangle; the report CSS is not part of
    // this feature, so no new class is introduced for it.
    const where = entry
      ? ` — provided as <span class="mono">supporting-files/${esc(entry)}</span> with this report.`
      : ' — view in reporter.';
    return `<div class="ev"><p class="ev-note"><span class="play">$</span> Script${where}</p>${captionTag}</div>`;
  }

  const buf = e.fullBlobKey ? await app.blobs.getBuffer(e.fullBlobKey).catch(() => null) : null;

  if (e.contentType === 'image') {
    if (!buf) return captionOnly;
    if (buf.length > IMAGE_EMBED_CAP || buf.length > budget.remaining) {
      const mb = (buf.length / (1024 * 1024)).toFixed(1);
      return `<div class="ev"><p class="ev-note">Screenshot (${mb} MB) — too large to embed; view in reporter.</p>${captionTag}</div>`;
    }
    const mime = evidenceContentMime('image', buf);
    const b64 = buf.toString('base64');
    budget.remaining -= b64.length;
    // `alt` describes the image for a screen reader rather than printing on the
    // page, so it keeps the type label even when the visible caption is off.
    const alt = caption || esc(evidenceTypeLabel(e.contentType));
    return `<figure class="ev"><img src="data:${mime};base64,${b64}" alt="${alt}" />${captionTag}</figure>`;
  }
  if (buf) {
    let text = buf.toString('utf8');
    if (text.length > 20000) text = text.slice(0, 20000) + '\n… (truncated)';
    const lang = e.contentSubtype ? `<span class="ev-lang">${esc(e.contentSubtype)}</span>` : '';
    // The language/interpreter chip is a property of the content, not the
    // type-label caption, so it survives `typeCaptions: false` on its own line.
    // Joined rather than concatenated, so a suppressed caption does not leave a
    // `<figcaption>` that opens with a stray space.
    const capText = [caption, lang].filter(Boolean).join(' ');
    const capLine = capText ? `<figcaption>${capText}</figcaption>` : '';
    // Notes, events, and code blocks are authored as markdown (the Add-evidence
    // "Content" field is a markdown editor with a Preview tab), so render them the
    // same way here — the PDF then matches that preview. Scripts are deliberately
    // NOT in this list: a shell script's `#!/bin/bash` is a shebang, not an `<h1>`.
    // HTTP (HAR JSON) and any other blob stays verbatim in a <pre> too.
    if (e.contentType === 'none' || e.contentType === 'event' || e.contentType === 'codeblock') {
      const body = prose(text) || '<p class="ev-note">(No content.)</p>';
      return `<div class="ev">${capLine}${body}</div>`;
    }
    return `<div class="ev">${capLine}<pre class="ev-code">${esc(text)}</pre></div>`;
  }
  return captionOnly;
}

/** Render one numbered Attack Path step: its caption (if any) then its evidence. */
async function renderPathStep(
  app: FastifyInstance,
  e: GatheredEvidence,
  step: number,
  budget: Budget,
): Promise<string> {
  const captionHtml = e.caption ? `<p class="step-caption">${esc(e.caption)}</p>` : '';
  const evidenceHtml = await renderEvidence(app, e, budget);
  return `<div class="step"><p class="step-label">Step ${step}</p>${captionHtml}${evidenceHtml}</div>`;
}

/** Render a finding's mapped standards references as prose lines (empty if none). */
function standardsBlock(iso: string[], unr: string[]): string {
  const fmt = (ids: string[], lookup: (id: string) => StandardRef | undefined): string =>
    ids
      .map((id) => {
        const r = lookup(id);
        return r ? `${esc(r.clause)} — ${esc(r.label)}` : esc(id);
      })
      .join('; ');
  const parts: string[] = [];
  if (iso.length)
    parts.push(`<p class="pp"><strong>ISO/SAE 21434:</strong> ${fmt(iso, iso21434Ref)}</p>`);
  if (unr.length) parts.push(`<p class="pp"><strong>UN R155:</strong> ${fmt(unr, unr155Ref)}</p>`);
  return parts.length ? `<h4 class="sub">Standards Mapping</h4>${parts.join('')}` : '';
}

/** Which detail sub-blocks of a finding card to render (per the section config). */
interface FindingParts {
  impact: boolean;
  standards: boolean;
  remediation: boolean;
  recommendations: boolean;
  attackPath: boolean;
  attachedEvidence: boolean;
}
/** All finding sub-blocks on — the default when a report isn't section-configured. */
const ALL_FINDING_PARTS: FindingParts = {
  impact: true,
  standards: true,
  remediation: true,
  recommendations: true,
  attackPath: true,
  attachedEvidence: true,
};

/** A strategic recommendation cross-referenced from the finding it addresses. */
interface LinkedRecommendation {
  /** The recommendation's global 1-based number (R1, R2, …). */
  num: number;
  title: string;
}

/**
 * Render one weakness's detailed subsection (heading, meta, description, impact,
 * standards mapping, remediation, evidence). `label` is the cross-reference id
 * (e.g. "W1"). `parts` gates the optional sub-blocks (Detailed Findings section
 * toggles). Strengths are summary-table only and never rendered here.
 */
async function renderFinding(
  app: FastifyInstance,
  f: GatheredFinding,
  label: string,
  budget: Budget,
  parts: FindingParts = ALL_FINDING_PARTS,
  linkedRecs: LinkedRecommendation[] = [],
): Promise<string> {
  // Split into the two buckets. `gather` already orders Attack Path first, each
  // bucket by its own position, so filtering preserves the intended order.
  //
  // Report-excluded evidence is already absent from `f.evidence`, so the Attack
  // Path steps below are numbered off these positions and therefore renumber
  // contiguously (Step 1, Step 2, …). That is deliberate: leaving a gap where an
  // excluded step used to be would advertise the omission to the client.
  const pathEvidence = f.evidence.filter((e) => e.inPath);
  const attachedEvidence = f.evidence.filter((e) => !e.inPath);

  const meta: string[] = [];
  meta.push(`<strong>Category:</strong> ${f.category ? esc(f.category) : 'Uncategorized'}`);
  if (f.affectedTarget.trim())
    meta.push(`<strong>Affected target:</strong> ${esc(f.affectedTarget)}`);
  if (f.cvssScore != null) meta.push(`<strong>CVSS:</strong> ${f.cvssScore.toFixed(1)}`);
  if (f.cvssVector) meta.push(`<code>${esc(f.cvssVector)}</code>`);
  if (f.fixEffort && f.fixEffort !== 'none')
    meta.push(`<strong>Fix effort:</strong> ${esc(FIX_EFFORT_LABELS[f.fixEffort])}`);

  const descHtml = prose(f.description) || '<p class="pp muted">No description provided.</p>';
  const impactHtml =
    parts.impact && f.impact.trim() ? `<h4 class="sub">Impact</h4>${prose(f.impact)}` : '';
  const standardsHtml = parts.standards ? standardsBlock(f.iso21434Refs, f.unr155Refs) : '';
  const remediationHtml =
    parts.remediation && f.remediation.trim()
      ? `<h4 class="sub">Remediation</h4>${prose(f.remediation)}`
      : '';
  const recsHtml =
    parts.recommendations && linkedRecs.length > 0
      ? `<h4 class="sub">Related Recommendations</h4><ul class="rec-links">${linkedRecs
          .map((r) => `<li><strong>R${r.num}</strong> — ${esc(r.title)}</li>`)
          .join('')}</ul>`
      : '';

  // Render evidence sequentially so at most one blob is held in memory at once.
  let pathHtml = '';
  if (parts.attackPath && pathEvidence.length > 0) {
    const steps: string[] = [];
    for (let s = 0; s < pathEvidence.length; s++) {
      steps.push(await renderPathStep(app, pathEvidence[s]!, s + 1, budget));
    }
    pathHtml = `<h4 class="sub">Attack Path (${pathEvidence.length})</h4><div class="path">${steps.join('\n')}</div>`;
  }

  const showAttached = parts.attachedEvidence && attachedEvidence.length > 0;
  const attachedParts: string[] = [];
  if (showAttached) {
    for (const e of attachedEvidence) attachedParts.push(await renderEvidence(app, e, budget));
  }
  const attachedHtml = showAttached
    ? `<h4 class="sub">Attached Evidence (${attachedEvidence.length})</h4>${attachedParts.join('\n')}`
    : // Only claim "no evidence" when the finding genuinely has none. Two things
      // can empty the buckets while the finding does have evidence: a section
      // toggle hiding a bucket, or `gather` dropping evidence flagged
      // `excludeFromReport`. In both cases the invariant is the same — the report
      // prints nothing, because "No evidence attached." would be a false statement
      // in a signed client deliverable.
      pathEvidence.length === 0 && attachedEvidence.length === 0 && f.excludedEvidenceCount === 0
      ? '<p class="pp muted">No evidence attached.</p>'
      : '';

  return `
    <div class="finding">
      <div class="finding-head">
        <span class="finding-num">${esc(label)}</span>
        <span class="finding-title">${esc(f.title)}</span>
        ${severityPill(f.severity, f.cvssScore)}
      </div>
      <p class="finding-meta">${meta.join('<span class="sep">·</span>')}</p>
      <h4 class="sub">Description</h4>
      ${descHtml}
      ${impactHtml}
      ${standardsHtml}
      ${remediationHtml}
      ${recsHtml}
      ${pathHtml}
      ${attachedHtml}
    </div>`;
}

/**
 * Operator (capturer) display name for the evidence log's `who` label. A deleted
 * user gets the shared stand-in — the report names the gap rather than inventing a
 * name — while `Unknown` stays the fallback for a live user with blank names.
 */
function operatorLabel(operator: { firstName: string; lastName: string } | null): string {
  if (!operator) return DELETED_USER_LABEL;
  return `${operator.firstName} ${operator.lastName}`.trim() || 'Unknown';
}

interface TimelineEvidence {
  uuid: string;
  title: string;
  description: string;
  contentType: string;
  contentSubtype: string | null;
  occurredAt: Date;
  fullBlobKey: string | null;
  operatorName: string;
  tags: { name: string; colorName: string }[];
}

/**
 * Everything the Assessment Execution render path may show for one evidence
 * item: the two sanitize toggles, which are top-level report options, plus the
 * section's own display sub-items ({@link EvidenceDisplay}, read off the
 * section entry's `options` map). One object so the narrative and timeline
 * subsection paths cannot be handed different answers.
 */
interface EvidenceMetaVisibility extends EvidenceDisplay {
  timestamps: boolean;
  operators: boolean;
  /**
   * Render the item's tag chips. Tags are only ever rendered *here*, in a
   * timeline subsection — a narrative subsection embeds hand-picked figures and
   * has never printed their tags — so this flag has no effect anywhere else.
   */
  tags: boolean;
}

/** Render a single timeline evidence item (when / who / desc / tags / body). */
async function renderTimelineItem(
  app: FastifyInstance,
  e: TimelineEvidence,
  budget: Budget,
  show: EvidenceMetaVisibility,
): Promise<string> {
  const tags =
    show.tags && e.tags.length
      ? `<div class="tl-tags">${e.tags.map((t) => tagChip(t.name, t.colorName)).join('')}</div>`
      : '';
  const title = e.title.trim() ? `<p class="tl-title">${esc(e.title)}</p>` : '';
  const desc = e.description.trim() ? `<p class="tl-desc">${esc(e.description)}</p>` : '';
  const body = await renderEvidence(
    app,
    {
      // Title/description render as the item's heading + snippet above, so the
      // embedded body caption falls back to the content-type label — which is
      // precisely what `show.typeCaptions` gates.
      title: '',
      description: '',
      contentType: e.contentType,
      contentSubtype: e.contentSubtype,
      fullBlobKey: e.fullBlobKey,
    },
    budget,
    show,
  );
  const whenTag = show.timestamps
    ? `<span class="tl-when">${shortDateTime(e.occurredAt)}</span>`
    : '';
  const whoTag = show.operators ? `<span class="tl-who">${esc(e.operatorName)}</span>` : '';
  const meta = whenTag || whoTag ? `<div>${whenTag}${whoTag}</div>` : '';
  return `
    <div class="tl-item">
      ${meta}
      ${title}
      ${desc}
      ${tags}
      <div class="tl-body">${body}</div>
    </div>`;
}

/** Build the Assessment Execution section, grouped per the chosen strategy. */
async function renderTimeline(
  app: FastifyInstance,
  items: TimelineEvidence[],
  group: EvidenceGrouping,
  budget: Budget,
  show: EvidenceMetaVisibility,
): Promise<string> {
  if (items.length === 0)
    return '<p class="pp muted">No evidence recorded for this engagement.</p>';

  if (group === 'chronological') {
    const parts: string[] = [];
    for (const e of items) parts.push(await renderTimelineItem(app, e, budget, show));
    return parts.join('\n');
  }

  // Build ordered groups. For `tag`, an item appears under each of its tags
  // (and "Untagged" when it has none). For `type`, under its content-type label.
  const groups = new Map<string, TimelineEvidence[]>();
  const order: string[] = [];
  const push = (key: string, e: TimelineEvidence) => {
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
      order.push(key);
    }
    arr.push(e);
  };

  if (group === 'tag') {
    for (const e of items) {
      if (e.tags.length === 0) push('Untagged', e);
      else for (const t of e.tags) push(t.name, e);
    }
    order.sort((a, b) => (a === 'Untagged' ? 1 : b === 'Untagged' ? -1 : a.localeCompare(b)));
  } else {
    for (const e of items) {
      push(evidenceTypeLabel(e.contentType), e);
    }
    order.sort((a, b) => a.localeCompare(b));
  }

  const sections: string[] = [];
  for (const key of order) {
    const arr = groups.get(key)!;
    const parts: string[] = [];
    for (const e of arr) parts.push(await renderTimelineItem(app, e, budget, show));
    sections.push(
      `<h3 class="group-head">${esc(key)} <span class="group-count">(${arr.length})</span></h3>${parts.join('\n')}`,
    );
  }
  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Supporting files (non-screenshot evidence) — powers the ZIP bundle and the
// "Files Attached" table. Screenshots are embedded in the PDF, so excluded here.
// ---------------------------------------------------------------------------

export interface SupportingFileMeta {
  /** Unique, human-friendly filename used both in the table and the ZIP entry. */
  filename: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  blobKey: string;
}

function slugifyName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Derive a readable filename for a supporting file (original name wins). */
function synthesizeFilename(e: {
  originalFilename: string | null;
  title: string;
  description: string;
  contentType: string;
  contentSubtype: string | null;
  uuid: string;
}): string {
  if (e.originalFilename && e.originalFilename.trim()) {
    return e.originalFilename.split(/[\\/]/).pop()!.trim().slice(0, 120) || e.uuid;
  }
  const base = slugifyName(e.title) || slugifyName(e.description) || e.contentType || 'evidence';
  // Per-type default, overridden by the recorded language/interpreter where that
  // makes sense — so a script filed as Python lands as `.py` and the client can
  // run it with the right thing. The whole rule (including the historical
  // raw-token behaviour for a codeblock, which keeps names in already-delivered
  // archives stable) lives in `@reporter/shared`, next to the type list itself.
  const ext = evidenceFileExtension(e.contentType, e.contentSubtype);
  return `${base}-${e.uuid.slice(0, 8)}${ext}`;
}

/**
 * Gather the engagement's non-screenshot evidence that has stored content, name
 * each file (deduping collisions), and compute a SHA-256 for integrity. The
 * result feeds both the ZIP bundle and the "Files Attached" table so they list
 * exactly the same files. Deterministic ordering keeps names stable across calls.
 */
export async function gatherSupportingFiles(
  app: FastifyInstance,
  eng: { id: number },
): Promise<SupportingFileMeta[]> {
  const rows = await app.db.evidence.findMany({
    where: {
      engagementId: eng.id,
      contentType: { not: 'image' },
      fullBlobKey: { not: null },
      // This is the path an exclusion leaks hardest on: it sweeps the whole
      // engagement (not just finding-linked evidence) and ships raw bytes in the
      // ZIP plus a SHA-256 in the Files Attached table, so excluded evidence must
      // never make it into the set — including linked evidence whose parent is
      // excluded, which this sweep would otherwise ship on its own.
      ...REPORT_VISIBLE_EVIDENCE,
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      uuid: true,
      title: true,
      description: true,
      contentType: true,
      contentSubtype: true,
      originalFilename: true,
      fullBlobKey: true,
      sha256: true,
      sizeBytes: true,
    },
  });
  const used = new Set<string>();
  const out: SupportingFileMeta[] = [];
  for (const r of rows) {
    if (!r.fullBlobKey) continue;
    let sha256 = r.sha256;
    let sizeBytes = r.sizeBytes;
    // Stored at upload for new evidence (no blob read needed). Legacy evidence has
    // no stored hash — compute it from the blob on demand, and skip the item if the
    // blob can't be read so the table matches what the ZIP can actually bundle.
    if (sha256 == null || sizeBytes == null) {
      const buf = await app.blobs.getBuffer(r.fullBlobKey).catch(() => null);
      if (!buf) continue;
      sha256 = createHash('sha256').update(buf).digest('hex');
      sizeBytes = buf.length;
    }
    let name = synthesizeFilename(r);
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`.toLowerCase())) n++;
      name = `${stem}-${n}${ext}`;
    }
    used.add(name.toLowerCase());
    out.push({
      filename: name,
      sha256,
      sizeBytes,
      contentType: r.contentType,
      blobKey: r.fullBlobKey,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section builders for the new report content (all reuse existing CSS classes)
// ---------------------------------------------------------------------------

/** Service Scope (target → subsystems) + Scope Exclusions, as red-header tables. */
function renderScope(targets: ScopeTarget[], exclusions: string[]): string {
  const parts: string[] = [];
  const validTargets = targets.filter((t) => t.name.trim());
  if (validTargets.length) {
    const rows = validTargets
      .map((t) => {
        const subs = t.subsystems
          .filter((s) => s.trim())
          .map((s) => esc(s))
          .join('<br>');
        return `<tr><td class="title">${esc(t.name)}</td><td>${subs || '—'}</td></tr>`;
      })
      .join('');
    parts.push(
      `<h3 class="block-h">Service Scope</h3><table class="tbl"><thead><tr><th>Target</th><th>In scope</th></tr></thead><tbody>${rows}</tbody></table>`,
    );
  }
  const validExclusions = exclusions.filter((s) => s.trim());
  if (validExclusions.length) {
    const rows = validExclusions.map((s) => `<tr><td>${esc(s)}</td></tr>`).join('');
    parts.push(
      `<h3 class="block-h">Scope Exclusions</h3><table class="tbl"><thead><tr><th>Out of scope</th></tr></thead><tbody>${rows}</tbody></table>`,
    );
  }
  return parts.join('');
}

/** Summary of Strengths table (IDs S1, S2, …). Empty string when none. */
function renderStrengthsTable(strengths: GatheredFinding[]): string {
  if (strengths.length === 0) return '';
  const rows = strengths
    .map(
      (f, i) => `
      <tr>
        <td class="num">S${i + 1}</td>
        <td class="title">${esc(f.title)}</td>
        <td>${esc(f.description) || esc(f.affectedTarget) || '—'}</td>
      </tr>`,
    )
    .join('');
  return `<h3 class="block-h">Summary of Strengths</h3>
    <table class="tbl"><thead><tr><th class="num">#</th><th>Strength</th><th>Description</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/** An ordered run of weaknesses under an optional group heading. */
interface WeaknessGroup {
  /** Group heading, or null for an ungrouped (severity) run with no header. */
  label: string | null;
  findings: GatheredFinding[];
}

/**
 * Arrange the (already severity-sorted) weaknesses into display groups. `severity`
 * is a single unlabeled run (the historical flat list); `category` / `target`
 * bucket by that field — buckets ordered alphabetically with the catch-all
 * ("Uncategorized" / "Unspecified") last, and each bucket stays severity-sorted.
 */
function groupWeaknesses(weaknesses: GatheredFinding[], group: FindingGrouping): WeaknessGroup[] {
  if (group === 'severity') return [{ label: null, findings: weaknesses }];
  const fallback = group === 'category' ? 'Uncategorized' : 'Unspecified';
  const keyOf = (f: GatheredFinding): string =>
    (group === 'category' ? f.category : f.affectedTarget)?.trim() || fallback;
  const buckets = new Map<string, GatheredFinding[]>();
  for (const f of weaknesses) {
    const k = keyOf(f);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(f);
    else buckets.set(k, [f]);
  }
  return [...buckets.keys()]
    .sort((a, b) => (a === fallback ? 1 : b === fallback ? -1 : a.localeCompare(b)))
    .map((label) => ({ label, findings: buckets.get(label)! }));
}

/**
 * Summary of Weaknesses table (IDs W1, W2, … assigned across the flattened group
 * order so they line up with the Detailed Findings and TOC). Group headings are
 * inserted as spanning rows when the findings are grouped by category/target.
 */
function renderWeaknessesTable(groups: WeaknessGroup[]): string {
  const total = groups.reduce((n, g) => n + g.findings.length, 0);
  const head = `<h3 class="block-h">Summary of Weaknesses</h3>
    <table class="tbl"><thead><tr><th class="num">#</th><th>Weakness</th><th>Category</th><th>Severity</th><th class="num">CVSS</th><th>Fix effort</th></tr></thead>`;
  if (total === 0) {
    return `${head}<tbody><tr><td colspan="6" class="muted">No weaknesses to report.</td></tr></tbody></table>`;
  }
  const rows: string[] = [];
  let n = 0;
  for (const g of groups) {
    if (g.label !== null) {
      rows.push(
        `<tr class="row-group"><td colspan="6">${esc(g.label)} <span class="group-count">(${g.findings.length})</span></td></tr>`,
      );
    }
    for (const f of g.findings) {
      n++;
      rows.push(`<tr>
        <td class="num">W${n}</td>
        <td class="title">${esc(f.title)}</td>
        <td>${esc(f.category || 'Uncategorized')}</td>
        <td>${severityPill(f.severity, null)}</td>
        <td class="num">${f.cvssScore != null ? f.cvssScore.toFixed(1) : '—'}</td>
        <td>${f.fixEffort && f.fixEffort !== 'none' ? esc(FIX_EFFORT_LABELS[f.fixEffort]) : '—'}</td>
      </tr>`);
    }
  }
  return `${head}<tbody>${rows.join('')}</tbody></table>`;
}

/** Strategic Recommendations table (IDs R1, R2, …). Empty string when none. */
function renderRecommendationsTable(recs: RecommendationItem[]): string {
  const valid = recs.filter((r) => r.title.trim());
  if (valid.length === 0) return '';
  const rows = valid
    .map(
      (r, i) =>
        `<tr><td class="num">R${i + 1}</td><td class="title">${esc(r.title)}</td><td>${esc(r.description) || '—'}</td></tr>`,
    )
    .join('');
  return `<h3 class="block-h">Strategic Recommendations</h3>
    <table class="tbl"><thead><tr><th class="num">#</th><th>Recommendation</th><th>Description</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/** Standards Traceability matrix: each finding → its ISO/SAE 21434 + UN R155 clauses. */
function renderStandardsTraceability(
  items: { label: string; title: string; iso: string[]; unr: string[] }[],
): string {
  const mapped = items.filter((it) => it.iso.length || it.unr.length);
  if (mapped.length === 0) return '';
  const clauses = (ids: string[], lookup: (id: string) => StandardRef | undefined): string =>
    ids.map((id) => esc(lookup(id)?.clause ?? id)).join(', ') || '—';
  const rows = mapped
    .map(
      (it) => `
      <tr>
        <td class="num">${esc(it.label)}</td>
        <td class="title">${esc(it.title)}</td>
        <td>${clauses(it.iso, iso21434Ref)}</td>
        <td>${clauses(it.unr, unr155Ref)}</td>
      </tr>`,
    )
    .join('');
  return `<h3 class="block-h">Standards Traceability</h3>
    <p class="pp muted">Findings mapped to ISO/SAE 21434 work products and UN R155 requirements. Full titles appear on each detailed finding.</p>
    <table class="tbl"><thead><tr><th class="num">#</th><th>Finding</th><th>ISO/SAE 21434</th><th>UN R155</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/** Threat Model narrative + diagram figures. Empty string when there's nothing. */
function renderThreatModel(
  narrative: string | null,
  diagrams: ThreatDiagram[],
  budget: Budget,
): string {
  const narr = narrative?.trim() ? prose(narrative) : '';
  const figs: string[] = [];
  diagrams.forEach((d, i) => {
    if (!d.imageDataUri) return;
    const approxBytes = d.imageDataUri.length;
    if (approxBytes > budget.remaining) return; // over the shared embed budget — skip
    budget.remaining -= approxBytes;
    const cap = d.caption?.trim() ? esc(d.caption) : `Figure ${i + 1}`;
    figs.push(
      `<figure class="ev"><img src="${esc(d.imageDataUri)}" alt="${cap}" /><figcaption>${cap}</figcaption></figure>`,
    );
  });
  return narr + figs.join('\n');
}

/** Provider/client contact list for the Engagement Details grid. */
function renderContacts(contacts: Contact[]): string {
  const valid = contacts.filter((c) => c.name.trim() || c.email.trim() || c.title.trim());
  if (valid.length === 0) return '<div class="person"><div class="rl muted">—</div></div>';
  return valid
    .map((c) => {
      const nm = esc([c.name, c.title].filter((s) => s.trim()).join(' — ')) || '—';
      const em = c.email.trim() ? `<div class="rl">${esc(c.email)}</div>` : '';
      return `<div class="person"><div class="nm">${nm}</div>${em}</div>`;
    })
    .join('');
}

/** A software (name/version) table for Supporting Information. Empty when none. */
function renderSoftwareTable(title: string, items: SoftwareItem[]): string {
  const valid = items.filter((s) => s.name.trim());
  if (valid.length === 0) return '';
  const rows = valid
    .map((s) => `<tr><td class="title">${esc(s.name)}</td><td>${esc(s.version) || '—'}</td></tr>`)
    .join('');
  return `<h3 class="block-h">${esc(title)}</h3>
    <table class="tbl"><thead><tr><th>Software</th><th>Version</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Files Attached table (name + SHA-256), matching the ZIP bundle exactly. */
function renderFilesAttached(files: SupportingFileMeta[]): string {
  if (files.length === 0) return '';
  const rows = files
    .map(
      (f, i) =>
        `<tr><td class="num">${i + 1}</td><td class="title">${esc(f.filename)}</td><td class="mono" style="word-break:break-all">${esc(f.sha256)}</td></tr>`,
    )
    .join('');
  return `<h3 class="block-h">Files Attached</h3>
    <p class="pp muted">Supporting files accompanying this report (included in the ZIP export). SHA-256 hashes are provided for integrity verification.</p>
    <table class="tbl"><thead><tr><th class="num">#</th><th>Filename</th><th>SHA-256</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * Scope & Objectives Coverage: per-target tables of activities → goals with each
 * goal's status and the count of linked findings/evidence, plus a coverage lede.
 * Driven by the engagement's goals tree (Target → Activity → Goal).
 */
function renderScopeCoverage(targets: Target[], progress: EngagementProgress): string {
  if (targets.length === 0) return '<p class="pp muted">No scope targets recorded.</p>';
  const retest = '<span class="chip" style="background:#c99a00;color:#1a1400">Retest</span> ';
  const naNote = progress.notApplicable ? ` (${progress.notApplicable} N/A)` : '';
  const parts: string[] = [
    `<p class="lede">${progress.complete} of ${progress.total} goals complete${naNote} — ${progress.percent}% coverage.</p>`,
  ];
  for (const t of targets) {
    const rows: string[] = [];
    for (const a of t.activities) {
      const actLabel = `${esc(a.name)}${a.category ? ` <span class="muted">· ${esc(a.category)}</span>` : ''}`;
      if (a.goals.length === 0) {
        rows.push(
          `<tr><td class="title">${actLabel}</td><td class="muted">No goals defined</td><td>—</td><td class="num">—</td></tr>`,
        );
        continue;
      }
      for (const g of a.goals) {
        rows.push(
          `<tr><td class="title">${actLabel}</td><td>${g.isRetest ? retest : ''}${esc(g.title)}</td><td>${esc(GOAL_STATUS_LABELS[g.status])}</td><td class="num">${g.numFindings} / ${g.numEvidence}</td></tr>`,
        );
      }
    }
    const body = rows.length
      ? rows.join('')
      : '<tr><td colspan="4" class="muted">No activities recorded.</td></tr>';
    const desc = t.description.trim() ? `<p class="pp muted">${esc(t.description)}</p>` : '';
    parts.push(
      `<h3 class="block-h">${esc(t.name)}</h3>${desc}<table class="tbl"><thead><tr><th>Activity</th><th>Goal</th><th>Status</th><th class="num">Findings / Evidence</th></tr></thead><tbody>${body}</tbody></table>`,
    );
  }
  return parts.join('');
}

/** A free-text custom report section (title + prose body). */
function renderCustomSection(section: ReportCustomSection): string {
  return section.body.trim() ? prose(section.body) : '<p class="pp muted">No content.</p>';
}

/**
 * Load and map the evidence for a `timeline`-kind execution subsection into the
 * `TimelineEvidence` shape, reusing the same `buildEvidenceWhere` semantics as the
 * interactive Evidence tab so a subsection's filters mean exactly what they do
 * there. `starred` is resolved against `userId` (the report's author).
 */
async function gatherSubsectionTimeline(
  app: FastifyInstance,
  engagementId: number,
  userId: number,
  cfg: ExecutionTimelineConfig,
): Promise<TimelineEvidence[]> {
  const parsed: ParsedQuery = {
    text: [],
    tags: cfg.tags,
    operators: [],
    types: cfg.types,
    dateRanges: [],
    uuids: [],
    starred: cfg.starredOnly ? true : undefined,
    // "Include comments" off (default) hides comment evidence, like the tab's
    // "Hide comments"; on leaves the constraint unset so comments are included.
    noComments: cfg.includeComments ? undefined : true,
    sortAsc: true,
  };
  const where = buildEvidenceWhere(parsed, engagementId, userId);
  const rows = await app.db.evidence.findMany({
    // The report-only exclusion is layered on here rather than inside
    // `buildEvidenceWhere`: that helper is shared with the interactive Evidence
    // tab, where excluded evidence deliberately stays visible (badged) so it can
    // be un-excluded. Both halves are nested in one `AND` so neither can shadow
    // the other's top-level `OR`.
    where: { AND: [where, REPORT_VISIBLE_EVIDENCE] },
    include: { tags: { include: { tag: true } }, operator: true },
    orderBy: { occurredAt: 'asc' },
  });
  return rows.map((e) => ({
    uuid: e.uuid,
    title: e.title,
    description: e.description,
    contentType: e.contentType,
    contentSubtype: e.contentSubtype,
    occurredAt: e.occurredAt,
    fullBlobKey: e.fullBlobKey,
    operatorName: operatorLabel(e.operator),
    tags: e.tags.map((t) => ({ name: t.tag.name, colorName: t.tag.colorName })),
  }));
}

/**
 * Assessment Execution subsections. A `narrative` subsection renders its titled
 * prose + hand-embedded evidence; a `timeline` subsection renders a filtered,
 * grouped view of the engagement's captured evidence (see `ExecutionTimelineConfig`).
 *
 * `number` prefixes each subsection's hand-authored title with its 1-based
 * position ("1. Infotainment head unit"). The prefix is built once, above the
 * per-kind branch, because both kinds emit the same `<h3 class="block-h">` and
 * the counter has to run across them in document order — numbering them
 * separately would restart or interleave the sequence. Nothing else in the
 * document numbers a heading's *text* (section numbers live in their own
 * `.sec-num` span, findings in `W1`/`S1`/`R1` cells, attack-path steps in a
 * `.step-label`), so "1." cannot collide with an existing scheme.
 *
 * It is done inline rather than with a CSS counter: `h3.block-h` is shared with
 * a dozen generated headings (Service Scope, Summary of Weaknesses, Files
 * Attached, the Evidence Log header inside this very section), so a counter
 * would need a new class in `report-style.ts` to tell the hand-authored titles
 * apart — and inline numbers are already the house pattern for every other
 * identifier in this document.
 */
async function renderExecutionNarrative(
  app: FastifyInstance,
  engagementId: number,
  userId: number,
  subsections: ExecutionSubsection[],
  evidenceByUuid: Map<string, GatheredEvidence>,
  budget: Budget,
  show: EvidenceMetaVisibility,
  number: boolean,
): Promise<string> {
  const parts: string[] = [];
  // Counted over the subsections that actually render — a blank title is skipped
  // below — so the printed sequence has no gaps.
  let n = 0;
  for (const sub of subsections) {
    if (!sub.title.trim()) continue;
    n++;
    const heading = `<h3 class="block-h">${number ? `${n}. ` : ''}${esc(sub.title)}</h3>`;

    if (sub.kind === 'timeline') {
      const cfg = executionTimelineConfigSchema.parse(sub.timeline ?? {});
      const items = await gatherSubsectionTimeline(app, engagementId, userId, cfg);
      const body =
        items.length === 0
          ? '<p class="pp muted">No evidence matches this timeline’s filters.</p>'
          : await renderTimeline(app, items, cfg.group, budget, show);
      parts.push(`${heading}${body}`);
      continue;
    }

    const body = sub.body?.trim() ? prose(sub.body) : '';
    const evParts: string[] = [];
    for (const ref of sub.evidence) {
      const ev = evidenceByUuid.get(ref.evidenceUuid);
      // Unresolved ref: the evidence was deleted, or it is excluded from report
      // output (the caller's lookup only loads included items). Either way the
      // figure is dropped and the narrative prose stands on its own — the caption
      // goes with it, so nothing hints at the omission.
      if (!ev) continue;
      const cap = ref.caption?.trim() ? `<p class="step-caption">${esc(ref.caption)}</p>` : '';
      // Embedded narrative figures take the section's display sub-items too, so a
      // script hand-placed in the prose obeys the same toggle as one in a timeline.
      const evHtml = await renderEvidence(app, ev, budget, show);
      evParts.push(`<div class="step">${cap}${evHtml}</div>`);
    }
    const evHtml = evParts.length ? `<div class="path">${evParts.join('\n')}</div>` : '';
    parts.push(`${heading}${body}${evHtml}`);
  }
  return parts.join('\n');
}

export async function buildReportHtml(
  app: FastifyInstance,
  eng: EngagementRef,
  generatedAt: Date,
  opts: ReportOptions,
  /** The report's author; resolves per-user filters (e.g. a timeline subsection's
   *  "starred only"). Always the requesting user on the web report routes. */
  userId: number,
  /** The supporting-file set, when the caller already computed it (the ZIP route
   *  needs the same list for its archive entries, and hashing twice is wasteful).
   *  It MUST come from {@link gatherSupportingFiles}: this list is printed verbatim
   *  in the "Files Attached" table, so it is the one report input whose report
   *  exclusions are the caller's responsibility rather than this function's. */
  precomputedFiles?: SupportingFileMeta[],
): Promise<string> {
  // Narrative is the default Assessment Execution view; the auto timeline is opt-in.
  const includeNarrative = opts.includeNarrative !== false;
  const includeTimeline = opts.includeTimeline === true;
  const includeAppendix = opts.includeAppendix !== false;
  const evidenceGroup: EvidenceGrouping = opts.evidenceGroup ?? 'chronological';
  // Sanitize toggles fail closed: a caller that doesn't set them hides the
  // evidence-log timestamp/operator, so no route can leak capture times or
  // operator identities by omission. Config routes pass the saved values (schema
  // default: hidden); the legacy query routes accept explicit opt-in params.
  //
  // The rest of {@link EvidenceMetaVisibility} is the Assessment Execution
  // section's own display sub-items, which live on that section's entry rather
  // than in `opts`, so the full object is assembled in the section's case below.
  const sanitize: Pick<EvidenceMetaVisibility, 'timestamps' | 'operators'> = {
    timestamps: opts.showEvidenceTimestamps ?? false,
    operators: opts.showEvidenceOperators ?? false,
  };

  const [settings, engagement, findings, members] = await Promise.all([
    getReportSettings(app),
    app.db.engagement.findUniqueOrThrow({ where: { id: eng.id } }),
    gather(app, eng, opts),
    app.db.userEngagementRole.findMany({
      where: { engagementId: eng.id },
      include: { user: true },
    }),
  ]);

  const accent = settings.accentColor || '#e82434';
  const orgName = settings.organizationName || 'Block Harbor';
  const footerNote = settings.footerNote || 'Confidential';

  // Sort findings by severity desc (critical→none, null last), then position.
  const sorted = [...findings].sort((a, b) => {
    const ra = a.severity ? SEVERITY_RANK[a.severity] : -1;
    const rb = b.severity ? SEVERITY_RANK[b.severity] : -1;
    if (ra !== rb) return rb - ra;
    return a.position - b.position;
  });

  // Split into weaknesses (severity-ranked) and strengths (by author order).
  const weaknesses = sorted.filter((f) => f.kind === 'weakness');
  const strengths = [...findings]
    .filter((f) => f.kind === 'strength')
    .sort((a, b) => a.position - b.position);

  // Display grouping for the Summary + Detailed Findings. `orderedWeaknesses` is
  // the flattened group order; W-numbers are assigned across it so the summary
  // table, detailed blocks, standards matrix, and TOC all agree.
  const findingGroup: FindingGrouping = opts.findingGroup ?? 'severity';
  const weaknessGroups = groupWeaknesses(weaknesses, findingGroup);
  const orderedWeaknesses = weaknessGroups.flatMap((g) => g.findings);

  // Severity distribution + key stats — weaknesses only (strengths carry no rating).
  // Unrated weaknesses fold into the informational (`none`) band, matching
  // `computeReportSummary`, so the report's severity cards and an attestation
  // letter's results table always agree and the cards sum to the weakness total.
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, none: 0 };
  for (const f of weaknesses) counts[f.severity ?? 'none']++;
  const scored = weaknesses.filter((f) => f.cvssScore != null);
  const highestCvss = scored.reduce((m, f) => Math.max(m, f.cvssScore!), 0);
  const avgCvss = scored.length ? scored.reduce((s, f) => s + f.cvssScore!, 0) / scored.length : 0;
  const rated = scored.length;

  const budget: Budget = { remaining: TOTAL_EMBED_CAP };

  // Structured report content (JSON columns → typed arrays).
  const scopeTargets = (engagement.scopeTargets as unknown as ScopeTarget[]) ?? [];
  const scopeExclusions = (engagement.scopeExclusions as unknown as string[]) ?? [];
  const recommendations =
    (engagement.strategicRecommendations as unknown as RecommendationItem[]) ?? [];
  // Map each finding uuid → the recommendations (by global R# number) that address
  // it, so Detailed Findings can echo "Related Recommendations" under each finding.
  // Numbering matches renderRecommendationsTable: index within the title-valid recs.
  const recsByFinding = new Map<string, LinkedRecommendation[]>();
  recommendations
    .filter((r) => r.title.trim())
    .forEach((r, i) => {
      for (const fu of r.findingUuids ?? []) {
        const arr = recsByFinding.get(fu) ?? [];
        arr.push({ num: i + 1, title: r.title });
        recsByFinding.set(fu, arr);
      }
    });
  const threatDiagrams = (engagement.threatModelDiagrams as unknown as ThreatDiagram[]) ?? [];
  const executionSubsections =
    (engagement.executionNarrative as unknown as ExecutionSubsection[]) ?? [];
  const providerContacts = (engagement.providerContacts as unknown as Contact[]) ?? [];
  const clientContacts = (engagement.clientContacts as unknown as Contact[]) ?? [];
  const softwareTested = (engagement.softwareTested as unknown as SoftwareItem[]) ?? [];
  const thirdPartySoftware = (engagement.thirdPartySoftware as unknown as SoftwareItem[]) ?? [];

  // Supporting files (non-screenshot evidence) for the ZIP + Files Attached table.
  const supportingFiles = precomputedFiles ?? (await gatherSupportingFiles(app, eng));
  // Blob key → the entry name the ZIP will use, taken from that same list (so it
  // carries the collision suffix `gatherSupportingFiles` assigned). The only
  // reader is the suppressed-script stub, which has to point at a name that
  // really exists in the bundle and in the Files Attached table.
  const artifactNames = new Map(supportingFiles.map((f) => [f.blobKey, f.filename]));

  // Which optional sections have content to render.
  const hasThreatModel =
    Boolean(engagement.threatModelNarrative?.trim()) || threatDiagrams.length > 0;
  const hasNarrativeContent = executionSubsections.some((s) => s.title.trim());
  const hasSupporting =
    softwareTested.some((s) => s.name.trim()) ||
    thirdPartySoftware.some((s) => s.name.trim()) ||
    supportingFiles.length > 0;

  // Section order + enablement. An explicit `sections` config drives everything
  // and turns the narrative on whenever its section is on; without a config we
  // rebuild the historical fixed order from the legacy boolean flags so existing
  // callers get byte-identical output.
  const configured = opts.sections !== undefined;
  const renderNarrative = configured ? true : includeNarrative;
  const customSections = opts.customSections ?? [];
  const sectionEntries: ReportSectionEntry[] = configured
    ? opts.sections!
    : [
        { key: 'executiveSummary', enabled: true },
        { key: 'assessmentFindings', enabled: true },
        { key: 'methodology', enabled: true },
        { key: 'threatModel', enabled: true },
        { key: 'assessmentExecution', enabled: renderNarrative || includeTimeline },
        { key: 'scopeCoverage', enabled: false },
        { key: 'detailedFindings', enabled: true },
        { key: 'supportingInformation', enabled: true },
        { key: 'appendix', enabled: includeAppendix },
      ];

  // On-screen Configure preview: render only the requested section, forced on so
  // the author sees its content even while the section is toggled off, reusing its
  // configured sub-item options. Everything else (order, cover, TOC) is bypassed.
  const previewKey = opts.previewSectionKey;
  const isPreview = previewKey !== undefined;
  const effectiveEntries: ReportSectionEntry[] = isPreview
    ? [
        {
          key: previewKey!,
          enabled: true,
          options: sectionEntries.find((s) => s.key === previewKey)?.options,
        },
      ]
    : sectionEntries;

  // Load the goals tree only when the coverage section is actually enabled.
  const wantCoverage = effectiveEntries.some((s) => s.key === 'scopeCoverage' && s.enabled);
  const coverageTargets: Target[] = wantCoverage
    ? await fetchGoalsTree(app, eng.id, { forReport: true })
    : [];
  const coverageProgress: EngagementProgress = progressFromTree(coverageTargets);

  // Section 01 is always Engagement Details; content sections number from 02 in
  // their configured, rendered order, so the TOC never drifts.
  let secN = 0;
  const nextNum = () => String(++secN).padStart(2, '0');
  const numDetails = nextNum();

  // ---- Cover -------------------------------------------------------------
  const eyebrow = (engagement.assessmentType || 'Findings Report').toUpperCase();
  const preparedFor = engagement.clientName || engagement.name;
  const subtitleBits = [preparedFor];
  if (engagement.assessmentType) subtitleBits.push(engagement.assessmentType);
  const windowStart = engagement.startedAt;
  const windowEnd = engagement.actualEndAt ?? engagement.projectedEndAt;
  const windowStr = `${longDate(windowStart)} – ${longDate(windowEnd)}`;
  const statusLabel = engagement.status.charAt(0).toUpperCase() + engagement.status.slice(1);

  const logo = settings.logoDataUri
    ? `<img class="cover-logo" src="${esc(settings.logoDataUri)}" alt="${esc(orgName)}" />`
    : `<div class="cover-wordmark">${esc(orgName)}<span class="dot">.</span></div>`;

  const coverMeta = `
    <div class="cover-meta">
      <div class="cover-cell"><div class="k">Prepared for</div><div class="v">${esc(preparedFor)}</div></div>
      <div class="cover-cell"><div class="k">Prepared by</div><div class="v">${esc(orgName)}</div></div>
      <div class="cover-cell"><div class="k">Date</div><div class="v">${esc(longDate(generatedAt))}</div></div>
      <div class="cover-cell"><div class="k">Assessment window</div><div class="v">${esc(windowStr)}</div></div>
      <div class="cover-cell cover-cell-wide"><div class="k">Status</div><div class="v">${esc(statusLabel)}</div></div>
    </div>`;

  const cover = `
    <section class="cover">
      <div class="cover-top">${logo}</div>
      <div class="cover-mid">
        <hr class="cover-rule" />
        <div class="cover-eyebrow">${esc(eyebrow)}</div>
        <h1 class="cover-title">${esc(engagement.name)}</h1>
        <p class="cover-sub">${esc(subtitleBits.join(' — '))}</p>
        ${coverMeta}
      </div>
      <p class="cover-foot">${esc(footerNote)}</p>
    </section>`;

  // ---- Engagement Details (Document Information) --------------------------
  const memberRows =
    members.length > 0
      ? members
          .map(
            (m) =>
              `<div class="person"><div class="nm">${esc(`${m.user.firstName} ${m.user.lastName}`.trim())}</div><div class="rl">${esc(roleLabel(m.role))}</div></div>`,
          )
          .join('')
      : '<div class="person"><div class="rl muted">No team members recorded.</div></div>';

  // Quoted twice (the Engagement Details grid and the Executive Summary stats
  // strip), so it must count what the report can actually show: report-excluded
  // evidence is left out rather than tallied as present-but-missing.
  const totalEvidenceCount = await app.db.evidence.count({
    where: { engagementId: eng.id, parentEvidenceId: null, excludeFromReport: false },
  });

  const providerCell = providerContacts.some((c) => c.name.trim() || c.email.trim())
    ? `<div class="info-cell info-cell-wide"><div class="k">Provider contacts</div>${renderContacts(providerContacts)}</div>`
    : '';
  const clientCell = clientContacts.some((c) => c.name.trim() || c.email.trim())
    ? `<div class="info-cell info-cell-wide"><div class="k">Client contacts</div>${renderContacts(clientContacts)}</div>`
    : '';

  const detailsGrid = `
    <div class="grid2">
      <div class="info-cell"><div class="k">Client</div><div class="v">${esc(preparedFor)}</div></div>
      <div class="info-cell"><div class="k">Assessment type</div><div class="v">${esc(engagement.assessmentType || '—')}</div></div>
      <div class="info-cell"><div class="k">Location</div><div class="v">${esc(engagement.location || '—')}</div></div>
      <div class="info-cell"><div class="k">Status</div><div class="v">${esc(statusLabel)}</div></div>
      <div class="info-cell"><div class="k">Start date</div><div class="v mono">${esc(longDate(windowStart))}</div></div>
      <div class="info-cell"><div class="k">End date</div><div class="v mono">${esc(longDate(windowEnd))}</div></div>
      <div class="info-cell"><div class="k">Findings</div><div class="v mono">${weaknesses.length + strengths.length}</div></div>
      <div class="info-cell"><div class="k">Evidence</div><div class="v mono">${totalEvidenceCount}</div></div>
      ${providerCell}
      ${clientCell}
      <div class="info-cell info-cell-wide"><div class="k">Team members</div>${memberRows}</div>
    </div>`;

  const detailsSection = `
    <section class="section">
      ${sectionHead(numDetails, 'Document Information', 'Engagement Details')}
      ${detailsGrid}
    </section>`;

  // ---- Precompute the content of each (sync) section ---------------------
  const summaryProse = engagement.executiveSummary?.trim()
    ? prose(engagement.executiveSummary)
    : '';
  const scopeHtml =
    scopeTargets.length || scopeExclusions.length
      ? renderScope(scopeTargets, scopeExclusions)
      : engagement.scope?.trim()
        ? `<h3 class="block-h">Scope</h3>${prose(engagement.scope)}`
        : '';

  const total = weaknesses.length;
  const sevBar =
    total > 0
      ? `<div class="sev-bar">${SEV_ORDER.filter((s) => counts[s] > 0)
          .map(
            (s) =>
              `<span style="width:${((counts[s] / total) * 100).toFixed(3)}%;background:var(--sev-${s})"></span>`,
          )
          .join('')}</div>`
      : '';
  const sevCards = `<div class="sev-cards">${SEV_ORDER.map(
    (s) =>
      `<div class="sev-card ${s}"><div class="n">${counts[s]}</div><div class="l">${esc(SEVERITY_LABELS[s])}</div></div>`,
  ).join('')}</div>`;

  const windowDays =
    windowStart && windowEnd
      ? Math.max(1, Math.round((windowEnd.getTime() - windowStart.getTime()) / 86400000))
      : null;

  const statsStrip = `
    <div class="stats">
      <div class="stat"><div class="k">Weaknesses</div><div class="v">${weaknesses.length}</div></div>
      <div class="stat"><div class="k">Highest CVSS</div><div class="v">${rated ? highestCvss.toFixed(1) : '—'}</div></div>
      <div class="stat"><div class="k">Average CVSS</div><div class="v">${rated ? avgCvss.toFixed(1) : '—'}</div></div>
      <div class="stat"><div class="k">Total evidence</div><div class="v">${totalEvidenceCount}</div></div>
      <div class="stat"><div class="k">Window</div><div class="v">${windowDays ?? '—'}<span class="u"> days</span></div></div>
    </div>`;
  const severityBlock = `<h3 class="block-h">Severity Distribution</h3>${sevBar}${sevCards}`;

  const catCounts = new Map<string, number>();
  for (const f of weaknesses) {
    const key = f.category || 'Uncategorized';
    catCounts.set(key, (catCounts.get(key) ?? 0) + 1);
  }
  const catRows = [...catCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cat, n]) => `<tr><td class="title">${esc(cat)}</td><td class="num">${n}</td></tr>`)
    .join('');
  const categoryTable =
    catCounts.size > 0
      ? `<h3 class="block-h">Category Breakdown</h3>
         <table class="tbl">
           <thead><tr><th>Category</th><th class="num">Weaknesses</th></tr></thead>
           <tbody>${catRows}</tbody>
         </table>`
      : '';

  const traceItems = [
    ...orderedWeaknesses.map((f, i) => ({
      label: `W${i + 1}`,
      title: f.title,
      iso: f.iso21434Refs,
      unr: f.unr155Refs,
    })),
    ...strengths.map((f, i) => ({
      label: `S${i + 1}`,
      title: f.title,
      iso: f.iso21434Refs,
      unr: f.unr155Refs,
    })),
  ];

  const methodologyInner = engagement.methodology?.trim()
    ? prose(engagement.methodology)
    : `<p class="pp">This assessment followed a structured, evidence-driven methodology: reconnaissance and scoping, active testing against the in-scope surface, verification and impact analysis of each issue, and consolidation of results into the prioritized findings that follow. Every finding is supported by the captured evidence recorded during the engagement.</p>`;

  const bands: { sev: Severity; range: string; desc: string }[] = [
    {
      sev: 'critical',
      range: '9.0 – 10.0',
      desc: 'Immediate risk; likely leads to full compromise. Remediate urgently.',
    },
    {
      sev: 'high',
      range: '7.0 – 8.9',
      desc: 'Serious risk; significant impact or ease of exploitation. Prioritize.',
    },
    {
      sev: 'medium',
      range: '4.0 – 6.9',
      desc: 'Moderate risk; meaningful impact, often requiring specific conditions.',
    },
    { sev: 'low', range: '0.1 – 3.9', desc: 'Limited risk; minor impact or difficult to exploit.' },
    { sev: 'none', range: '0.0', desc: 'Informational; no direct security impact.' },
  ];
  const appendixInner = `<p class="lede">Severity ratings follow the CVSS v3.1 qualitative severity scale, derived from each finding's base score.</p>
      <table class="tbl">
        <thead><tr><th>Severity</th><th class="num">CVSS score</th><th>Description</th></tr></thead>
        <tbody>${bands
          .map(
            (b) =>
              `<tr><td>${severityPill(b.sev, null)}</td><td class="num">${b.range}</td><td>${esc(b.desc)}</td></tr>`,
          )
          .join('')}</tbody>
      </table>`;

  // ---- Render each enabled+present section, in configured order ----------
  interface RenderedSection {
    kicker: string;
    title: string;
    tocTitle: string;
    inner: string;
    /** Detailed Findings adds its weaknesses as TOC sub-rows (W1, W2, …). */
    weaknessToc?: boolean;
  }
  const rendered: RenderedSection[] = [];

  for (const entry of effectiveEntries) {
    if (!entry.enabled) continue;
    const key = entry.key;
    // A section sub-item renders unless its entry explicitly turned it off.
    const partOn = (opt: string): boolean => entry.options?.[opt] !== false;

    if (key.startsWith('custom:')) {
      const cs = customSections.find((c) => c.id === key.slice('custom:'.length) && c.title.trim());
      if (cs)
        rendered.push({
          kicker: 'Additional',
          title: cs.title,
          tocTitle: cs.title,
          inner: renderCustomSection(cs),
        });
      continue;
    }

    switch (key) {
      case 'executiveSummary': {
        const parts: string[] = [];
        if (partOn('summary')) parts.push(summaryProse);
        if (partOn('scope')) parts.push(scopeHtml);
        if (partOn('severity')) parts.push(severityBlock);
        if (partOn('stats')) parts.push(statsStrip);
        rendered.push({
          kicker: 'Overview',
          title: 'Executive Summary',
          tocTitle: 'Executive Summary',
          inner: parts.join(''),
        });
        break;
      }
      case 'assessmentFindings': {
        const parts: string[] = [];
        if (partOn('strengths')) parts.push(renderStrengthsTable(strengths));
        if (partOn('weaknesses')) parts.push(renderWeaknessesTable(weaknessGroups));
        if (partOn('recommendations')) parts.push(renderRecommendationsTable(recommendations));
        if (partOn('categories')) parts.push(categoryTable);
        if (partOn('standards')) parts.push(renderStandardsTraceability(traceItems));
        rendered.push({
          kicker: 'Summary',
          title: 'Assessment Findings',
          tocTitle: 'Assessment Findings',
          inner: parts.join(''),
        });
        break;
      }
      case 'methodology':
        rendered.push({
          kicker: 'Approach',
          title: 'Methodology & Approach',
          tocTitle: 'Methodology & Approach',
          inner: methodologyInner,
        });
        break;
      case 'threatModel':
        if (hasThreatModel) {
          const tmNarrative = partOn('narrative') ? engagement.threatModelNarrative : null;
          const tmDiagrams = partOn('diagrams') ? threatDiagrams : [];
          const tmInner = renderThreatModel(tmNarrative, tmDiagrams, budget);
          // `hasThreatModel` already guarantees content exists, so an empty render
          // means both sub-items were toggled off — skip the section rather than
          // claim "No threat model recorded" (mirrors renderFinding's evidence guard).
          if (tmInner)
            rendered.push({
              kicker: 'Attack Surface',
              title: 'Threat Model',
              tocTitle: 'Threat Model',
              inner: tmInner,
            });
        }
        break;
      case 'assessmentExecution': {
        const present = (renderNarrative && hasNarrativeContent) || includeTimeline;
        if (!present) break;
        // The section's display sub-items, on top of the two top-level sanitize
        // toggles. Each one is absent-means-on via `partOn`, so an engagement that
        // has no `options` map for this section (every engagement that predates
        // these toggles, and every legacy query-param caller) renders exactly what
        // it rendered before.
        const showEvidenceMeta: EvidenceMetaVisibility = {
          ...sanitize,
          tags: partOn('evidenceTags'),
          typeCaptions: partOn('typeCaptions'),
          scriptBodies: partOn('scriptBodies'),
          artifactNames,
        };
        let narrativeHtml = '';
        if (renderNarrative && hasNarrativeContent) {
          const refUuids = [
            ...new Set(executionSubsections.flatMap((s) => s.evidence.map((e) => e.evidenceUuid))),
          ];
          const evidenceByUuid = new Map<string, GatheredEvidence>();
          if (refUuids.length) {
            const rows = await app.db.evidence.findMany({
              // An excluded item simply doesn't resolve, and `renderExecutionNarrative`
              // already skips refs it can't resolve (the dangling-ref case), so the
              // narrative prose stays intact minus that figure.
              where: {
                engagementId: eng.id,
                uuid: { in: refUuids },
                ...REPORT_VISIBLE_EVIDENCE,
              },
              select: {
                uuid: true,
                title: true,
                description: true,
                contentType: true,
                contentSubtype: true,
                originalFilename: true,
                occurredAt: true,
                fullBlobKey: true,
                excludeFromReport: true,
              },
            });
            for (const r of rows) {
              evidenceByUuid.set(r.uuid, {
                uuid: r.uuid,
                title: r.title,
                description: r.description,
                contentType: r.contentType,
                contentSubtype: r.contentSubtype,
                originalFilename: r.originalFilename,
                occurredAt: r.occurredAt,
                fullBlobKey: r.fullBlobKey,
                caption: '',
                inPath: false,
                excludeFromReport: r.excludeFromReport,
              });
            }
          }
          narrativeHtml = await renderExecutionNarrative(
            app,
            eng.id,
            userId,
            executionSubsections,
            evidenceByUuid,
            budget,
            showEvidenceMeta,
            opts.numberExecutionSubsections === true,
          );
        }

        let timelineHtml = '';
        if (includeTimeline) {
          const evidence = await app.db.evidence.findMany({
            where: { engagementId: eng.id, parentEvidenceId: null, excludeFromReport: false },
            include: { tags: { include: { tag: true } }, operator: true },
            orderBy: { occurredAt: 'asc' },
          });
          const tlItems: TimelineEvidence[] = evidence.map((e) => ({
            uuid: e.uuid,
            title: e.title,
            description: e.description,
            contentType: e.contentType,
            contentSubtype: e.contentSubtype,
            occurredAt: e.occurredAt,
            fullBlobKey: e.fullBlobKey,
            operatorName: operatorLabel(e.operator),
            tags: e.tags.map((t) => ({ name: t.tag.name, colorName: t.tag.colorName })),
          }));
          const groupLabel = EVIDENCE_GROUPING_LABELS[evidenceGroup];
          const body = await renderTimeline(app, tlItems, evidenceGroup, budget, showEvidenceMeta);
          timelineHtml = `<h3 class="block-h">Evidence Log · ${esc(groupLabel)}</h3>${body}`;
        }

        rendered.push({
          kicker: 'Walkthrough',
          title: 'Assessment Execution',
          tocTitle: 'Assessment Execution',
          inner: `${narrativeHtml}${timelineHtml}`,
        });
        break;
      }
      case 'scopeCoverage':
        if (coverageTargets.length > 0)
          rendered.push({
            kicker: 'Coverage',
            title: 'Scope & Objectives Coverage',
            tocTitle: 'Scope & Objectives Coverage',
            inner: renderScopeCoverage(coverageTargets, coverageProgress),
          });
        break;
      case 'detailedFindings': {
        const findingParts: FindingParts = {
          impact: partOn('impact'),
          standards: partOn('standards'),
          remediation: partOn('remediation'),
          recommendations: partOn('recommendations'),
          attackPath: partOn('attackPath'),
          attachedEvidence: partOn('attachedEvidence'),
        };
        const findingBlocks: string[] = [];
        if (weaknesses.length === 0) {
          findingBlocks.push('<p class="pp muted">No weaknesses to report.</p>');
        } else {
          let n = 0;
          for (const g of weaknessGroups) {
            if (g.label !== null) {
              findingBlocks.push(
                `<h3 class="block-h">${esc(g.label)} <span class="group-count">(${g.findings.length})</span></h3>`,
              );
            }
            for (const f of g.findings) {
              n++;
              findingBlocks.push(
                await renderFinding(
                  app,
                  f,
                  `W${n}`,
                  budget,
                  findingParts,
                  recsByFinding.get(f.uuid) ?? [],
                ),
              );
            }
          }
        }
        rendered.push({
          kicker: 'Detailed Results',
          title: 'Detailed Findings',
          tocTitle: 'Detailed Findings',
          inner: findingBlocks.join('\n'),
          weaknessToc: true,
        });
        break;
      }
      case 'supportingInformation':
        if (hasSupporting) {
          const parts: string[] = [];
          if (partOn('softwareTested'))
            parts.push(renderSoftwareTable('Client Software Tested', softwareTested));
          if (partOn('thirdParty'))
            parts.push(renderSoftwareTable('Test Tools Used', thirdPartySoftware));
          if (partOn('filesAttached')) parts.push(renderFilesAttached(supportingFiles));
          rendered.push({
            kicker: 'Reference',
            title: 'Supporting Information',
            tocTitle: 'Supporting Information',
            inner: parts.join(''),
          });
        }
        break;
      case 'appendix':
        rendered.push({
          kicker: 'Reference',
          title: 'Severity & CVSS Reference',
          tocTitle: 'Appendix: Severity & CVSS Reference',
          inner: appendixInner,
        });
        break;
    }
  }

  // On-screen Configure preview: return just the requested section, styled like
  // the report (no cover / details / TOC / watermark). When the section renders
  // nothing (empty threat model, no execution subsections, …) show a placeholder
  // so the panel still explains what the section would contain.
  if (isPreview) {
    const previewLabel = previewKey!.startsWith('custom:')
      ? customSections.find((c) => `custom:${c.id}` === previewKey)?.title || 'Custom section'
      : ((REPORT_SECTION_LABELS as Record<string, string>)[previewKey!] ?? 'Section');
    const sec = rendered[0];
    const sectionHtml = sec
      ? `<section class="section" style="break-before:auto">${sectionHead('', sec.kicker, sec.title)}${sec.inner}</section>`
      : `<section class="section" style="break-before:auto">${sectionHead('', 'Preview', previewLabel)}<p class="pp muted">This section has no content yet. Fill it out in the Content tab and it will appear here.</p></section>`;
    const previewCss = reportCss(
      accent,
      orgName.toUpperCase(),
      `${preparedFor.toUpperCase()} — ${footerNote.toUpperCase()}`,
    );
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(previewLabel)} — section preview</title>
${FONT_LINKS}
<style>${previewCss}
/* Screen-only tweaks: the report CSS is authored for paged print. */
html, body { background: #fff; }
.pad { padding: 28px 34px; }
.section { break-before: auto; }
</style>
</head>
<body>
  <div class="pad">${sectionHtml}</div>
</body></html>`;
  }

  // Assign section numbers (02, 03, …) in render order, then build the TOC.
  const numbered = rendered.map((r) => ({ ...r, num: nextNum() }));
  const tocRows: string[] = [tocItem(numDetails, 'Engagement Details', false)];
  for (const r of numbered) {
    tocRows.push(tocItem(r.num, r.tocTitle, false));
    if (r.weaknessToc)
      orderedWeaknesses.forEach((f, i) => tocRows.push(tocItem(`W${i + 1}`, f.title, true)));
  }
  const tocSection = `
    <section class="section">
      ${sectionHead('', 'Contents', 'Table of Contents', true)}
      <div class="toc">${tocRows.join('')}</div>
    </section>`;

  const bodySections = numbered
    .map(
      (r) =>
        `<section class="section">${sectionHead(r.num, r.kicker, r.title)}${r.inner}</section>`,
    )
    .join('\n');

  // Running-header text (baked into the @page margin boxes).
  const hdrLeft = orgName.toUpperCase();
  const hdrRight = `${preparedFor.toUpperCase()} — ${footerNote.toUpperCase()}`;

  // ---- Watermark (every page but the cover) ------------------------------
  const wmText = engagement.watermarkText?.trim() || 'CONFIDENTIAL';
  const wmColor = engagement.watermarkColor || '#64748b';
  const wmOpacity =
    WATERMARK_OPACITY_VALUES[
      engagement.watermarkOpacity as keyof typeof WATERMARK_OPACITY_VALUES
    ] ?? WATERMARK_OPACITY_VALUES.medium;
  const wmLayer = engagement.watermarkLayer === 'front' ? 'front' : 'behind';
  // Scale the font so the rotated word always fits the page (no clipping).
  const wmFontSize = watermarkFontSize(wmText);
  const watermarkStyle = engagement.watermarkEnabled
    ? watermarkCss(wmColor, wmOpacity, wmLayer, wmFontSize)
    : '';
  const watermark = engagement.watermarkEnabled ? watermarkMarkup(wmText) : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${esc(engagement.name)} — Findings Report</title>
${FONT_LINKS}
<style>${reportCss(accent, hdrLeft, hdrRight)}${watermarkStyle}</style>
</head>
<body>
  ${watermark}
  ${cover}
  ${detailsSection}
  ${tocSection}
  ${bodySections}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Small HTML builders
// ---------------------------------------------------------------------------

/** A numbered section header (mono number + condensed kicker + heavy title). */
function sectionHead(num: string, kicker: string, title: string, noRule = false): string {
  const rule = noRule ? ' style="border-top:0;padding-top:0"' : '';
  const numHtml = num
    ? `<span class="sec-num">${esc(num)}</span>`
    : '<span class="sec-num"></span>';
  return `<div class="sec-head"${rule}>
    <div class="sec-kicker">${esc(kicker)}</div>
    ${numHtml}
    <h2 class="sec-title">${esc(title)}</h2>
  </div>`;
}

/** One table-of-contents row. */
function tocItem(n: string, title: string, sub: boolean): string {
  return `<div class="toc-item${sub ? ' sub' : ''}"><span class="toc-n">${esc(n)}</span><span class="toc-t">${esc(title)}</span><span class="toc-dot"></span></div>`;
}

/** Human label for an engagement role in the team-members list. */
function roleLabel(role: string): string {
  const map: Record<string, string> = { admin: 'Lead', write: 'Operator', read: 'Reviewer' };
  return map[role] ?? role;
}
