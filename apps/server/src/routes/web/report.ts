import archiver from 'archiver';
import type { FastifyInstance } from 'fastify';
import type { PuppeteerNode } from 'puppeteer';
import {
  FINDINGS_EXPORT_VERSION,
  REPORT_PRESET_FILE_LABELS,
  attestationFrameworkSchema,
  evidenceGroupingSchema,
  findingGroupingSchema,
  findingsExportSchema,
  reportConfigSchema,
  reportPresetSchema,
  reportPresetSections,
  severitySchema,
  type AttestationFramework,
  type EvidenceGrouping,
  type FindingGrouping,
  type ReportPreset,
  type ReportTemplateConfig,
  type Severity,
} from '@reporter/shared';
import { HttpError, requireAuth, requireEngagementRole } from '../../auth/guards.js';
import {
  buildFindingsExport,
  buildReportHtml,
  gatherSupportingFiles,
  type ReportOptions,
} from '../../services/findings-report.js';
import { importFindings } from '../../services/findings-import.js';
import { getReportTemplateConfig } from '../../services/report-templates.js';
import { slugify } from '../../helpers/slug.js';
import {
  findReportForLetter,
  listReportHistory,
  recordGeneratedReport,
} from '../../services/report-history.js';
import { buildAttestationLetterHtml } from '../../services/attestation-letter.js';
import type { GeneratedReportFormat } from '@reporter/shared';

/** Parse the `?framework` query param, defaulting to SOC 2. */
function frameworkParam(v: unknown): AttestationFramework {
  const parsed = attestationFrameworkSchema.safeParse(v);
  return parsed.success ? parsed.data : 'soc2';
}

