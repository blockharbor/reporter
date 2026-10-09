/**
 * Full engagement import — the reader for the `.zip` container written by
 * `buildEngagementExport` (see `engagement-export.ts` for the format and the
 * export/skip inventory).
 *
 * **An import always creates a NEW engagement and can never modify an existing
 * one.** That is structural rather than a flag: the route (`POST
 * /web/engagements/import`) has no `:slug` segment, so no existing engagement is
 * addressable from here, and nothing below ever looks up an engagement by the
 * file's slug. The new slug is derived from the file and uniquified with
 * `uniqueSlug`, or supplied by the caller.
 *
 * Because of that, the file never has to address a row on this server: the goal
 * tree travels as file-local keys, tags by name, blobs by content hash, and
 * everything else by uuid *within the file*.
 *
 * ---------------------------------------------------------------------------
 * uuid policy: every imported row gets a FRESH uuid.
 * ---------------------------------------------------------------------------
 * `Evidence.uuid`, `Finding.uuid`, `EvidenceComment.uuid` and
 * `GeneratedReport.uuid` are globally unique, not per-engagement, so importing a
 * file into the server it came from — the ordinary case for a restore, or for
 * cloning an engagement as a template — would collide on every row. There is no
 * variant of "preserve the uuids" that is safe here.
 *
 * Minting new uuids is what makes the two uuid cross-references in the
 * engagement's JSON columns load-bearing:
 *
 *   - `strategicRecommendations[].findingUuids[]`  → finding uuids
 *   - `executionNarrative[].evidence[].evidenceUuid` → evidence uuids
 *
 * Those are the only uuid-typed fields in the report-content schemas (verified
 * against `recommendationItemSchema` and `executionEvidenceRefSchema` in
 * @reporter/shared; `executionNarrative[].timeline.tags` references tags by *name*,
 * which this import preserves, and `reportConfig`'s section keys / custom-section
 * ids reference no rows). Both are rendered with skip-if-dangling semantics, so a
 * missed remap would report a perfectly successful import and silently empty those
 * parts of the report — and, worse, if the old uuids were kept while importing back
 * into the source server, they would resolve against the *original* engagement's
 * rows. Both are therefore remapped through the old→new maps, and a reference the
 * file does not define is dropped and counted (`dropped.danglingEvidenceRefs` /
 * `dropped.danglingFindingRefs`) rather than carried over.
 *
 * ---------------------------------------------------------------------------
 * Ordering: blobs first, then one transaction, then a compensating delete.
 * ---------------------------------------------------------------------------
 * Blob writes are not transactional, so the two halves cannot commit together and
 * one of them has to go first. This is the *opposite* order from
 * `recordGeneratedReport` (`report-history.ts`), which creates the history row and
 * then stores the bytes best-effort — correct there, because a row without its
 * artifact is a visible, honest "not downloadable" state and the download the user
 * asked for must not fail over a history hiccup.
 *
 * An import inverts both halves of that reasoning. Rows written first would point
 * at blob keys whose bytes may never arrive, producing an engagement full of
 * evidence that renders as broken content with nothing marking it as incomplete —
 * and unlike a report, nothing can regenerate it. So blobs are written first, every
 * row is created in ONE transaction, and if that transaction throws, the blobs this
 * import wrote are deleted again (a compensating delete). A crash between the two
 * leaves blobs that no row references: inert bytes in the store, not a broken
 * engagement.
 *
 * The compensating delete is scoped to the region *before* the commit, and nothing
 * after it: once the transaction commits, those bytes are live content of a real
 * engagement, so deleting them on a later failure would be the worst outcome of all
 * — an engagement whose evidence points at bytes that no longer exist, while the
 * caller is told the import failed and nothing was created.
 *
 * Prisma's default interactive-transaction timeout is 5 s, which would break any
 * real import; it is raised explicitly below.
 *
 * ---------------------------------------------------------------------------
 * Users are matched, never created.
 * ---------------------------------------------------------------------------
 * An exported author is an email. It is matched case-insensitively against
 * non-deleted local accounts; with no match the column is left null, which every
 * display site already renders as `DELETED_USER_LABEL`. No placeholder rows: an
 * import that could create users could mint an `admin: true` account, or re-create
 * an account for an email freed by the hard delete and claim it through an admin
 * recovery link. Engagement membership is not in the file at all (see the export's
 * inventory) — the importing user becomes the new engagement's owner.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import {
  ENGAGEMENT_EXPORT_BLOB_PREFIX,
  ENGAGEMENT_EXPORT_DATA_ENTRY,
  ENGAGEMENT_EXPORT_MANIFEST_ENTRY,
  ENGAGEMENT_EXPORT_VERSION,
  engagementExportManifestSchema,
  engagementExportSchema,
  engagementImportResultSchema,
  type EngagementExport,
  type EngagementImportCreated,
  type EngagementImportInput,
  type EngagementImportResult,
  type ExecutionSubsection,
  type RecommendationItem,
} from '@reporter/shared';
import { HttpError } from '../auth/guards.js';
import { decodeScriptUpload } from './evidence.js';
import { uniqueSlug } from '../helpers/slug.js';
import { openZip, type ZipReader } from '../helpers/zip-read.js';

/**
 * How much larger than a single upload a whole-engagement archive may be.
 *
 * `MAX_UPLOAD_BYTES` bounds *one* evidence blob, which is the wrong bound for a
 * file that aggregates every blob in an engagement, so the import route raises its
 * body limit to this multiple of it (400 MB at the default). It is not raised
 * further because the upload is buffered in memory — the raw-body content-type
 * parser in `app.ts`, then busboy's copy of the file part — so the peak cost is a
 * few times the archive size. Lifting the ceiling beyond this means streaming the
 * upload to a temp file and opening *that* with yauzl, which the format already
 * allows (nothing here needs the whole archive in memory at once) but no route does
 * yet.
 */
