/**
 * Full engagement export — the writer for the `.zip` container described by
 * `engagementExportSchema` in @reporter/shared.
 *
 * This is a **backup** of one whole engagement: enough to recreate it on another
 * reporter server. It is not the findings export (`buildFindingsExport`), which is
 * a deliverable-shaped, findings-scoped JSON file for moving findings between
 * engagements and stays exactly as it is.
 *
 * Container layout (entry order is part of the format):
 *
 *   manifest.json      format marker, schema version, counts, source identity
 *   engagement.json    every record
 *   blobs/<sha256>     evidence content, thumbnails and stored report artifacts,
 *                      named by the sha-256 of their bytes
 *
 * The two JSON entries come first so a reader can validate the version and the
 * records before inflating a single blob (yauzl reads the central directory, so
 * pulling just those two entries out of a multi-gigabyte file is cheap).
 *
 * Because an import always creates a NEW engagement, nothing in the file has to
 * address a row on the destination server: the goal tree uses file-local keys, and
 * everything else is referenced by uuid, by tag name, or by content hash.
 *
 * No blob-store key ever leaves the server — `fullBlobKey`, `thumbBlobKey` and
 * `GeneratedReport.blobKey` are replaced by content hashes. That is structural, not
 * tidiness: the evidence DELETE route deletes blobs unconditionally, so if an
 * import reused a key from the file, deleting the imported copy would destroy the
 * source engagement's bytes. With only hashes in the file there is no key to reuse,
 * and an import has to allocate fresh ones through the blob store.
 *
 * ---------------------------------------------------------------------------
 * Coverage inventory — every model in `schema.prisma`, EXPORT or SKIP.
 * Keep this in step with the schema; it is the audit trail for what a backup is
 * promising to restore.
 * ---------------------------------------------------------------------------
 *
 * Engagement-owned, EXPORTED:
 *
 *  - Engagement — the row, including **every JSON column**: `scopeTargets`,
 *    `scopeExclusions`, `strategicRecommendations`, `threatModelDiagrams`,
 *    `executionNarrative`, `providerContacts`, `clientContacts`, `softwareTested`,
 *    `thirdPartySoftware`, `reportConfig` and the verbatim `proposalImport`.
 *  - EngagementTarget / TargetActivity / ActivityGoal — the goal tree, nested,
 *    with file-local keys (`t0`, `t0.a1`, `t0.a1.g2`). None of these three has a
 *    uuid column and none is added: keys unique within one file are sufficient
 *    because the import creates a new engagement, so no migration is needed.
 *  - GoalEvidence / GoalFinding — as each goal's `evidenceUuids` / `findingUuids`.
 *  - Tag — name + color; referenced elsewhere in the file by name, which is unique
 *    per engagement. `TargetActivity.tagId` travels as that name.
 *  - Evidence — including the self-referential parent link (`parentEvidenceUuid`,
 *    one level deep) and `excludeFromReport` (see "report exclusion" below).
 *  - EvidenceTag — as each evidence item's `tagNames`.
 *  - EvidenceComment — the internal discussion thread; authors by email only.
 *  - Finding — with its category by name.
 *  - FindingCategory — as its own list, so an unused or soft-deleted category
 *    survives the round trip rather than existing only as a name on a finding.
 *  - EvidenceFinding — as each finding's `evidenceLinks`, keeping `inPath`,
 *    `position` and `caption` (for an Attack Path step the caption *is* content).
 *  - FindingTag — as each finding's `tagNames`, from the same engagement `Tag`
 *    pool as `EvidenceTag` above. Its presence is what bumps the stamp to v2.
 *  - SavedQuery — the engagement's saved timeline/findings queries.
 *  - GeneratedReport — the report history **and** the stored artifact bytes.
 *
 *    The artifacts are the expensive part of this file (a PDF with screenshots is
 *    megabytes, and history grows one row per generation), so carrying them is a
 *    deliberate call. They travel because a history row is not a pointer at a
 *    deliverable, it *is* the deliverable: `sha256` is taken over those exact
 *    bytes, a ZIP artifact contains its own `SHA256SUMS.txt`, and an attestation
 *    letter attests to a named `version`. Restoring the rows without the bytes
 *    would silently flip `downloadable` to false and leave every one of those three
 *    claims pointing at a file that no longer exists — a backup that quietly loses
 *    the record of what was handed to the client. Nothing can regenerate them
 *    either: the bytes are immutable by design and re-rendering produces today's
 *    findings, not the ones that were delivered. The cost is made visible rather
 *    than hidden — `manifest.counts.blobs`/`blobBytes` state it up front, before a
 *    reader inflates anything — and the artifacts are handled exactly like evidence
 *    blobs: hashed, deduped, and re-keyed on import.
 *
 * SKIPPED, with reasons:
 *
 *  - User, AuthIdentity, WebauthnCredential, RecoveryCode, ApiKey, Session —
 *    credentials, second factors and sessions. An import must never create a user:
 *    a crafted file could otherwise mint an `admin: true` account, or re-create an
 *    account for an email freed by the hard delete and claim it through an admin
 *    recovery link. Authorship therefore travels as an email and is matched against
 *    existing local accounts; no match leaves the column null, which every display
 *    site already renders as "Deleted user".
 *  - UserEngagementRole — engagement membership is deliberately NOT exported. The
 *    user performing the import becomes the new engagement's owner. Memberships are
 *    local to a server (the emails may not exist there, or may belong to different
 *    people), and a file able to grant roles would be a file able to hand a
 *    stranger access to a destination server's engagement.
 *  - UserEngagementPref, UserEvidencePref — per-user favorites/stars. Someone
 *    else's view preferences, not engagement data.
 *  - EvidenceMetadata — verified dead code: the model has zero reads and zero
 *    writes anywhere in the tree (`evidenceMetadata` appears in no source file).
 *    Skipped, and called out here so the gap is a decision rather than an oversight.
 *  - ReportSettings — a GLOBAL singleton (id = 1): site-wide report branding, not
 *    engagement-owned, and the destination server has its own.
 *  - ReportTemplate — also global: a site-wide library of named report
 *    configurations, applicable to any engagement. An engagement's own
 *    `reportConfig` does travel, which is the part that belongs to it.
 *  - DefaultTag — global seed list used when creating an engagement's tags.
 *
 * Report exclusion: a backup is not a deliverable, so evidence flagged
 * `excludeFromReport` is carried **with the flag intact** and this export has no
 * `includeExcludedEvidence` opt-in. That opt-in exists on the findings export
 * because that file is deliverable-shaped and its default view is report-filtered;
 * here, omitting excluded evidence would silently produce a backup that cannot
 * restore the engagement.
 */
