import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import {
  EVIDENCE_TYPE_LABELS,
  MAX_SCRIPT_BYTES,
  SCRIPT_EMPTY_REASON,
  SCRIPT_NOT_TEXT_REASON,
  SCRIPT_TOO_LARGE_REASON,
  type CreateEvidenceInput,
  type Evidence,
  type ParsedQuery,
} from '@reporter/shared';
import { buildEvidenceWhere } from '../helpers/timeline-filter.js';
import type { Pagination } from '../helpers/pagination.js';
import { evidenceInclude, serializeEvidence } from './serializers.js';
import { HttpError } from '../auth/guards.js';
import { q, recordAudit, withIntent, type AuditCtx } from './audit.js';

export interface CreateEvidenceArgs {
  engagementId: number;
  engagementSlug: string;
  operatorId: number;
  metadata: CreateEvidenceInput;
  file?: { data: Buffer; mimeType: string; filename: string };
  /** Preserve a specific uuid (used when importing evidence); defaults to a new one. */
  uuid?: string;
  /**
   * The request's audit context. When present, the creation is recorded HERE as
   * one intent entry — the web route and the HMAC route both pass theirs, so the
   * two planes cannot drift in what a capture looks like in the log (only `via`
   * differs). The importers deliberately pass none: they run under
   * `withImporter`, which silences the backstop and writes one summary entry
   * for the whole archive instead of a row per restored item.
   */
  audit?: AuditCtx;
}

const THUMB_MAX = 500;

/**
 * Decode an uploaded script to text, or refuse the upload.
 *
 * `Buffer.toString('utf8')` is not a validator: it substitutes U+FFFD for every
 * malformed byte and returns happily, so a binary dropped on the script field
 * would be "stored" as a screenful of replacement characters that nobody can read
 * and no interpreter can run. `TextDecoder` with `fatal: true` throws instead,
 * which is the only cheap way here to tell text from bytes.
 *
 * The NUL check is the other half of that test: U+0000 is perfectly legal UTF-8,
 * so a UTF-16 source file or a zero-padded binary can decode without error while
 * being nothing like a script. Rejecting embedded NULs is the same heuristic git
 * uses to call a file binary.
 *
 * A leading BOM is stripped rather than refused: it is a byte-order artifact, not
 * content, and keeping it would both break the `#!` shebang for whoever runs the
 * ZIP entry and make an uploaded script differ from the byte-identical typed one.
 *
 * Exported because `createEvidence` is not the only way script bytes can reach the
 * column: an engagement import writes evidence rows directly, and has to apply the
 * same two checks or an archive could seed a script the report would later render
 * as replacement characters into a client PDF.
 */
export function decodeScriptUpload(data: Buffer): string {
  if (data.length > MAX_SCRIPT_BYTES) throw new HttpError(413, SCRIPT_TOO_LARGE_REASON);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new HttpError(400, SCRIPT_NOT_TEXT_REASON);
  }
  if (text.includes('\u0000')) throw new HttpError(400, SCRIPT_NOT_TEXT_REASON);
  return text.startsWith('\ufeff') ? text.slice(1) : text;
}