const ARCHIVE_SIZE_FACTOR = 4;

/**
 * Ceiling on the total *inflated* size of the blobs an archive may restore,
 * relative to the archive's own size limit — i.e. the overall compression ratio an
 * import will honor. Checked against the central directory's declared sizes before
 * a single entry is inflated, so a zip bomb is refused rather than unpacked; yauzl
 * is opened with `validateEntrySizes`, which is what makes those declared sizes
 * binding. Screenshots and recordings barely compress, so 5× is generous for real
 * content while still bounded.
 */
const MAX_INFLATION_RATIO = 5;

/**
 * Raised interactive-transaction limits. Prisma's defaults (5 s timeout, 2 s
 * maxWait) are sized for a handful of statements and would abort any real import
 * partway; two minutes comfortably covers tens of thousands of rows while still
 * bounding a runaway, and 15 s of maxWait rides out a busy connection pool rather
 * than failing an import that has already written its blobs.
 */
const IMPORT_TRANSACTION_TIMEOUT_MS = 120_000;
const IMPORT_TRANSACTION_MAX_WAIT_MS = 15_000;

/** Cap on the unmatched-author emails echoed back, so the response stays bounded. */
const MAX_REPORTED_UNMATCHED_EMAILS = 25;

/** The body limit for the import route: see {@link ARCHIVE_SIZE_FACTOR}. */
export function engagementImportBodyLimit(app: FastifyInstance): number {
  return app.config.MAX_UPLOAD_BYTES * ARCHIVE_SIZE_FACTOR;
}

export interface EngagementImportArgs extends EngagementImportInput {
  /** The uploaded archive. */
  archive: Buffer;
  /** The user performing the import; becomes the new engagement's owner. */
  userId: number;
}

/**
 * Validate a decoded archive entry, turning zod's issue list into one actionable
 * sentence. A raw zod dump of a 50 000-row file is unreadable, so only the first
 * few paths are named and the rest counted.
 */
function parseEntry<T extends z.ZodTypeAny>(schema: T, value: unknown, entry: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues;
  const shown = issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  const more = issues.length > 3 ? ` (+${issues.length - 3} more)` : '';
  throw new HttpError(400, `${entry} in the archive is not valid: ${shown}${more}`);
}

/** Read and JSON-decode one required entry. */
async function readJsonEntry(zip: ZipReader, entry: string): Promise<unknown> {
  if (!zip.entries.has(entry)) {
    throw new HttpError(
      400,
      `The archive has no ${entry} entry — this is not a reporter engagement export`,
    );
  }
  const buf = await zip.read(entry);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, `${entry} in the archive is not valid JSON`);
  }
}

/**
 * Reject a file that defines the same uuid twice: every uuid in the file is a key
 * into an old→new map, so a duplicate makes the remap ambiguous rather than merely
 * redundant. The exporter cannot produce one (the columns are unique), so this only
 * ever fires on a hand-edited or crafted file.
 */
function assertUniqueUuids(uuids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const uuid of uuids) {
    if (seen.has(uuid)) {
      throw new HttpError(400, `The archive lists ${label} ${uuid} more than once`);
    }
    seen.add(uuid);
  }
}

/** Which record column a blob entry has to be restored into. */
type BlobSlot =
  | { kind: 'evidence-full'; index: number }
  | { kind: 'evidence-thumb'; index: number }
  | { kind: 'report-artifact'; index: number };