import { createHash } from 'node:crypto';
import archiver from 'archiver';
import type { FastifyInstance } from 'fastify';
import type { Engagement as EngagementRow } from '@prisma/client';
import { FINDING_TAG_ORDER_BY, TAG_ORDER_BY } from './tags.js';
import {
  ENGAGEMENT_EXPORT_BLOB_PREFIX,
  ENGAGEMENT_EXPORT_DATA_ENTRY,
  ENGAGEMENT_EXPORT_FORMAT,
  ENGAGEMENT_EXPORT_MANIFEST_ENTRY,
  ENGAGEMENT_EXPORT_VERSION,
  ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS,
  engagementExportManifestSchema,
  engagementExportSchema,
  reportConfigSchema,
  type EngagementExport,
  type EngagementExportManifest,
  type ExportedEngagement,
  type ExportedTarget,
} from '@reporter/shared';

/** The archiver instance type, without naming archiver's `export =` namespace. */
type ArchiveStream = ReturnType<typeof archiver>;

/**
 * A prepared export: the archive already carries `manifest.json` and
 * `engagement.json`, and {@link EngagementExportStream.finalize} appends the blob
 * entries and closes it.
 *
 * Split in two so the caller can start streaming the archive to the client
 * *before* the blobs are fed in — the archiver then drains as entries are appended
 * and a large engagement doesn't pile up in memory. Same shape as the report ZIP
 * route (`reply.send(archive)` and then feed).
 */
export interface EngagementExportStream {
  archive: ArchiveStream;
  /** The manifest written as the first entry (handy for logging the counts). */
  manifest: EngagementExportManifest;
  finalize(): Promise<void>;
}

/** A blob that will be written as `blobs/<hash>`, read from `key` in the store. */
interface PlannedBlob {
  hash: string;
  size: number;
  key: string;
}

/**
 * Resolve the content hash + size of every blob the export references.
 *
 * Hashing happens here, up front, because the entries are *content-addressed*:
 * `engagement.json` names each blob by hash and is written before any of them, so
 * every hash has to be known before a single blob entry is appended. Blobs are
 * streamed through the digest rather than buffered, which costs a second read of
 * each blob later (when it is appended) but keeps memory flat — buffering every
 * blob so one read could serve both purposes is unbounded for a real engagement.
 *
 * The stored `Evidence.sha256` / `GeneratedReport.sha256` columns are deliberately
 * not trusted as a shortcut: the entry name is a content address, so a stale or
 * absent column would make `blobs/<hash>` a lie that only surfaces when an import
 * verifies what it inflated.
 *
 * A key that cannot be read is dropped with a warning rather than failing the
 * export: a missing blob is already a broken download in the app, and a backup of
 * everything else is worth more than no backup at all. The reference comes out
 * null, so the import recreates the row without content.
 */
