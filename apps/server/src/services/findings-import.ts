/**
 * Import a findings export (report.json) into an engagement.
 *
 * Findings are upserted by uuid (so re-importing the same file is idempotent);
 * a uuid that already belongs to a *different* engagement is skipped to avoid
 * stealing another engagement's data. Evidence is matched by uuid: an existing
 * item is re-linked, an embedded item (contentBase64) is recreated with its
 * original uuid, and a reference-only item with no local copy is skipped. A
 * finding's evidence links are reconciled to the file's set — but only as far as
 * the file was entitled to describe them: see the converge step for why a
 * report-filtered export cannot detach report-excluded evidence.
 *
 * The import is intentionally NOT wrapped in one transaction (blob writes are
 * side effects outside the DB, and imports can be large). It is instead
 * idempotent: if it fails partway, re-running the same file converges — created
 * findings become no-op updates and the rest are created.
 */
import type { FastifyInstance } from 'fastify';
import {
  MAX_IMPORT_FINDINGS,
  type FindingsExport,
  type FindingsImportResult,
} from '@reporter/shared';
import { HttpError } from '../auth/guards.js';
import { REPORT_VISIBLE_EVIDENCE } from '../helpers/report-visibility.js';
import { createEvidence } from './evidence.js';

interface EngagementRef {
  id: number;
  slug: string;
}

/** Cap on the total number of evidence items a single import may materialize. */
const MAX_IMPORT_TOTAL_EVIDENCE = 10_000;

async function categoryIdFor(
  app: FastifyInstance,
  engagementId: number,
  name: string | null,
): Promise<number | null> {
  if (!name) return null;
  // Categories are per-engagement; revive a soft-deleted one so an import never
  // links a finding to a hidden/zombie category.
  const cat = await app.db.findingCategory.upsert({
    where: { engagementId_category: { engagementId, category: name } },
    create: { engagementId, category: name },
    update: { deletedAt: null },
  });
  return cat.id;
}