/** A restored blob: the key it was written under, plus what it hashed and measured. */
interface RestoredBlob {
  key: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Import a whole engagement from an export archive, creating a new engagement.
 *
 * Validation is complete before anything is written: the manifest, the records, the
 * presence of every referenced blob and the archive's declared size budget are all
 * checked against the central directory, so an unsupported version or a truncated
 * file costs nothing but the two small JSON entries.
 */
export async function importEngagement(
  app: FastifyInstance,
  args: EngagementImportArgs,
): Promise<EngagementImportResult> {
  const zip = await openZip(args.archive).catch((err: unknown) => {
    throw new HttpError(400, `The upload is not a readable ZIP archive (${describe(err)})`);
  });

  try {
    return await importFromArchive(app, args, zip);
  } finally {
    zip.close();
  }
}

/** The error text of an unknown throwable, for an actionable 400. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function importFromArchive(
  app: FastifyInstance,
  args: EngagementImportArgs,
  zip: ZipReader,
): Promise<EngagementImportResult> {
  // --- 1. The two JSON entries, read from the central directory without
  // inflating a single blob (the whole reason this format is a ZIP read with
  // yauzl rather than a stream). ------------------------------------------------
  const manifest = parseEntry(
    engagementExportManifestSchema,
    await readJsonEntry(zip, ENGAGEMENT_EXPORT_MANIFEST_ENTRY),
    ENGAGEMENT_EXPORT_MANIFEST_ENTRY,
  );
  // Same gate semantics as the findings import: a file from a newer server may
  // describe fields this one would silently drop, so refuse it by version rather
  // than guessing. An older version is readable — the schema's defaults fill in
  // what it predates.
  assertSupportedVersion(manifest.schemaVersion);

  const data: EngagementExport = parseEntry(
    engagementExportSchema,
    await readJsonEntry(zip, ENGAGEMENT_EXPORT_DATA_ENTRY),
    ENGAGEMENT_EXPORT_DATA_ENTRY,
  );
  // The manifest is metadata; `engagement.json` is the thing being imported, so its
  // own version is gated too rather than trusted to agree.
  assertSupportedVersion(data.schemaVersion);

  assertUniqueUuids(
    data.evidence.map((e) => e.uuid),
    'evidence',
  );
  assertUniqueUuids(
    data.findings.map((f) => f.uuid),
    'finding',
  );
  assertUniqueUuids(
    data.evidenceComments.map((c) => c.uuid),
    'evidence comment',
  );
  assertUniqueUuids(
    data.generatedReports.map((r) => r.uuid),
    'generated report',
  );

  // --- 2. Plan the blobs: which entry restores into which column, and whether the
  // archive can actually satisfy every reference. ------------------------------
  const slots: { slot: BlobSlot; hash: string }[] = [];
  data.evidence.forEach((ev, index) => {
    if (ev.fullBlobHash)
      slots.push({ slot: { kind: 'evidence-full', index }, hash: ev.fullBlobHash });
    if (ev.thumbBlobHash)
      slots.push({ slot: { kind: 'evidence-thumb', index }, hash: ev.thumbBlobHash });
  });
  data.generatedReports.forEach((r, index) => {
    if (r.artifactBlobHash)
      slots.push({ slot: { kind: 'report-artifact', index }, hash: r.artifactBlobHash });
  });

  const byHash = new Map<string, BlobSlot[]>();
  for (const { slot, hash } of slots) {
    const list = byHash.get(hash);
    if (list) list.push(slot);
    else byHash.set(hash, [slot]);
  }

  const entryName = (hash: string): string => `${ENGAGEMENT_EXPORT_BLOB_PREFIX}${hash}`;
  const missing = [...byHash.keys()].filter((h) => !zip.entries.has(entryName(h)));
  if (missing.length > 0) {
    // A record referencing bytes the archive doesn't carry means a truncated or
    // edited file; importing it would produce evidence that renders as broken
    // content with nothing recording why.
    const shown = missing.slice(0, 3).join(', ');
    throw new HttpError(
      400,
      `The archive is missing ${missing.length} referenced blob(s): ${shown}${
        missing.length > 3 ? ', …' : ''
      }`,
    );
  }

  // Size budget, from the declared sizes in the central directory — before
  // inflating anything. One blob is one evidence upload, so it gets the same
  // ceiling; the total is bounded by the archive's own limit times the inflation
  // ratio we are prepared to honor.
  const maxTotalInflated = engagementImportBodyLimit(app) * MAX_INFLATION_RATIO;
  let declaredBytes = 0;
  for (const hash of byHash.keys()) {
    const info = zip.entries.get(entryName(hash))!;
    if (info.uncompressedSize > app.config.MAX_UPLOAD_BYTES) {
      throw new HttpError(413, `Blob ${hash} in the archive exceeds the maximum upload size`);
    }
    declaredBytes += info.uncompressedSize;
  }
  if (declaredBytes > maxTotalInflated) {
    throw new HttpError(
      413,
      'The archive would restore more blob content than this server accepts',
    );
  }

  // --- 3. Mint the new identities. Pure computation, done before any write so the
  // engagement's two uuid cross-references can be remapped as the engagement row
  // itself is created. --------------------------------------------------------
  const newEvidenceUuids = data.evidence.map(() => randomUUID());
  const newFindingUuids = data.findings.map(() => randomUUID());
  const evidenceUuidMap = new Map(data.evidence.map((e, i) => [e.uuid, newEvidenceUuids[i]!]));
  const findingUuidMap = new Map(data.findings.map((f, i) => [f.uuid, newFindingUuids[i]!]));

  const dropped = {
    unmatchedAuthorEmails: [] as string[],
    unmatchedAuthorRefs: 0,
    unknownTagRefs: 0,
    danglingEvidenceRefs: 0,
    danglingFindingRefs: 0,
    duplicates: 0,
  };
  const remapped = { recommendationFindingRefs: 0, narrativeEvidenceRefs: 0 };

  const strategicRecommendations: RecommendationItem[] =
    data.engagement.strategicRecommendations.map((rec) => {
      const findingUuids: string[] = [];
      for (const old of rec.findingUuids) {
        const next = findingUuidMap.get(old);
        if (next === undefined) {
          dropped.danglingFindingRefs++;
          continue;
        }
        findingUuids.push(next);
        remapped.recommendationFindingRefs++;
      }
      return { ...rec, findingUuids };
    });

  const executionNarrative: ExecutionSubsection[] = data.engagement.executionNarrative.map(
    (section) => ({
      ...section,
      evidence: section.evidence.flatMap((ref) => {
        const next = evidenceUuidMap.get(ref.evidenceUuid);
        if (next === undefined) {
          dropped.danglingEvidenceRefs++;
          return [];
        }
        remapped.narrativeEvidenceRefs++;
        return [{ ...ref, evidenceUuid: next }];
      }),
      // `timeline.tags` references tags by name, and tag names are recreated
      // verbatim below, so a timeline subsection needs no remapping.
    }),
  );

  // --- 4. Resolve authors. One query for the whole server's accounts rather than a
  // case-insensitive lookup per email: a reporter deployment has tens to hundreds
  // of users, while a crafted file could name tens of thousands of distinct
  // addresses. Emails are unique but may be stored mixed-case, so match on the
  // lowercased form (as the membership route does with `mode: 'insensitive'`). --
  const localUsers = await app.db.user.findMany({
    where: { deletedAt: null },
    select: { id: true, email: true },
  });
  const userIdByEmail = new Map(localUsers.map((u) => [u.email.toLowerCase(), u.id]));
  const unmatchedEmails = new Set<string>();
  const authorId = (email: string | null): number | null => {
    if (!email) return null;
    const id = userIdByEmail.get(email.toLowerCase());
    if (id !== undefined) return id;
    // No match: leave the column null (it is nullable `SET NULL` for exactly this
    // reason) and never create the account.
    dropped.unmatchedAuthorRefs++;
    unmatchedEmails.add(email);
    return null;
  };

  // --- 5. Write the blobs. Each *reference* gets its own freshly allocated key,
  // even when two references share one archive entry.
  //
  // Content addressing deduplicates identical bytes inside the file (a screenshot
  // and its own thumbnail collapse to one entry), but the restored rows must NOT
  // share a key: `DELETE /web/engagements/:slug/evidence/:uuid` and the engagement
  // delete both reclaim `fullBlobKey`/`thumbBlobKey`/`blobKey` unconditionally, so a
  // shared key means deleting one row destroys another row's content. That is the
  // same footgun as reusing a key from the file — which cannot happen at all,
  // because no blob-store key ever leaves the exporting server. --------------
  const evidenceBlobs = data.evidence.map(() => ({
    full: null as RestoredBlob | null,
    thumb: null as RestoredBlob | null,
  }));
  const reportBlobs = data.generatedReports.map(() => null as RestoredBlob | null);
  const written: string[] = [];
  let blobBytes = 0;

  // Everything inside this try is *before* the commit, and only that: the
  // compensating delete below must never run over blobs a committed transaction's
  // rows already reference. See the note after the commit.
  let created: Awaited<ReturnType<typeof insertEngagement>>;
  try {
    for (const [hash, targets] of byHash) {
      const bytes = await zip.read(entryName(hash));
      // Verify what was actually inflated against the entry's name. The name *is*
      // the content address, so this is the archive's integrity check — it catches
      // a tampered or corrupted blob before a single row claims it, and it is why
      // the export carries no `sha256`/`sizeBytes` columns to be trusted instead.
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== hash) {
        throw new HttpError(
          400,
          `Blob ${hash} in the archive does not match its content hash (the file is corrupt or was modified)`,
        );
      }

      for (const slot of targets) {
        /*
         * Script bytes get the create path's two checks, because this is the one
         * route into the `script` content type that does not run through
         * `createEvidence`: rows go in with `createMany` and blobs are written right
         * here. The report reads a script body back with `buf.toString('utf8')` and
         * prints it verbatim, so an archive carrying non-UTF-8 or multi-megabyte
         * script content would put a screenful of U+FFFD — or a megabyte of <pre> —
         * into a client deliverable.
         *
         * Refusing the whole archive is the same call the content-hash check above
         * makes, and for the same reason: an export written by this server cannot
         * contain such a row (create refuses it), so one that does has been
         * hand-built or corrupted, and importing it would just defer the damage to
         * whoever generates the report.
         */
        if (slot.kind === 'evidence-full') {
          const ev = data.evidence[slot.index]!;
          if (ev.contentType === 'script') {
            try {
              decodeScriptUpload(bytes);
            } catch (err) {
              throw new HttpError(
                400,
                `Script evidence “${ev.title}” can't be imported. ${
                  err instanceof HttpError ? err.message : 'Its content is not usable as a script.'
                }`,
              );
            }
          }
        }
        const key =
          slot.kind === 'report-artifact'
            ? // Mirrors `recordGeneratedReport`'s `reports/` namespace, minus the
              // engagement id: blobs are written before the engagement row exists,
              // so there is no id to name them with. Keys are opaque — nothing
              // parses one — so the namespace is only an operator-facing hint.
              `reports/${randomUUID()}.${data.generatedReports[slot.index]!.format}`
            : // Same shape as `createEvidence`: an opaque uuid per blob.
              randomUUID();
        await app.blobs.put(key, bytes);
        written.push(key);
        blobBytes += bytes.length;
        const restored: RestoredBlob = { key, sha256: digest, sizeBytes: bytes.length };
        if (slot.kind === 'evidence-full') evidenceBlobs[slot.index]!.full = restored;
        else if (slot.kind === 'evidence-thumb') evidenceBlobs[slot.index]!.thumb = restored;
        else reportBlobs[slot.index] = restored;
      }
    }

    // --- 6. Every row, in one transaction. ------------------------------------
    created = await app.db.$transaction(
      async (tx) => {
        return insertEngagement(tx, {
          app,
          args,
          data,
          strategicRecommendations,
          executionNarrative,
          newEvidenceUuids,
          newFindingUuids,
          evidenceUuidMap,
          findingUuidMap,
          evidenceBlobs,
          reportBlobs,
          authorId,
          dropped,
        });
      },
      { maxWait: IMPORT_TRANSACTION_MAX_WAIT_MS, timeout: IMPORT_TRANSACTION_TIMEOUT_MS },
    );
  } catch (err) {
    // Compensating delete: the transaction rolled back, so nothing references
    // these bytes. Best-effort — a failed cleanup must not mask the real error.
    for (const key of written) await app.blobs.delete(key).catch(() => {});
    throw err;
  }

  // --- 7. Past the commit. The rows now reference every key in `written`, so the
  // compensating delete above is deliberately out of scope from here on: running it
  // after a successful commit would leave a live engagement whose evidence points at
  // bytes that no longer exist — the one failure mode worse than a failed import,
  // because the caller is told nothing was created. Anything that throws below
  // therefore surfaces as an error over an engagement that really does exist, which
  // is why the response is assembled from values that cannot fail validation (the
  // slug is uniquified within `slugSchema`'s length, see `uniqueSlug`).
  dropped.unmatchedAuthorEmails = [...unmatchedEmails].slice(0, MAX_REPORTED_UNMATCHED_EMAILS);
  const result = engagementImportResultSchema.parse({
    engagement: { slug: created.slug, name: created.name },
    source: {
      slug: data.engagement.slug,
      name: data.engagement.name,
      exportedAt: data.exportedAt,
    },
    created: { ...created.counts, blobs: written.length, blobBytes },
    remapped,
    dropped,
  });
  app.log.info(
    { slug: result.engagement.slug, source: result.source.slug, counts: result.created },
    'engagement import',
  );
  return result;
}