/** Shared evidence-creation pipeline used by both the web and client APIs. */
export async function createEvidence(
  app: FastifyInstance,
  args: CreateEvidenceArgs,
): Promise<Evidence> {
  const { metadata, file } = args;

  // Comment linking: when parentEvidenceUuid is set this evidence is a comment on
  // another piece of evidence. Resolve + validate it up front (before writing any
  // blobs) so an invalid parent can't leave an orphaned blob behind. The parent
  // must live in the same engagement and must itself be top-level — comments are
  // one level deep.
  let parentEvidenceId: number | null = null;
  let parentTitle: string | null = null;
  if (metadata.parentEvidenceUuid) {
    const parent = await app.db.evidence.findFirst({
      where: { uuid: metadata.parentEvidenceUuid, engagementId: args.engagementId },
      // The title rides along for the audit entry ("as a comment on …") so the
      // record costs no second lookup.
      select: { id: true, parentEvidenceId: true, title: true },
    });
    if (!parent) throw new HttpError(404, 'Parent evidence not found in this engagement');
    if (parent.parentEvidenceId !== null) {
      throw new HttpError(400, 'Cannot comment on a comment (linked evidence is one level deep)');
    }
    parentEvidenceId = parent.id;
    parentTitle = parent.title;
  }

  // Inline text as submitted: present but empty is the same as absent (it clears
  // nothing on create, there is nothing to clear).
  const inlineText =
    metadata.content !== undefined && metadata.content !== '' ? metadata.content : undefined;

  // A script is text however it arrived. An upload is decoded here and stored down
  // the same path as typed content, so the two inputs produce one storage shape and
  // the script stays editable afterwards (`EVIDENCE_TEXT_EDITABLE.script`).
  let scriptText: string | undefined;
  if (metadata.contentType === 'script') {
    // Precedence: for every other content type a file silently wins over `content`,
    // and has since the first release — the two are different kinds of thing there
    // (bytes vs. a note), so the file is obviously the body. For a script both
    // fields are plain text and either is a plausible one for a client to fill, so a
    // request carrying both is a client bug rather than a preference to guess at.
    // Refusing beats dropping one of two bodies the operator believes they filed.
    if (file && inlineText !== undefined) {
      throw new HttpError(400, 'Send a script as an uploaded file or as inline content, not both.');
    }
    if (file) {
      scriptText = decodeScriptUpload(file.data);
      // An empty pick is a mistake, not a script with no body: the typed path stores
      // no blob for empty content, whereas this one would store a zero-length one and
      // put a blank entry (plus the SHA-256 of nothing) in the report's Files Attached
      // table. See SCRIPT_EMPTY_REASON.
      if (scriptText.trim() === '') throw new HttpError(400, SCRIPT_EMPTY_REASON);
    } else if (
      inlineText !== undefined &&
      Buffer.byteLength(inlineText, 'utf8') > MAX_SCRIPT_BYTES
    ) {
      // The typed path shares the uploaded path's cap, so the two ways into the same
      // column cannot disagree about how large a script may be.
      throw new HttpError(413, SCRIPT_TOO_LARGE_REASON);
    }
  }

  // Once decoded, a script upload is no longer a file as far as storage is
  // concerned: only genuinely opaque bytes take the file branch below.
  const binaryFile = scriptText === undefined ? file : undefined;
  const textBody = scriptText ?? (binaryFile ? undefined : inlineText);

  let fullBlobKey: string | null = null;
  let thumbBlobKey: string | null = null;
  // Hash + size of whatever blob we store (file or inline content), computed once
  // here so the report never has to re-read the blob just to hash it.
  let sha256: string | null = null;
  let sizeBytes: number | null = null;

  if (binaryFile) {
    fullBlobKey = randomUUID();
    await app.blobs.put(fullBlobKey, binaryFile.data);
    sha256 = createHash('sha256').update(binaryFile.data).digest('hex');
    sizeBytes = binaryFile.data.length;
    if (metadata.contentType === 'image') {
      try {
        // Cap decoded pixels (~40 MP, far above any legitimate screenshot) so a
        // decompression-bomb image can't exhaust memory during thumbnailing.
        const thumb = await sharp(binaryFile.data, { limitInputPixels: 40_000_000 })
          .resize(THUMB_MAX, THUMB_MAX, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        thumbBlobKey = randomUUID();
        await app.blobs.put(thumbBlobKey, thumb);
      } catch (err) {
        app.log.warn({ err }, 'thumbnail generation failed; storing without thumbnail');
      }
    }
  } else if (textBody !== undefined) {
    // Text content (note/event/codeblock/HTTP, typed or uploaded script) is stored
    // as a blob too, so all evidence content is retrievable through one content
    // endpoint.
    const buf = Buffer.from(textBody, 'utf8');
    fullBlobKey = randomUUID();
    await app.blobs.put(fullBlobKey, buf);
    sha256 = createHash('sha256').update(buf).digest('hex');
    sizeBytes = buf.length;
  }

  // Only attach tags that actually belong to this engagement.
  const validTags =
    metadata.tagIds.length > 0
      ? await app.db.tag.findMany({
          where: { id: { in: metadata.tagIds }, engagementId: args.engagementId },
          // Names are for the audit entry; ids for the link rows.
          select: { id: true, name: true },
        })
      : [];

  const occurredAt = metadata.occurredAt ? new Date(metadata.occurredAt) : new Date();

  // Preserve the original filename (explicit client value wins, else the uploaded
  // file's own name). Used to name files in the report's supporting-files ZIP and
  // the "Files Attached" table. Truncated to the column bound. Read from `file`,
  // not `binaryFile`, so an uploaded script keeps the real name it arrived under
  // even though its bytes went down the text path.
  const rawName = metadata.originalFilename ?? file?.filename ?? null;
  const originalFilename = rawName ? rawName.slice(0, 255) : null;

  const data = {
    uuid: args.uuid,
    engagementId: args.engagementId,
    operatorId: args.operatorId,
    title: metadata.title ?? '',
    description: metadata.description ?? '',
    contentType: metadata.contentType,
    contentSubtype: metadata.contentSubtype ?? null,
    originalFilename,
    fullBlobKey,
    thumbBlobKey,
    sha256,
    sizeBytes,
    parentEvidenceId,
    occurredAt,
    // Normally false — capture clients never exclude. It is carried here so that
    // findings-import can restore the flag from an export, making an
    // export → import round trip preserve the exclusion along with the evidence.
    excludeFromReport: metadata.excludeFromReport,
    tags: { create: validTags.map((t) => ({ tagId: t.id })) },
  };
  const include = evidenceInclude(args.operatorId);

  // Without an audit context the backstop records the row (or an importer
  // counts it). With one, the create runs under `withIntent` so the backstop
  // stays silent for the evidence row — the nested tag links are part of the
  // same statement and never reach it as writes of their own — and the entry
  // below says what a capture is: its type, where it hangs, its tags and its
  // size, in the glossary's words rather than as a column dump.
  if (!args.audit) {
    const created = await app.db.evidence.create({ data, include });
    return serializeEvidence(created, args.engagementSlug);
  }
  const audit = args.audit;
  const created = await withIntent(['evidence'], async () => {
    const row = await app.db.evidence.create({ data, include });
    const type = EVIDENCE_TYPE_LABELS[metadata.contentType];
    const label = row.title || `${type} ${row.uuid.slice(0, 8)}`;
    await recordAudit(audit, {
      action: 'create',
      entityType: 'evidence',
      entity: { id: row.uuid, label },
      summary:
        `Created evidence ${q(label)} (${type})` +
        (parentTitle !== null ? ` as a comment on ${q(parentTitle)}` : ''),
      changes: [
        { kind: 'field', field: 'contentType', from: null, to: metadata.contentType },
        ...(validTags.length > 0
          ? [{ kind: 'items' as const, label: 'Tags', items: validTags.map((t) => t.name) }]
          : []),
        ...(metadata.excludeFromReport
          ? [{ kind: 'field' as const, field: 'excludeFromReport', from: null, to: true }]
          : []),
        ...(sizeBytes !== null
          ? [{ kind: 'count' as const, label: 'Bytes', count: sizeBytes }]
          : []),
      ],
    });
    return row;
  });

  return serializeEvidence(created, args.engagementSlug);
}

export interface EvidenceListResult {
  items: Evidence[];
  total: number;
  page: number;
  pageSize: number;
}

/** List evidence for an engagement, filtered by a parsed timeline query.
 *  `userId` scopes the per-user bits: the `starred` flag and the starred filter. */
export async function listEvidence(
  app: FastifyInstance,
  engagementId: number,
  engagementSlug: string,
  query: ParsedQuery,
  pagination: Pagination,
  userId: number,
): Promise<EvidenceListResult> {
  const where = buildEvidenceWhere(query, engagementId, userId);
  const [rows, total] = await app.db.$transaction([
    app.db.evidence.findMany({
      where,
      include: evidenceInclude(userId),
      orderBy: { occurredAt: query.sortAsc ? 'asc' : 'desc' },
      skip: pagination.skip,
      take: pagination.take,
    }),
    app.db.evidence.count({ where }),
  ]);

  return {
    items: rows.map((r) => serializeEvidence(r, engagementSlug)),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
  };
}
