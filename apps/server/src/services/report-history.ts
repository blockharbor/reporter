/**
 * Report history: the audit trail behind the Reports tab. Every time a report
 * document (PDF, ZIP or JSON) is generated we record a `GeneratedReport` row *and*
 * store the rendered bytes, so the row is the deliverable rather than a pointer at
 * one — `sha256` is taken over exactly the buffer that was sent to the client, and
 * the row also snapshots the findings tallies so an attestation letter issued later
 * stays consistent with the report as generated.
 *
 * Nothing here ever rewrites a stored artifact. Re-downloading a past version
 * replays those bytes, which is what makes later changes — editing a finding,
 * flagging evidence `excludeFromReport` — stop at the next generation instead of
 * retroactively altering what was delivered. See `model GeneratedReport` in
 * `schema.prisma` for the rest of that reasoning.
 *
 * Recording is best-effort: callers wrap it so a history hiccup never fails the
 * actual download.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { GeneratedReport as GeneratedReportRow, Prisma } from '@prisma/client';
import {
  REPORT_PRESET_LABELS,
  generatedReportSchema,
  type GeneratedReport,
  type GeneratedReportFormat,
  type ReportPreset,
} from '@reporter/shared';
import {
  AUDIT_TX_MAX_WAIT_MS,
  AUDIT_TX_TIMEOUT_MS,
  auditCtxFromContext,
  inTx,
  recordAudit,
  withIntent,
  type AuditCtx,
} from './audit.js';
import { computeReportSummary, type ReportOptions } from './findings-report.js';

/**
 * Namespace for the per-engagement Postgres advisory lock that serializes report
 * version assignment. Arbitrary, but distinct so it can't collide with any other
 * advisory lock the app might take.
 */
const REPORT_VERSION_LOCK_NS = 918_273;

interface RecordArgs {
  eng: { id: number; slug: string; name: string };
  /** The report "type" (drives the recorded label). */
  preset: ReportPreset;
  /**
   * Overrides the preset-derived label. Set when a saved report template drove the
   * generation: the row still records the preset actually rendered, but the history
   * has to name the template instead of claiming the engagement's own configured
   * sections produced it.
   */
  label?: string;
  format: GeneratedReportFormat;
  /** The exact options the report was rendered with, so the snapshot matches. */
  options: ReportOptions;
  /** The operator who generated the report (null-safe: SET NULL on user delete). */
  userId: number;
  /** The rendered artifact bytes to persist so the report can be re-downloaded. */
  artifact: { buffer: Buffer; contentType: string; filename: string };
  /**
   * The audit context of the request that generated the report, so the
   * `report_generated` entry is attributed to the operator and stamped with the
   * engagement. Optional only for callers with no request in hand (tests and
   * scripts call this directly): they fall back to the ambient context, which
   * outside a request is a `via: 'system'` row — still recorded, never skipped.
   */
  audit?: AuditCtx;
}

/**
 * Record that a report was generated. `version` counts up per engagement
 * (`v1.0`, `v2.0`, …) so an attestation letter can name the exact deliverable.
 */