/** Gate the import on the format version, matching the findings import's wording. */
function assertSupportedVersion(version: number): void {
  if (version > ENGAGEMENT_EXPORT_VERSION) {
    throw new HttpError(
      400,
      `Unsupported export schema version ${version} (this server reads up to ${ENGAGEMENT_EXPORT_VERSION})`,
    );
  }
}

interface InsertArgs {
  app: FastifyInstance;
  args: EngagementImportArgs;
  data: EngagementExport;
  strategicRecommendations: RecommendationItem[];
  executionNarrative: ExecutionSubsection[];
  newEvidenceUuids: string[];
  newFindingUuids: string[];
  evidenceUuidMap: Map<string, string>;
  findingUuidMap: Map<string, string>;
  evidenceBlobs: { full: RestoredBlob | null; thumb: RestoredBlob | null }[];
  reportBlobs: (RestoredBlob | null)[];
  authorId: (email: string | null) => number | null;
  dropped: {
    unknownTagRefs: number;
    danglingEvidenceRefs: number;
    danglingFindingRefs: number;
    duplicates: number;
  };
}

/** JSON column assignment: the lists are already zod-validated, just not typed as Prisma JSON. */
const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * Create every row for the new engagement.
 *
 * Insert order is dictated by the foreign keys in `schema.prisma`, worked out from
 * the referencing side in each case:
 *
 *   1. Engagement           — everything below has `engagementId`.
 *   2. UserEngagementRole   — the importing user as `admin` (membership is never
 *                             exported; see the module header).
 *   3. Tag                  — before TargetActivity (`tagId`), EvidenceTag and
 *                             FindingTag.
 *   4. FindingCategory      — before Finding (`categoryId`).
 *   5. Finding              — before FindingTag, EvidenceFinding and GoalFinding.
 *   5a. FindingTag          — needs Tag (3) and Finding (5), both of which exist by
 *                             then, so it needs no later pass.
 *   6. Evidence             — before EvidenceTag / EvidenceComment /
 *                             EvidenceFinding / GoalEvidence, and before its own
 *                             `parentEvidenceId` back-fill.
 *   7. Evidence parents     — a second pass over the rows from (6): the relation is
 *                             self-referential, so a parent's id does not exist
 *                             until its row does. Two passes handle any depth; the
 *                             service layer caps live nesting at one level, but the
 *                             column itself has no such constraint and a backup
 *                             must restore whatever the source held.
 *   8. EvidenceTag, EvidenceComment, EvidenceFinding.
 *   9. EngagementTarget → TargetActivity → ActivityGoal (each level parents the
 *      next; the tree is created row by row because the children's ids are needed
 *      and the tree is small — tens to hundreds of rows — unlike evidence and
 *      findings, which use `createMany` plus one read-back).
 *  10. GoalEvidence / GoalFinding — need goals (9) *and* evidence (6) / findings (5).
 *  11. SavedQuery, GeneratedReport — leaves, engagement-scoped only.
 *
 * Every `@@unique` an import could violate is satisfied by construction:
 * `Engagement.slug` (uniquified below, with the index as backstop),
 * `Tag[engagementId, name]`, `FindingCategory[engagementId, category]` and
 * `SavedQuery[engagementId, name, type]` are deduped by key within the file, and
 * the composite primary keys of the five link tables
 * (`GoalEvidence[goalId, evidenceId]`, `GoalFinding[goalId, findingId]`,
 * `EvidenceTag[evidenceId, tagId]`, `FindingTag[findingId, tagId]`,
 * `EvidenceFinding[evidenceId, findingId]`) are deduped per owner. The remaining unique columns are the uuids, all freshly minted.
 * Nothing else in the file maps to a unique index: `position` columns on
 * EngagementTarget / TargetActivity / ActivityGoal / Finding / EvidenceFinding are
 * plain integers, and are restored verbatim rather than renumbered so the new
 * engagement presents rows in the order the source operator arranged them.
 */