async function planBlobs(
  app: FastifyInstance,
  keys: readonly string[],
): Promise<{ byKey: Map<string, string>; entries: PlannedBlob[]; totalBytes: number }> {
  const byKey = new Map<string, string>();
  // Deduped by hash: two identical blobs (the same screenshot captured twice, or a
  // report artifact re-generated byte-for-byte) collapse into one entry for free.
  const byHash = new Map<string, PlannedBlob>();

  for (const key of new Set(keys)) {
    const hash = createHash('sha256');
    let size = 0;
    try {
      const stream = await app.blobs.get(key);
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        hash.update(buf);
        size += buf.length;
      }
    } catch (err) {
      app.log.warn({ err, key }, 'engagement export: blob unreadable, exporting without it');
      continue;
    }
    const digest = hash.digest('hex');
    byKey.set(key, digest);
    if (!byHash.has(digest)) byHash.set(digest, { hash: digest, size, key });
  }

  const entries = [...byHash.values()];
  return { byKey, entries, totalBytes: entries.reduce((n, b) => n + b.size, 0) };
}

/** The engagement row's own fields, including every JSON column. */
function exportEngagement(eng: EngagementRow): ExportedEngagement {
  // The JSON columns are validated by zod on write (`updateEngagementInput`), so
  // they are cast here the way the engagement serializer casts them; the single
  // `engagementExportSchema.parse` at the end of `buildEngagementExport` is what
  // actually re-checks them, which means a column corrupted by hand fails loudly
  // at export time instead of becoming an unimportable file.
  const json = eng as unknown as Record<string, unknown>;
  const list = <T>(value: unknown): T[] => (value as T[] | null) ?? [];

  return {
    slug: eng.slug,
    name: eng.name,
    status: eng.status,
    createdAt: eng.createdAt.toISOString(),
    startedAt: eng.startedAt.toISOString(),
    projectedEndAt: eng.projectedEndAt?.toISOString() ?? null,
    actualEndAt: eng.actualEndAt?.toISOString() ?? null,
    clientName: eng.clientName,
    assessmentType: eng.assessmentType,
    testApproach: eng.testApproach,
    location: eng.location,
    scope: eng.scope,
    executiveSummary: eng.executiveSummary,
    methodology: eng.methodology,
    objectivesNarrative: eng.objectivesNarrative,
    watermarkEnabled: eng.watermarkEnabled,
    watermarkText: eng.watermarkText,
    watermarkColor: eng.watermarkColor,
    watermarkOpacity: eng.watermarkOpacity as ExportedEngagement['watermarkOpacity'],
    watermarkLayer: eng.watermarkLayer as ExportedEngagement['watermarkLayer'],
    scopeTargets: list(json.scopeTargets),
    scopeExclusions: list(json.scopeExclusions),
    // Carries `findingUuids` — one of the two uuid cross-references an import has
    // to remap (the other is `executionNarrative[].evidence[].evidenceUuid`).
    strategicRecommendations: list(json.strategicRecommendations),
    threatModelNarrative: eng.threatModelNarrative,
    threatModelDiagrams: list(json.threatModelDiagrams),
    executionNarrative: list(json.executionNarrative),
    providerContacts: list(json.providerContacts),
    clientContacts: list(json.clientContacts),
    softwareTested: list(json.softwareTested),
    thirdPartySoftware: list(json.thirdPartySoftware),
    // Normalized to the canonical default when the engagement was never
    // configured (stored as `{}`), exactly as the read API returns it.
    reportConfig: reportConfigSchema.parse(eng.reportConfig ?? {}),
    proposalImport: eng.proposalImport ?? undefined,
  };
}

/**
 * Build the export for one engagement.
 *
 * Every table is read in one round trip (relations included, never per-row), and
 * the eight reads run concurrently: a large engagement must not N+1. Row metadata
 * is held in memory while blob *bytes* are streamed one at a time.
 */