export async function importFindings(
  app: FastifyInstance,
  eng: EngagementRef,
  data: FindingsExport,
  operatorId: number,
): Promise<FindingsImportResult> {
  // Bound total work up front (before any writes) so a crafted file can't
  // materialize an unbounded number of rows/blobs. Per-array caps are enforced
  // by the schema (MAX_IMPORT_FINDINGS / MAX_IMPORT_EVIDENCE_PER_FINDING).
  const totalEvidence = data.findings.reduce((n, f) => n + f.evidence.length, 0);
  if (data.findings.length > MAX_IMPORT_FINDINGS || totalEvidence > MAX_IMPORT_TOTAL_EVIDENCE) {
    throw new HttpError(413, 'Import is too large');
  }

  const result: FindingsImportResult = {
    findingsCreated: 0,
    findingsUpdated: 0,
    findingsSkipped: 0,
    evidenceCreated: 0,
    evidenceLinked: 0,
    evidenceSkipped: 0,
  };

  for (const f of data.findings) {
    const existing = await app.db.finding.findUnique({
      where: { uuid: f.uuid },
      select: { id: true, engagementId: true },
    });
    if (existing && existing.engagementId !== eng.id) {
      result.findingsSkipped++;
      continue;
    }

    const findingData = {
      title: f.title,
      description: f.description,
      kind: f.kind,
      affectedTarget: f.affectedTarget,
      impact: f.impact,
      fixEffort: f.fixEffort,
      iso21434Refs: f.iso21434Refs,
      unr155Refs: f.unr155Refs,
      remediation: f.remediation,
      categoryId: await categoryIdFor(app, eng.id, f.category),
      severity: f.severity,
      cvssVector: f.cvssVector,
      cvssScore: f.cvssScore,
      readyToReport: f.readyToReport,
      position: f.position,
    };

    // Mirror the live create/update routes: a strength carries no risk rating or
    // remediation, so never import those onto one (a crafted export can't smuggle
    // an inconsistent strength into the weaknesses dashboard/tables).
    if (findingData.kind === 'strength') {
      findingData.severity = null;
      findingData.cvssVector = null;
      findingData.cvssScore = null;
      findingData.fixEffort = 'none';
      findingData.impact = '';
      findingData.remediation = '';
    }

    let findingId: number;
    if (existing) {
      await app.db.finding.update({ where: { id: existing.id }, data: findingData });
      findingId = existing.id;
      result.findingsUpdated++;
    } else {
      const created = await app.db.finding.create({
        data: { uuid: f.uuid, engagementId: eng.id, ...findingData },
        select: { id: true },
      });
      findingId = created.id;
      result.findingsCreated++;
    }

    const keptEvidenceIds: number[] = [];
    // Positions are per-bucket (Attack Path vs Attached Evidence), so track the
    // next slot in each bucket independently rather than using the array index.
    const bucketNext = { path: 0, attached: 0 };
    for (let i = 0; i < f.evidence.length; i++) {
      const ev = f.evidence[i]!;
      let evRow = await app.db.evidence.findUnique({
        where: { uuid: ev.uuid },
        select: { id: true, engagementId: true },
      });

      if (evRow && evRow.engagementId !== eng.id) {
        result.evidenceSkipped++;
        continue;
      }

      if (!evRow) {
        if (!ev.contentBase64) {
          // Reference-only export with no local copy of this evidence.
          result.evidenceSkipped++;
          continue;
        }
        await createEvidence(app, {
          engagementId: eng.id,
          engagementSlug: eng.slug,
          operatorId,
          uuid: ev.uuid,
          metadata: {
            title: ev.title,
            description: ev.description,
            contentType: ev.contentType,
            contentSubtype: ev.contentSubtype ?? undefined,
            originalFilename: ev.originalFilename ?? undefined,
            occurredAt: ev.occurredAt,
            tagIds: [],
            // Restore the report exclusion the export recorded, so an export →
            // import round trip reproduces both the evidence and its exclusion
            // rather than silently re-admitting it to every report output.
            excludeFromReport: ev.excludeFromReport,
          },
          file: {
            data: Buffer.from(ev.contentBase64, 'base64'),
            mimeType: 'application/octet-stream',
            filename: ev.originalFilename ?? ev.uuid,
          },
        });
        evRow = await app.db.evidence.findUnique({
          where: { uuid: ev.uuid },
          select: { id: true, engagementId: true },
        });
        if (!evRow) {
          result.evidenceSkipped++;
          continue;
        }
        result.evidenceCreated++;
      } else {
        result.evidenceLinked++;
      }

      const inPath = ev.inPath;
      const position = inPath ? bucketNext.path++ : bucketNext.attached++;
      await app.db.evidenceFinding.upsert({
        where: { evidenceId_findingId: { evidenceId: evRow.id, findingId } },
        create: { evidenceId: evRow.id, findingId, position, caption: ev.caption, inPath },
        update: { position, caption: ev.caption, inPath },
      });
      keptEvidenceIds.push(evRow.id);
    }

    // Converge: drop any previously-linked evidence that's no longer in the file
    // (so re-importing an edited export detaches removed evidence too).
    //
    // Scoped to links the file could actually have mentioned. A default export is
    // report-filtered: `buildFindingsExport` leaves report-excluded evidence out,
    // so its absence from the file means "withheld", not "unlinked". Converging
    // against it unrestricted would silently delete the finding's link to that
    // evidence — along with its Attack Path bucket, position and caption, which
    // for a path step *is* the content — leaving the row orphaned with nothing in
    // the import result to hint at it. Same principle as the create-only
    // `excludeFromReport` restore above: the live decision about excluded evidence
    // belongs to the operator who made it, not to a file that cannot see it. A
    // backup export (`includesExcludedEvidence`) does describe those links, so its
    // removals apply in full.
    await app.db.evidenceFinding.deleteMany({
      where: {
        findingId,
        ...(keptEvidenceIds.length === 0 ? {} : { evidenceId: { notIn: keptEvidenceIds } }),
        ...(data.includesExcludedEvidence ? {} : { evidence: REPORT_VISIBLE_EVIDENCE }),
      },
    });
  }

  return result;
}