async function insertEngagement(
  tx: Prisma.TransactionClient,
  ins: InsertArgs,
): Promise<{
  slug: string;
  name: string;
  counts: Omit<EngagementImportCreated, 'blobs' | 'blobBytes'>;
}> {
  const { app, args, data, dropped } = ins;
  const src = data.engagement;

  // 1. The engagement. The slug comes from the caller or is derived from the
  // file's own slug and uniquified — the file's slug is provenance, never an
  // address, so a same-server import lands beside the original as `op1-2`.
  const name = args.name?.trim() || src.name;
  let slug: string;
  if (args.slug) {
    const taken = await tx.engagement.findUnique({
      where: { slug: args.slug },
      select: { id: true },
    });
    if (taken) throw new HttpError(409, 'An engagement with that slug already exists');
    slug = args.slug;
  } else {
    slug = await uniqueSlug(src.slug, async (candidate) => {
      const existing = await tx.engagement.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      return existing !== null;
    });
  }

  const engagement = await tx.engagement.create({
    data: {
      slug,
      name,
      status: src.status,
      createdAt: new Date(src.createdAt),
      startedAt: new Date(src.startedAt),
      projectedEndAt: src.projectedEndAt === null ? null : new Date(src.projectedEndAt),
      actualEndAt: src.actualEndAt === null ? null : new Date(src.actualEndAt),
      clientName: src.clientName,
      assessmentType: src.assessmentType,
      testApproach: src.testApproach,
      location: src.location,
      scope: src.scope,
      executiveSummary: src.executiveSummary,
      methodology: src.methodology,
      objectivesNarrative: src.objectivesNarrative,
      threatModelNarrative: src.threatModelNarrative,
      watermarkEnabled: src.watermarkEnabled,
      watermarkText: src.watermarkText,
      watermarkColor: src.watermarkColor,
      watermarkOpacity: src.watermarkOpacity,
      watermarkLayer: src.watermarkLayer,
      scopeTargets: asJson(src.scopeTargets),
      scopeExclusions: asJson(src.scopeExclusions),
      // The two remapped columns (see the module header).
      strategicRecommendations: asJson(ins.strategicRecommendations),
      executionNarrative: asJson(ins.executionNarrative),
      threatModelDiagrams: asJson(src.threatModelDiagrams),
      providerContacts: asJson(src.providerContacts),
      clientContacts: asJson(src.clientContacts),
      softwareTested: asJson(src.softwareTested),
      thirdPartySoftware: asJson(src.thirdPartySoftware),
      reportConfig: asJson(src.reportConfig),
      // Verbatim and uninterpreted, or left null when the file carries none.
      ...(src.proposalImport == null ? {} : { proposalImport: asJson(src.proposalImport) }),
      // 2. The importing user owns the result. No other membership is created: the
      // file carries none, by design.
      roles: { create: { userId: args.userId, role: 'admin' } },
      // Note the contrast with `POST /web/engagements`, which seeds `DefaultTag`s
      // into a new engagement. An import must not: the engagement's tags are the
      // ones in the file, and seeding would both invent tags the source never had
      // and risk colliding with them on name.
    },
    select: { id: true, slug: true, name: true },
  });
  const engagementId = engagement.id;

  // 3. Tags, deduped by name (unique per engagement).
  const tagByName = new Map<string, string>();
  for (const tag of data.tags) {
    if (tagByName.has(tag.name)) {
      dropped.duplicates++;
      continue;
    }
    tagByName.set(tag.name, tag.colorName);
  }
  if (tagByName.size > 0) {
    await tx.tag.createMany({
      // `tagByName` is a Map, so its iteration order is the file's array order —
      // which the exporter writes in curated `position` order. The index restores
      // it without the file needing a `position` field. An older export
      // (alphabetical array) imports to alphabetical positions, which reads
      // identically to how it rendered on the source server.
      data: [...tagByName].map(([tagName, colorName], position) => ({
        engagementId,
        name: tagName,
        colorName,
        position,
      })),
    });
  }
  const tagRows = await tx.tag.findMany({
    where: { engagementId },
    select: { id: true, name: true },
  });
  const tagIdByName = new Map(tagRows.map((t) => [t.name, t.id]));

  // 4. Finding categories, deduped by name, soft-delete marker preserved: a
  // category the source had hidden must stay hidden rather than reappear in the
  // category picker.
  const categories = new Map<string, Date | null>();
  for (const cat of data.findingCategories) {
    if (categories.has(cat.category)) {
      dropped.duplicates++;
      continue;
    }
    categories.set(cat.category, cat.deletedAt === null ? null : new Date(cat.deletedAt));
  }
  // A finding may name a category the file's own list omits (an older file, or a
  // hand-edited one); create it rather than dropping the finding's category.
  for (const finding of data.findings) {
    if (finding.category && !categories.has(finding.category))
      categories.set(finding.category, null);
  }
  if (categories.size > 0) {
    await tx.findingCategory.createMany({
      data: [...categories].map(([category, deletedAt]) => ({ engagementId, category, deletedAt })),
    });
  }
  const categoryRows = await tx.findingCategory.findMany({
    where: { engagementId },
    select: { id: true, category: true },
  });
  const categoryIdByName = new Map(categoryRows.map((c) => [c.category, c.id]));

  // 5. Findings. `createMany` + one read-back by uuid, rather than a create per
  // row: a real engagement can carry thousands.
  if (data.findings.length > 0) {
    await tx.finding.createMany({
      data: data.findings.map((f, i) => {
        // Mirror the live routes and the findings import: a strength carries no
        // risk rating, effort, impact or remediation, so a crafted file cannot
        // smuggle an inconsistent strength into the weaknesses dashboard.
        const strength = f.kind === 'strength';
        return {
          uuid: ins.newFindingUuids[i]!,
          engagementId,
          categoryId: f.category ? (categoryIdByName.get(f.category) ?? null) : null,
          title: f.title,
          description: f.description,
          kind: f.kind,
          affectedTarget: f.affectedTarget,
          impact: strength ? '' : f.impact,
          fixEffort: strength ? ('none' as const) : f.fixEffort,
          remediation: strength ? '' : f.remediation,
          iso21434Refs: asJson(f.iso21434Refs),
          unr155Refs: asJson(f.unr155Refs),
          severity: strength ? null : f.severity,
          cvssVector: strength ? null : f.cvssVector,
          cvssScore: strength ? null : f.cvssScore,
          position: f.position,
          readyToReport: f.readyToReport,
          createdAt: new Date(f.createdAt),
          updatedAt: new Date(f.updatedAt),
        };
      }),
    });
  }
  const findingRows = await tx.finding.findMany({
    where: { engagementId },
    select: { id: true, uuid: true },
  });
  const findingIdByUuid = new Map(findingRows.map((f) => [f.uuid, f.id]));
  /** Resolve a *file* finding uuid to the id of the row just created for it. */
  const findingId = (oldUuid: string): number | undefined => {
    const next = ins.findingUuidMap.get(oldUuid);
    return next === undefined ? undefined : findingIdByUuid.get(next);
  };

  // 5a. Finding tags, deduped per finding. Tags (3) and findings (5) both exist
  // by now, so unlike the evidence tags at 8a this needs no later pass. A name
  // the file's own tag list never defines is dropped and counted, never a
  // failure — same counter the evidence and activity references use.
  const findingTagRows: { findingId: number; tagId: number }[] = [];
  for (let i = 0; i < data.findings.length; i++) {
    const f = data.findings[i]!;
    const ownerId = findingIdByUuid.get(ins.newFindingUuids[i]!);
    if (ownerId === undefined) continue;
    const seen = new Set<number>();
    for (const tagName of f.tagNames) {
      const tagId = tagIdByName.get(tagName);
      if (tagId === undefined) {
        dropped.unknownTagRefs++;
        continue;
      }
      if (seen.has(tagId)) {
        dropped.duplicates++;
        continue;
      }
      seen.add(tagId);
      findingTagRows.push({ findingId: ownerId, tagId });
    }
  }
  if (findingTagRows.length > 0) await tx.findingTag.createMany({ data: findingTagRows });

  // 6. Evidence, without parent links (see 7). Hash and size come from the bytes
  // this import actually inflated and stored, not from the file.
  if (data.evidence.length > 0) {
    await tx.evidence.createMany({
      data: data.evidence.map((ev, i) => {
        const blobs = ins.evidenceBlobs[i]!;
        return {
          uuid: ins.newEvidenceUuids[i]!,
          engagementId,
          operatorId: ins.authorId(ev.operatorEmail),
          lastEditedById: ins.authorId(ev.lastEditedByEmail),
          title: ev.title,
          description: ev.description,
          contentType: ev.contentType,
          contentSubtype: ev.contentSubtype,
          originalFilename: ev.originalFilename,
          fullBlobKey: blobs.full?.key ?? null,
          thumbBlobKey: blobs.thumb?.key ?? null,
          sha256: blobs.full?.sha256 ?? null,
          sizeBytes: blobs.full?.sizeBytes ?? null,
          occurredAt: new Date(ev.occurredAt),
          createdAt: new Date(ev.createdAt),
          updatedAt: new Date(ev.updatedAt),
          // A backup restores the exclusion along with the evidence; re-admitting
          // withheld content to every report output would be the one silent change
          // an operator could not see.
          excludeFromReport: ev.excludeFromReport,
        };
      }),
    });
  }
  const evidenceRows = await tx.evidence.findMany({
    where: { engagementId },
    select: { id: true, uuid: true },
  });
  const evidenceIdByUuid = new Map(evidenceRows.map((e) => [e.uuid, e.id]));
  /** Resolve a *file* evidence uuid to the id of the row just created for it. */
  const evidenceId = (oldUuid: string): number | undefined => {
    const next = ins.evidenceUuidMap.get(oldUuid);
    return next === undefined ? undefined : evidenceIdByUuid.get(next);
  };

  // 7. Parent links, now that every row has an id. Only linked-evidence children
  // need an update, and each carries its own `updatedAt`, which has to be restated
  // here or Prisma's `@updatedAt` would stamp the import's clock onto it.
  for (let i = 0; i < data.evidence.length; i++) {
    const ev = data.evidence[i]!;
    if (!ev.parentEvidenceUuid) continue;
    const parentId = evidenceId(ev.parentEvidenceUuid);
    if (parentId === undefined) {
      dropped.danglingEvidenceRefs++;
      continue;
    }
    const childId = evidenceIdByUuid.get(ins.newEvidenceUuids[i]!);
    if (childId === undefined) continue;
    await tx.evidence.update({
      where: { id: childId },
      data: { parentEvidenceId: parentId, updatedAt: new Date(ev.updatedAt) },
    });
  }

  // 8a. Evidence tags, deduped per evidence item.
  const evidenceTagRows: { evidenceId: number; tagId: number }[] = [];
  for (let i = 0; i < data.evidence.length; i++) {
    const ev = data.evidence[i]!;
    const ownerId = evidenceIdByUuid.get(ins.newEvidenceUuids[i]!);
    if (ownerId === undefined) continue;
    const seen = new Set<number>();
    for (const tagName of ev.tagNames) {
      const tagId = tagIdByName.get(tagName);
      if (tagId === undefined) {
        dropped.unknownTagRefs++;
        continue;
      }
      if (seen.has(tagId)) {
        dropped.duplicates++;
        continue;
      }
      seen.add(tagId);
      evidenceTagRows.push({ evidenceId: ownerId, tagId });
    }
  }
  if (evidenceTagRows.length > 0) await tx.evidenceTag.createMany({ data: evidenceTagRows });

  // 8b. Discussion comments. A comment whose evidence the file never defines has
  // nowhere to hang, so it is dropped and counted.
  const commentRows: Prisma.EvidenceCommentCreateManyInput[] = [];
  for (const comment of data.evidenceComments) {
    const ownerId = evidenceId(comment.evidenceUuid);
    if (ownerId === undefined) {
      dropped.danglingEvidenceRefs++;
      continue;
    }
    commentRows.push({
      // Fresh uuid: `EvidenceComment.uuid` is globally unique too.
      uuid: randomUUID(),
      evidenceId: ownerId,
      authorId: ins.authorId(comment.authorEmail),
      body: comment.body,
      createdAt: new Date(comment.createdAt),
      updatedAt: new Date(comment.updatedAt),
    });
  }
  if (commentRows.length > 0) await tx.evidenceComment.createMany({ data: commentRows });

  // 8c. Evidence↔finding links. Positions are restored as the file records them
  // (per bucket, as the source arranged them) rather than renumbered: unlike the
  // findings import, which merges into an existing finding's links, this engagement
  // starts empty, so the file's ordering is the whole truth.
  const linkRows: Prisma.EvidenceFindingCreateManyInput[] = [];
  for (let i = 0; i < data.findings.length; i++) {
    const finding = data.findings[i]!;
    const ownerId = findingIdByUuid.get(ins.newFindingUuids[i]!);
    if (ownerId === undefined) continue;
    const seen = new Set<number>();
    for (const link of finding.evidenceLinks) {
      const linkedId = evidenceId(link.evidenceUuid);
      if (linkedId === undefined) {
        dropped.danglingEvidenceRefs++;
        continue;
      }
      if (seen.has(linkedId)) {
        dropped.duplicates++;
        continue;
      }
      seen.add(linkedId);
      linkRows.push({
        evidenceId: linkedId,
        findingId: ownerId,
        position: link.position,
        caption: link.caption,
        inPath: link.inPath,
      });
    }
  }
  if (linkRows.length > 0) await tx.evidenceFinding.createMany({ data: linkRows });

  // 9. The goal tree, level by level: each child needs its parent's id, and the
  // models have no uuid, so the file's local keys (`t0.a1.g2`) are only used for
  // nesting — nothing on the destination refers to them afterwards.
  let activitiesCreated = 0;
  let goalsCreated = 0;
  const goalEvidenceRows: { goalId: number; evidenceId: number }[] = [];
  const goalFindingRows: { goalId: number; findingId: number }[] = [];
  for (const target of data.targets) {
    const targetRow = await tx.engagementTarget.create({
      data: {
        engagementId,
        name: target.name,
        description: target.description,
        position: target.position,
      },
      select: { id: true },
    });
    for (const activity of target.activities) {
      let tagId: number | null = null;
      if (activity.tagName !== null) {
        tagId = tagIdByName.get(activity.tagName) ?? null;
        if (tagId === null) dropped.unknownTagRefs++;
      }
      const activityRow = await tx.targetActivity.create({
        data: {
          targetId: targetRow.id,
          name: activity.name,
          category: activity.category,
          tagId,
          position: activity.position,
        },
        select: { id: true },
      });
      activitiesCreated++;
      for (const goal of activity.goals) {
        const goalRow = await tx.activityGoal.create({
          data: {
            activityId: activityRow.id,
            title: goal.title,
            status: goal.status,
            isRetest: goal.isRetest,
            notes: goal.notes,
            position: goal.position,
          },
          select: { id: true },
        });
        goalsCreated++;

        // 10. Goal links, collected here and inserted once below.
        const seenEvidence = new Set<number>();
        for (const uuid of goal.evidenceUuids) {
          const linkedId = evidenceId(uuid);
          if (linkedId === undefined) {
            dropped.danglingEvidenceRefs++;
            continue;
          }
          if (seenEvidence.has(linkedId)) {
            dropped.duplicates++;
            continue;
          }
          seenEvidence.add(linkedId);
          goalEvidenceRows.push({ goalId: goalRow.id, evidenceId: linkedId });
        }
        const seenFindings = new Set<number>();
        for (const uuid of goal.findingUuids) {
          const linkedId = findingId(uuid);
          if (linkedId === undefined) {
            dropped.danglingFindingRefs++;
            continue;
          }
          if (seenFindings.has(linkedId)) {
            dropped.duplicates++;
            continue;
          }
          seenFindings.add(linkedId);
          goalFindingRows.push({ goalId: goalRow.id, findingId: linkedId });
        }
      }
    }
  }
  if (goalEvidenceRows.length > 0) await tx.goalEvidence.createMany({ data: goalEvidenceRows });
  if (goalFindingRows.length > 0) await tx.goalFinding.createMany({ data: goalFindingRows });

  // 11a. Saved queries, deduped on (name, type) — unique per engagement.
  const queryKeys = new Set<string>();
  const queryRows: Prisma.SavedQueryCreateManyInput[] = [];
  for (const query of data.savedQueries) {
    const key = `${query.type}:${query.name}`;
    if (queryKeys.has(key)) {
      dropped.duplicates++;
      continue;
    }
    queryKeys.add(key);
    queryRows.push({ engagementId, name: query.name, query: query.query, type: query.type });
  }
  if (queryRows.length > 0) await tx.savedQuery.createMany({ data: queryRows });

  // 11b. Report history, with the restored artifact bytes attached. `version` is
  // carried verbatim rather than reassigned: the label is what an attestation
  // letter named, and `recordGeneratedReport` counts existing rows, so the next
  // report generated on the new engagement simply continues after this history.
  const reportRows: Prisma.GeneratedReportCreateManyInput[] = data.generatedReports.map((r, i) => {
    const blob = ins.reportBlobs[i];
    return {
      uuid: randomUUID(),
      engagementId,
      preset: r.preset,
      label: r.label,
      version: r.version,
      format: r.format,
      summary: asJson(r.summary),
      blobKey: blob?.key ?? null,
      filename: r.filename,
      sizeBytes: blob?.sizeBytes ?? null,
      contentType: r.contentType,
      sha256: blob?.sha256 ?? null,
      generatedById: ins.authorId(r.generatedByEmail),
      createdAt: new Date(r.createdAt),
    };
  });
  if (reportRows.length > 0) await tx.generatedReport.createMany({ data: reportRows });

  app.log.debug({ engagementId, slug }, 'engagement import: rows created');

  return {
    slug: engagement.slug,
    name: engagement.name,
    counts: {
      targets: data.targets.length,
      activities: activitiesCreated,
      goals: goalsCreated,
      tags: tagByName.size,
      evidence: data.evidence.length,
      evidenceComments: commentRows.length,
      findingCategories: categories.size,
      findings: data.findings.length,
      evidenceLinks: linkRows.length,
      goalEvidenceLinks: goalEvidenceRows.length,
      goalFindingLinks: goalFindingRows.length,
      savedQueries: queryRows.length,
      generatedReports: reportRows.length,
    },
  };
}
