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
}

/**
 * Record that a report was generated. `version` counts up per engagement
 * (`v1.0`, `v2.0`, …) so an attestation letter can name the exact deliverable.
 */
export async function recordGeneratedReport(
  app: FastifyInstance,
  { eng, preset, label, format, options, userId, artifact }: RecordArgs,
): Promise<void> {
  const summary = await computeReportSummary(app, eng, options);
  // Serialize per-engagement so two concurrent generations (e.g. a PDF and a ZIP
  // back-to-back) can't read the same count and mint duplicate version labels.
  // The transaction-scoped advisory lock is released automatically at commit.
  // Only version assignment + row creation happen inside the lock; the blob write
  // is done afterwards so the per-engagement advisory lock isn't held during I/O.
  const created = await app.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REPORT_VERSION_LOCK_NS}::int4, ${eng.id}::int4)`;
    const priorCount = await tx.generatedReport.count({ where: { engagementId: eng.id } });
    return tx.generatedReport.create({
      data: {
        engagementId: eng.id,
        preset,
        label: label ?? REPORT_PRESET_LABELS[preset],
        version: `v${priorCount + 1}.0`,
        format,
        summary: summary as unknown as Prisma.InputJsonValue,
        generatedById: userId,
      },
    });
  });

  // Persist the artifact bytes to the blob store so the report can be
  // re-downloaded later. If this fails the row stays without a blobKey (recorded
  // but not downloadable) — never rethrow past the caller's best-effort boundary.
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