export async function buildEngagementExport(
  app: FastifyInstance,
  eng: EngagementRow,
  exportedAt: Date,
): Promise<EngagementExportStream> {
  const [
    tags,
    targetRows,
    evidenceRows,
    commentRows,
    categoryRows,
    findingRows,
    queryRows,
    reportRows,
  ] = await Promise.all([
    // Curated order, so the importer can restore `position` from the array index.
    // Deliberately NOT a new `position` field on `exportedTagSchema`: array order
    // already carries it losslessly, which means no new field and no
    // ENGAGEMENT_EXPORT_VERSION decision.
    app.db.tag.findMany({
      where: { engagementId: eng.id },
      orderBy: TAG_ORDER_BY,
      select: { name: true, colorName: true },
    }),
    // The whole goal tree in one query, each level in its display order — the
    // order the file-local keys are derived from.
    app.db.engagementTarget.findMany({
      where: { engagementId: eng.id },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      include: {
        activities: {
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          include: {
            tag: { select: { name: true } },
            goals: {
              orderBy: [{ position: 'asc' }, { id: 'asc' }],
              include: {
                evidence: { select: { evidenceId: true }, orderBy: { evidenceId: 'asc' } },
                findings: { select: { findingId: true }, orderBy: { findingId: 'asc' } },
              },
            },
          },
        },
      },
    }),
    app.db.evidence.findMany({
      where: { engagementId: eng.id },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      include: {
        operator: { select: { email: true } },
        lastEditedBy: { select: { email: true } },
        parent: { select: { uuid: true } },
        tags: { select: { tag: { select: { name: true } } } },
      },
    }),
    app.db.evidenceComment.findMany({
      where: { evidence: { engagementId: eng.id } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        evidence: { select: { uuid: true } },
        author: { select: { email: true } },
      },
    }),
    app.db.findingCategory.findMany({
      where: { engagementId: eng.id },
      orderBy: { category: 'asc' },
      select: { category: true, deletedAt: true },
    }),
    app.db.finding.findMany({
      where: { engagementId: eng.id },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      include: {
        category: { select: { category: true } },
        // Curated order, so the same database state always produces the same
        // bytes — every other collection in this file is explicitly ordered too.
        tags: { select: { tag: { select: { name: true } } }, orderBy: FINDING_TAG_ORDER_BY },
        // Same ordering the report and the findings export use: Attack Path
        // first, then each bucket by its own position.
        evidence: {
          orderBy: [{ inPath: 'desc' }, { position: 'asc' }, { evidenceId: 'asc' }],
          include: { evidence: { select: { uuid: true } } },
        },
      },
    }),
    app.db.savedQuery.findMany({
      where: { engagementId: eng.id },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      select: { name: true, query: true, type: true },
    }),
    app.db.generatedReport.findMany({
      where: { engagementId: eng.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { generatedBy: { select: { email: true } } },
    }),
  ]);

  // Goal links come back as numeric ids; resolve them through the rows already
  // loaded rather than querying per goal.
  const evidenceUuidById = new Map(evidenceRows.map((e) => [e.id, e.uuid]));
  const findingUuidById = new Map(findingRows.map((f) => [f.id, f.uuid]));

  const blobKeys: string[] = [];
  for (const e of evidenceRows) {
    if (e.fullBlobKey) blobKeys.push(e.fullBlobKey);
    if (e.thumbBlobKey) blobKeys.push(e.thumbBlobKey);
  }
  for (const r of reportRows) if (r.blobKey) blobKeys.push(r.blobKey);
  const blobs = await planBlobs(app, blobKeys);
  const hashFor = (key: string | null): string | null =>
    (key === null ? null : blobs.byKey.get(key)) ?? null;

  let activityCount = 0;
  let goalCount = 0;
  const targets: ExportedTarget[] = targetRows.map((t, ti) => {
    const targetKey = `t${ti}`;
    activityCount += t.activities.length;
    return {
      key: targetKey,
      name: t.name,
      description: t.description,
      position: t.position,
      activities: t.activities.map((a, ai) => {
        const activityKey = `${targetKey}.a${ai}`;
        goalCount += a.goals.length;
        return {
          key: activityKey,
          name: a.name,
          category: a.category,
          tagName: a.tag?.name ?? null,
          position: a.position,
          goals: a.goals.map((g, gi) => ({
            key: `${activityKey}.g${gi}`,
            title: g.title,
            status: g.status,
            isRetest: g.isRetest,
            notes: g.notes,
            position: g.position,
            // A link to a row outside this engagement would be a data bug; drop
            // it rather than emitting a uuid the file never defines.
            evidenceUuids: g.evidence
              .map((l) => evidenceUuidById.get(l.evidenceId))
              .filter((u): u is string => u !== undefined),
            findingUuids: g.findings
              .map((l) => findingUuidById.get(l.findingId))
              .filter((u): u is string => u !== undefined),
          })),
        };
      }),
    };
  });

  // Conditional stamp — see ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS. A
  // backup whose findings are all untagged has nothing a v1 reader would strip,
  // so it keeps the older stamp and keeps importing on a pre-finding-tags server.
  // Stamped once and used for BOTH the records and the manifest: the importer
  // asserts the version on each, so the two must never disagree.
  const schemaVersion = findingRows.some((f) => f.tags.length > 0)
    ? ENGAGEMENT_EXPORT_VERSION
    : ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS;
  const data: EngagementExport = engagementExportSchema.parse({
    schemaVersion,
    exportedAt: exportedAt.toISOString(),
    engagement: exportEngagement(eng),
    tags,
    targets,
    evidence: evidenceRows.map((e) => ({
      uuid: e.uuid,
      title: e.title,
      description: e.description,
      contentType: e.contentType,
      contentSubtype: e.contentSubtype,
      originalFilename: e.originalFilename,
      occurredAt: e.occurredAt.toISOString(),
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
      fullBlobHash: hashFor(e.fullBlobKey),
      thumbBlobHash: hashFor(e.thumbBlobKey),
      tagNames: e.tags.map((t) => t.tag.name),
      parentEvidenceUuid: e.parent?.uuid ?? null,
      // Authorship by email only — an import matches local accounts and never
      // creates one.
      operatorEmail: e.operator?.email ?? null,
      lastEditedByEmail: e.lastEditedBy?.email ?? null,
      excludeFromReport: e.excludeFromReport,
    })),
    evidenceComments: commentRows.map((c) => ({
      uuid: c.uuid,
      evidenceUuid: c.evidence.uuid,
      authorEmail: c.author?.email ?? null,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    findingCategories: categoryRows.map((c) => ({
      category: c.category,
      deletedAt: c.deletedAt?.toISOString() ?? null,
    })),
    findings: findingRows.map((f) => ({
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
      category: f.category?.category ?? null,
      severity: f.severity,
      cvssVector: f.cvssVector,
      cvssScore: f.cvssScore,
      readyToReport: f.readyToReport,
      position: f.position,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
      tagNames: f.tags.map((t) => t.tag.name),
      evidenceLinks: f.evidence.map((l) => ({
        evidenceUuid: l.evidence.uuid,
        position: l.position,
        caption: l.caption,
        inPath: l.inPath,
      })),
    })),
    savedQueries: queryRows,
    generatedReports: reportRows.map((r) => ({
      uuid: r.uuid,
      preset: r.preset,
      label: r.label,
      version: r.version,
      format: r.format,
      summary: r.summary,
      generatedByEmail: r.generatedBy?.email ?? null,
      createdAt: r.createdAt.toISOString(),
      artifactBlobHash: hashFor(r.blobKey),
      filename: r.filename,
      contentType: r.contentType,
    })),
  });

  const manifest: EngagementExportManifest = engagementExportManifestSchema.parse({
    format: ENGAGEMENT_EXPORT_FORMAT,
    schemaVersion,
    exportedAt: data.exportedAt,
    engagement: { slug: eng.slug, name: eng.name },
    counts: {
      targets: targets.length,
      activities: activityCount,
      goals: goalCount,
      tags: data.tags.length,
      evidence: data.evidence.length,
      evidenceComments: data.evidenceComments.length,
      findingCategories: data.findingCategories.length,
      findings: data.findings.length,
      savedQueries: data.savedQueries.length,
      generatedReports: data.generatedReports.length,
      blobs: blobs.entries.length,
      blobBytes: blobs.totalBytes,
    },
  });

  // Compression level matches the report ZIP routes.
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (err: unknown) => app.log.warn({ err }, 'engagement export zip warning'));
  archive.on('error', (err: unknown) => app.log.error({ err }, 'engagement export zip error'));

  // Order matters: the manifest, then the records, then the bytes.
  archive.append(JSON.stringify(manifest), { name: ENGAGEMENT_EXPORT_MANIFEST_ENTRY });
  archive.append(JSON.stringify(data), { name: ENGAGEMENT_EXPORT_DATA_ENTRY });

  const finalize = async (): Promise<void> => {
    for (const blob of blobs.entries) {
      // Read one blob at a time and hand the buffer straight to the archiver, as
      // the report ZIP route does: the archive is already being consumed by the
      // caller, so each entry drains before the next is read.
      const buf = await app.blobs.getBuffer(blob.key).catch(() => null);
      if (!buf) {
        app.log.warn({ key: blob.key }, 'engagement export: blob vanished mid-export');
        continue;
      }
      archive.append(buf, { name: `${ENGAGEMENT_EXPORT_BLOB_PREFIX}${blob.hash}` });
    }
    await archive.finalize();
  };

  return { archive, manifest, finalize };
}