/** Parse an optional severity query param (the letter's overall-risk override). */
function severityParam(v: unknown): Severity | undefined {
  const parsed = severitySchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

/** Trim an optional string query param to a value or undefined. */
function strParam(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Record a report generation for the history log, best-effort: a hiccup here
 * must never fail the download the user actually asked for.
 */
async function recordReport(
  app: FastifyInstance,
  args: {
    eng: { id: number; slug: string; name: string };
    preset: ReportPreset;
    /** Overrides the preset's label in the history (a report template's name). */
    label?: string;
    format: GeneratedReportFormat;
    options: ReportOptions;
    userId: number;
    artifact: { buffer: Buffer; contentType: string; filename: string };
  },
): Promise<void> {
  try {
    await recordGeneratedReport(app, args);
  } catch (err) {
    app.log.error({ err }, 'failed to record report history');
  }
}

function boolParam(v: unknown): boolean {
  return v === 'true' || v === '1';
}

/** Parse the query param, defaulting to true unless explicitly "false"/"0". */
function boolParamDefaultTrue(v: unknown): boolean {
  return !(v === 'false' || v === '0');
}

/** Parse the evidence grouping, falling back to a safe default. */
function groupParam(v: unknown): EvidenceGrouping {
  const parsed = evidenceGroupingSchema.safeParse(v);
  return parsed.success ? parsed.data : 'chronological';
}

/** Parse the finding grouping, falling back to the default (severity). */
function findingGroupParam(v: unknown): FindingGrouping {
  const parsed = findingGroupingSchema.safeParse(v);
  return parsed.success ? parsed.data : 'severity';
}

/**
 * A filename timestamp down to the second (local time), so repeated exports on
 * the same day get distinct names: `2026-08-20-143052`.
 */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

/** The `?preset` query param ("report type"), defaulting to the saved custom config. */
function presetParam(v: unknown): ReportPreset {
  const parsed = reportPresetSchema.safeParse(v);
  return parsed.success ? parsed.data : 'custom';
}

/** Report options parsed from the shared query params of the PDF and ZIP routes. */
function reportOptionsFromQuery(q: Record<string, string | undefined>): ReportOptions {
  return {
    includeAll: boolParam(q.includeAll),
    evidenceGroup: groupParam(q.evidenceGroup),
    findingGroup: findingGroupParam(q.findingGroup),
    // Narrative is the default Assessment Execution view; the timeline is opt-in.
    includeNarrative: boolParamDefaultTrue(q.includeNarrative),
    includeTimeline: boolParam(q.includeTimeline),
    includeAppendix: boolParamDefaultTrue(q.includeAppendix),
    // Sanitize defaults to hidden here too; these legacy routes opt in explicitly
    // (they don't read the engagement's saved report config).
    showEvidenceTimestamps: boolParam(q.showEvidenceTimestamps),
    showEvidenceOperators: boolParam(q.showEvidenceOperators),
  };
}

/**
 * Report options from a saved report configuration (the Reports section).
 *
 * Typed `ReportTemplateConfig` — the report configuration minus `readinessNa` —
 * because every option a report renders from is a reporting choice, and readiness
 * waivers deliberately are not one. An engagement's live `ReportConfig` satisfies
 * that type structurally, so the engagement's own configuration and a report
 * template's configuration render through this one path and cannot diverge.
 */
function reportOptionsFromConfig(config: ReportTemplateConfig): ReportOptions {
  return {
    // Config-driven reports always include only "Ready to report" findings, and the
    // whole-engagement auto evidence log is retired — curated timeline subsections
    // authored in the Content tab still render. (The legacy query-param routes keep
    // their own `includeAll`/`includeTimeline` flags for the client API.)
    includeAll: false,
    findingGroup: config.findingGroup,
    includeTimeline: false,
    sections: config.sections,
    customSections: config.customSections,
    showEvidenceTimestamps: config.showEvidenceTimestamps,
    showEvidenceOperators: config.showEvidenceOperators,
  };
}

/**
 * Resolve a report "type" into render options and the filename fragment that
 * names it. `custom` renders the engagement's saved configuration; the canned
 * presets render a fixed section subset (report-ready findings, no timeline).
 */
function reportFor(
  config: ReportTemplateConfig,
  preset: ReportPreset,
): { options: ReportOptions; label: string } {
  const label = REPORT_PRESET_FILE_LABELS[preset];
  if (preset === 'custom') return { options: reportOptionsFromConfig(config), label };
  return {
    options: {
      includeAll: false,
      evidenceGroup: config.evidenceGroup,
      findingGroup: config.findingGroup,
      includeTimeline: false,
      sections: reportPresetSections(preset),
      customSections: [],
      showEvidenceTimestamps: config.showEvidenceTimestamps,
      showEvidenceOperators: config.showEvidenceOperators,
    },
    label,
  };
}

/**
 * Resolve what a single generation run renders: the engagement's saved
 * `reportConfig`, or — when `?templateUuid` names a report template — that
 * template's configuration, for that run only.
 *
 * Nothing is written back to the engagement: the template's config is read and fed
 * into the same `reportFor` path as the live config, so the Configure tab's
 * configuration is left byte-for-byte as it was and the engagement's `readinessNa`
 * is never touched (a template deliberately doesn't carry one). An unknown uuid
 * 404s out of `getReportTemplateConfig` rather than quietly falling back to the
 * engagement config — a caller that named a template must not be handed a
 * different report than the one it asked for.
 *
 * Every config-driven generation route (PDF, ZIP, JSON) resolves through here, so
 * the three cannot drift apart.
 */
async function reportForRun(
  app: FastifyInstance,
  eng: { reportConfig: unknown },
  q: Record<string, string | undefined>,
): Promise<{
  options: ReportOptions;
  /** Filename fragment naming the report type (or the template). */
  label: string;
  preset: ReportPreset;
  /** Report-history label, when it should say more than the preset does. */
  historyLabel?: string;
}> {
  const templateUuid = strParam(q.templateUuid);
  if (!templateUuid) {
    const config = reportConfigSchema.parse(eng.reportConfig ?? {});
    const preset = presetParam(q.preset);
    return { ...reportFor(config, preset), preset };
  }

  const { name, config: templateConfig } = await getReportTemplateConfig(app, templateUuid);
  // A template *is* a complete report configuration, so it renders through the
  // `custom` path; any `?preset` alongside it is ignored rather than half-applied
  // over the top. History records the preset actually rendered (`custom`) but
  // labels the row with the template's name — otherwise the trail would read "Your
  // configured sections" for a report the engagement's own configuration never
  // produced.
  return {
    options: reportOptionsFromConfig(templateConfig),
    label: slugify(name) || REPORT_PRESET_FILE_LABELS.custom,
    preset: 'custom',
    historyLabel: `Report template: ${name}`,
  };
}

/**
 * Render an HTML document to a PDF buffer with headless Chromium. Puppeteer is
 * imported lazily so the server boots (and tests run) without it installed.
 */
async function renderPdf(app: FastifyInstance, html: string): Promise<Buffer> {
  let puppeteer: PuppeteerNode;
  try {
    puppeteer = (await import('puppeteer')).default;
  } catch (err) {
    app.log.error({ err }, 'puppeteer unavailable');
    throw new HttpError(501, 'PDF generation is not available on this server');
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    // Fonts load from Google Fonts when the host has network, but the render must
    // never block on them (Docker Chromium is often offline): give the network a
    // brief window, then fall back to the local font stacks.
    await page.setContent(html, { waitUntil: 'load' });
    // Runs in the browser context (not Node) — hence the `Function`-based evaluate
    // to keep it out of tsc's Node lib.
    const waitFonts = new Function(
      'return Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);',
    ) as () => Promise<unknown>;
    await page.evaluate(waitFonts).catch(() => undefined);
    // Page geometry (Letter, margins, running header/footer, page numbers) comes
    // entirely from the document's CSS @page + margin boxes.
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

/** Findings export: portable JSON and a rendered PDF report. */
export async function reportRoutes(app: FastifyInstance): Promise<void> {
  // JSON export (also the import format): the findings and their linked evidence.
  // `includeEvidenceContent` embeds blobs as base64 so the export can be
  // re-imported into another server.
  //
  // This is the one output that can be asked for report-excluded evidence:
  // `includeExcludedEvidence` turns the file into a complete backup of the
  // findings (excluded items included, flag set, so an import restores the
  // exclusion). It is off unless the caller asks, no other option implies it, and
  // this download is not recorded in report history — the bytes go to the caller
  // and are not kept as an engagement artifact.
  app.get(
    '/engagements/:slug/findings/export.json',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const q = req.query as Record<string, string | undefined>;
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const includeExcludedEvidence = boolParam(q.includeExcludedEvidence);
      const data = await buildFindingsExport(app, eng, new Date(), {
        includeAll: boolParam(q.includeAll),
        // The exclusion opt-in implies content: it is justified only by making the
        // file restorable, and without the bytes an import hits the
        // reference-only `evidenceSkipped` branch for exactly those items — the
        // sensitive half of the trade without the backup half.
        includeEvidenceContent: boolParam(q.includeEvidenceContent) || includeExcludedEvidence,
        includeExcludedEvidence,
      });
      reply.header(
        'Content-Disposition',
        `attachment; filename="${slug}-findings-${stamp()}.json"`,
      );
      return data;
    },
  );

  // Import a findings export (report.json) into this engagement. The body can be
  // large when it embeds evidence content, so raise the per-route body limit.
  app.post(
    '/engagements/:slug/findings/import',
    {
      preHandler: [requireAuth, requireEngagementRole('write')],
      bodyLimit: app.config.MAX_UPLOAD_BYTES,
    },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const data = findingsExportSchema.parse(req.body);
      if (data.schemaVersion > FINDINGS_EXPORT_VERSION) {
        throw new HttpError(400, `Unsupported export schema version ${data.schemaVersion}`);
      }
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      return importFindings(app, { id: eng.id, slug: eng.slug }, data, req.authedUser!.id);
    },
  );

  // PDF report, rendered from HTML by headless Chromium.
  app.get(
    '/engagements/:slug/findings/report.pdf',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const q = req.query as Record<string, string | undefined>;
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const html = await buildReportHtml(
        app,
        eng,
        new Date(),
        reportOptionsFromQuery(q),
        req.authedUser!.id,
      );
      const pdf = await renderPdf(app, html);
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${slug}-findings-${stamp()}.pdf"`);
      return reply.send(pdf);
    },
  );

  // ZIP bundle: the PDF report plus every supporting file (non-screenshot
  // evidence — terminal recordings, HTTP cycles, uploaded files, etc.) so the
  // client can download the report and its raw evidence together. The bundle's
  // supporting-files match the report's "Files Attached" table exactly.
  app.get(
    '/engagements/:slug/findings/report.zip',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const q = req.query as Record<string, string | undefined>;
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });

      // Compute the supporting-file set once (names + hashes) and reuse it for
      // both the report's Files Attached table and the ZIP entries.
      const files = await gatherSupportingFiles(app, eng);
      const html = await buildReportHtml(
        app,
        eng,
        new Date(),
        reportOptionsFromQuery(q),
        req.authedUser!.id,
        files,
      );
      const pdf = await renderPdf(app, html);

      const base = `${slug}-report-${stamp()}`;
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('warning', (err: unknown) => app.log.warn({ err }, 'zip warning'));
      archive.on('error', (err: unknown) => app.log.error({ err }, 'zip error'));

      reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${base}.zip"`);
      // Begin streaming the archive to the response, then feed entries in so the
      // archiver drains as we go (bounded memory even for large supporting files).
      reply.send(archive);

      archive.append(pdf, { name: `${base}.pdf` });
      for (const f of files) {
        const buf = await app.blobs.getBuffer(f.blobKey).catch(() => null);
        if (buf) archive.append(buf, { name: `supporting-files/${f.filename}` });
      }
      if (files.length > 0) {
        const manifest =
          files.map((f) => `${f.sha256}  supporting-files/${f.filename}`).join('\n') + '\n';
        archive.append(manifest, { name: 'supporting-files/SHA256SUMS.txt' });
      }
      await archive.finalize();
      return reply;
    },
  );

  // --- Config-driven report generation (the Reports section) ---------------
  // These use the engagement's saved `reportConfig` (ordered/toggleable sections
  // + options) rather than query params, or — with `?templateUuid=<uuid>` — a saved
  // report template's configuration for that one run, writing nothing back to the
  // engagement (see `reportForRun`). The legacy `/findings/*` routes above stay for
  // the client API and back-compat.

  app.get(
    '/engagements/:slug/report.pdf',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const q = req.query as Record<string, string | undefined>;
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const { options, label, preset, historyLabel } = await reportForRun(app, eng, q);
      const html = await buildReportHtml(app, eng, new Date(), options, req.authedUser!.id);
      const pdf = await renderPdf(app, html);
      const filename = `${slug}-${label}-${stamp()}.pdf`;
      await recordReport(app, {
        eng,
        preset,
        label: historyLabel,
        format: 'pdf',
        options,
        userId: req.authedUser!.id,
        artifact: { buffer: pdf, contentType: 'application/pdf', filename },
      });
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(pdf);
    },
  );

  app.get(
    '/engagements/:slug/report.zip',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const q = req.query as Record<string, string | undefined>;
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const { options, label, preset, historyLabel } = await reportForRun(app, eng, q);
      const files = await gatherSupportingFiles(app, eng);
      const html = await buildReportHtml(app, eng, new Date(), options, req.authedUser!.id, files);
      const pdf = await renderPdf(app, html);

      const base = `${slug}-${label}-${stamp()}`;
      const filename = `${base}.zip`;
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('warning', (err: unknown) => app.log.warn({ err }, 'zip warning'));
      archive.on('error', (err: unknown) => app.log.error({ err }, 'zip error'));

      // Buffer the whole archive so the exact bytes can be both sent to the
      // client and stored for re-download. Collect chunks as the archiver emits
      // them, then concat once finalized.
      const chunks: Buffer[] = [];
      archive.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      archive.append(pdf, { name: `${base}.pdf` });
      for (const f of files) {
        const buf = await app.blobs.getBuffer(f.blobKey).catch(() => null);
        if (buf) archive.append(buf, { name: `supporting-files/${f.filename}` });
      }
      if (files.length > 0) {
        const manifest =
          files.map((f) => `${f.sha256}  supporting-files/${f.filename}`).join('\n') + '\n';
        archive.append(manifest, { name: 'supporting-files/SHA256SUMS.txt' });
      }
      await archive.finalize();
      const zip = Buffer.concat(chunks);

      await recordReport(app, {
        eng,
        preset,
        label: historyLabel,
        format: 'zip',
        options,
        userId: req.authedUser!.id,
        artifact: { buffer: zip, contentType: 'application/zip', filename },
      });
      reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(zip);
    },
  );

  app.get(
    '/engagements/:slug/report.json',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const q = req.query as Record<string, string | undefined>;
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const { options, label, preset, historyLabel } = await reportForRun(app, eng, q);
      // Deliberately no `includeExcludedEvidence` here, unlike
      // `/findings/export.json`. This route is a *generated report* in the chosen
      // preset: it carries that preset's label, it is recorded in report history,
      // and its exact bytes are stored for re-download by anyone with read access.
      // A backup containing report-excluded evidence must never become an
      // indistinguishable row in that deliverable trail, where a later re-download
      // could hand it to a client. It also could not be a real backup anyway — a
      // preset only exports report-ready findings. Full backups go through
      // `/findings/export.json`, which stores nothing.
      const data = await buildFindingsExport(app, eng, new Date(), {
        includeAll: options.includeAll ?? false,
        includeEvidenceContent: boolParam(q.includeEvidenceContent),
      });
      // Serialize once so the bytes we send and the bytes we store are identical.
      const buffer = Buffer.from(JSON.stringify(data));
      const filename = `${slug}-${label}-${stamp()}.json`;
      await recordReport(app, {
        eng,
        preset,
        label: historyLabel,
        format: 'json',
        options,
        userId: req.authedUser!.id,
        artifact: { buffer, contentType: 'application/json', filename },
      });
      reply
        .header('Content-Type', 'application/json')
        .header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(buffer);
    },
  );

  // Live section preview (HTML) for the Reports → Configure panel. Renders a
  // single section exactly as it would appear in the report, using the saved
  // custom config's sub-item toggles + content — no cover/TOC/watermark, no
  // Puppeteer, and never recorded in report history. Shown in a same-origin
  // iframe, so it authenticates with the session cookie like any /web route.
  app.get(
    '/engagements/:slug/report/section-preview.html',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const q = req.query as Record<string, string | undefined>;
      const section = strParam(q.section);
      if (!section) throw new HttpError(400, 'A section key is required');
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const config = reportConfigSchema.parse(eng.reportConfig ?? {});
      const options: ReportOptions = {
        ...reportOptionsFromConfig(config),
        previewSectionKey: section,
      };
      const html = await buildReportHtml(app, eng, new Date(), options, req.authedUser!.id);
      reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store');
      return reply.send(html);
    },
  );

  // --- Report history + attestation letters --------------------------------
  // Every preset generation — PDF, ZIP and JSON alike — is logged (see
  // recordReport); this is the audit trail the Reports tab shows. Only a PDF or a
  // ZIP can be attested to (see findReportForLetter).
  app.get(
    '/engagements/:slug/reports/history',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      return listReportHistory(app, eng.id);
    },
  );

  // Re-download a previously generated report's stored artifact bytes. Reports
  // generated before artifact storage have no blobKey and can't be served.
  //
  // A stored artifact is deliberately immutable: it is the record of what was
  // handed over, so it keeps the report exclusions that were in force when it was
  // generated. Excluding evidence today therefore does not redact yesterday's
  // PDF/ZIP, and nothing here rewrites stored bytes. That is a stated decision
  // rather than an oversight — both the Reports tab (next to the history list) and
  // the evidence Report card say so, so an operator who has just excluded something
  // knows to generate a fresh report instead of assuming the old download changed.
  app.get(
    '/engagements/:slug/reports/:uuid/download',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req, reply) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const row = await app.db.generatedReport.findFirst({
        where: { engagementId: eng.id, uuid },
      });
      if (!row) throw new HttpError(404, 'Report not found');
      if (!row.blobKey) {
        throw new HttpError(
          404,
          'This report was generated before downloads were stored and can no longer be re-downloaded.',
        );
      }
      // LocalStore.get() returns a lazy read stream that only errors on read, so an
      // absent file would surface mid-response as a broken stream instead of a clean
      // 404. Check existence up front, before any bytes/headers are sent.
      const present = await app.blobs.exists(row.blobKey).catch(() => false);
      if (!present) {
        app.log.error({ key: row.blobKey }, 'report artifact blob missing');
        throw new HttpError(404, 'Report not found');
      }
      const stream = await app.blobs.get(row.blobKey);
      reply
        .header('Content-Type', row.contentType ?? 'application/octet-stream')
        .header(
          'Content-Disposition',
          `attachment; filename="${row.filename ?? `${slug}-report-${row.version}`}"`,
        );
      return reply.send(stream);
    },
  );

  // Attestation letter (PDF). Only available once a report has been generated:
  // the letter attests to a specific `GeneratedReport` (the latest by default,
  // or `?reportUuid=`), so its stated results stay consistent with that report.
  app.get(
    '/engagements/:slug/attestation-letter.pdf',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const q = req.query as Record<string, string | undefined>;
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });

      const report = await findReportForLetter(app, eng.id, strParam(q.reportUuid));
      if (!report) {
        throw new HttpError(
          409,
          'Generate a report before creating an attestation letter for this engagement.',
        );
      }

      const framework = frameworkParam(q.framework);
      const html = await buildAttestationLetterHtml(app, report, new Date(), {
        framework,
        frameworkLabel: strParam(q.frameworkLabel),
        signatoryName: strParam(q.signatoryName),
        signatoryTitle: strParam(q.signatoryTitle),
        signatoryEmail: strParam(q.signatoryEmail),
        recipientName: strParam(q.recipientName),
        recipientTitle: strParam(q.recipientTitle),
        salutationName: strParam(q.salutationName),
        showExclusions: boolParam(q.showExclusions),
        overallRisk: severityParam(q.overallRisk),
      });
      const pdf = await renderPdf(app, html);
      reply
        .header('Content-Type', 'application/pdf')
        .header(
          'Content-Disposition',
          `attachment; filename="${slug}-attestation-letter-${framework}-${stamp()}.pdf"`,
        );
      return reply.send(pdf);
    },
  );
}