export async function recordGeneratedReport(
  app: FastifyInstance,
  { eng, preset, label, format, options, userId, artifact, audit }: RecordArgs,
): Promise<void> {
  const summary = await computeReportSummary(app, eng, options);
  const ctx = audit ?? auditCtxFromContext(app.db, app.log, eng);
  const historyLabel = label ?? REPORT_PRESET_LABELS[preset];
  // Serialize per-engagement so two concurrent generations (e.g. a PDF and a ZIP
  // back-to-back) can't read the same count and mint duplicate version labels.
  // The transaction-scoped advisory lock is released automatically at commit.
  // Only version assignment + row creation happen inside the lock; the blob write
  // is done afterwards so the per-engagement advisory lock isn't held during I/O.
  //
  // The audit entry for the generation is written INSIDE the same transaction,
  // through `tx`, so the history row and its log entry commit or roll back as
  // one — and `withIntent(['generatedReport'])` tells the backstop this scope
  // describes the create itself (the backstop cannot see inside a transaction
  // and would otherwise log an unwrapped write). The entry carries the options
  // the document was actually rendered with and the findings tally the row
  // snapshots; the artifact size is known here because the bytes are in hand.
  const created = await withIntent(['generatedReport'], () =>
    app.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REPORT_VERSION_LOCK_NS}::int4, ${eng.id}::int4)`;
        const priorCount = await tx.generatedReport.count({ where: { engagementId: eng.id } });
        const row = await tx.generatedReport.create({
          data: {
            engagementId: eng.id,
            preset,
            label: historyLabel,
            version: `v${priorCount + 1}.0`,
            format,
            summary: summary as unknown as Prisma.InputJsonValue,
            generatedById: userId,
          },
        });
        const fmt = format.toUpperCase();
        await recordAudit(inTx(ctx, tx), {
          action: 'report_generated',
          entityType: 'generated_report',
          entity: { id: row.uuid, label: `${row.label} ${row.version}` },
          summary: `Generated report ${row.version} (${fmt}) — ${row.label}`,
          changes: [
            { kind: 'field', field: 'preset', from: null, to: preset },
            { kind: 'field', field: 'format', from: null, to: format },
            { kind: 'field', field: 'label', from: null, to: row.label },
            { kind: 'count', label: 'Findings in report', count: summary.findingsTotal },
            { kind: 'count', label: 'Bytes', count: artifact.buffer.length },
          ],
          engagement: eng,
        });
        return row;
      },
      { maxWait: AUDIT_TX_MAX_WAIT_MS, timeout: AUDIT_TX_TIMEOUT_MS },
    ),
  );

  // Persist the artifact bytes to the blob store so the report can be
  // re-downloaded later. If this fails the row stays without a blobKey (recorded
  // but not downloadable) — never rethrow past the caller's best-effort boundary.
  // This patch is deliberately NOT under `withIntent`: it runs outside the
  // transaction and touches only columns the GeneratedReport model spec ignores
  // (blobKey, filename, sizeBytes, contentType, sha256), so the backstop sees it
  // and records nothing — the generation entry above already says the bytes.
  try {
    const key = `reports/${eng.id}/${created.uuid}.${format}`;
    await app.blobs.put(key, artifact.buffer);
    const sha = createHash('sha256').update(artifact.buffer).digest('hex');
    await app.db.generatedReport.update({
      where: { id: created.id },
      data: {
        blobKey: key,
        filename: artifact.filename,
        sizeBytes: artifact.buffer.length,
        contentType: artifact.contentType,
        sha256: sha,
      },
    });
  } catch (err) {
    app.log.error({ err }, 'failed to store report artifact; recorded without a download');
  }
}

/** Recent report generations for an engagement, newest first (for the UI). */
export async function listReportHistory(
  app: FastifyInstance,
  engagementId: number,
): Promise<GeneratedReport[]> {
  const rows = await app.db.generatedReport.findMany({
    where: { engagementId },
    orderBy: { createdAt: 'desc' },
    include: { generatedBy: true },
  });
  return rows.map((r) =>
    generatedReportSchema.parse({
      uuid: r.uuid,
      preset: r.preset,
      label: r.label,
      version: r.version,
      format: r.format,
      summary: r.summary,
      downloadable: r.blobKey != null,
      sizeBytes: r.sizeBytes ?? null,
      generatedBy: r.generatedBy
        ? `${r.generatedBy.firstName} ${r.generatedBy.lastName}`.trim()
        : null,
      createdAt: r.createdAt.toISOString(),
    }),
  );
}

/**
 * Resolve the report an attestation letter should attest to: the named one
 * (scoped to the engagement) or, absent a uuid, the most recent. Returns null
 * when the engagement has no report history yet — the letter is gated on this.
 * A JSON export is a portable data dump, not a client deliverable, so it is
 * never a valid attestation target (a named JSON uuid resolves to null too).
 */
export function findReportForLetter(
  app: FastifyInstance,
  engagementId: number,
  reportUuid?: string,
): Promise<GeneratedReportRow | null> {
  return app.db.generatedReport.findFirst({
    where: {
      engagementId,
      format: { in: ['pdf', 'zip'] },
      ...(reportUuid ? { uuid: reportUuid } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}
