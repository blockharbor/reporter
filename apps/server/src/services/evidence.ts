import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import type { CreateEvidenceInput, Evidence, ParsedQuery } from '@reporter/shared';
import { buildEvidenceWhere } from '../helpers/timeline-filter.js';
import type { Pagination } from '../helpers/pagination.js';
import { evidenceInclude, serializeEvidence } from './serializers.js';
import { HttpError } from '../auth/guards.js';

export interface CreateEvidenceArgs {
  engagementId: number;
  engagementSlug: string;
  operatorId: number;
  metadata: CreateEvidenceInput;
  file?: { data: Buffer; mimeType: string; filename: string };
  /** Preserve a specific uuid (used when importing evidence); defaults to a new one. */
  uuid?: string;
}

const THUMB_MAX = 500;

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
  if (metadata.parentEvidenceUuid) {
    const parent = await app.db.evidence.findFirst({
      where: { uuid: metadata.parentEvidenceUuid, engagementId: args.engagementId },
      select: { id: true, parentEvidenceId: true },
    });
    if (!parent) throw new HttpError(404, 'Parent evidence not found in this engagement');
    if (parent.parentEvidenceId !== null) {
      throw new HttpError(400, 'Cannot comment on a comment (linked evidence is one level deep)');
    }
    parentEvidenceId = parent.id;
  }

  let fullBlobKey: string | null = null;
  let thumbBlobKey: string | null = null;
  // Hash + size of whatever blob we store (file or inline content), computed once
  // here so the report never has to re-read the blob just to hash it.
  let sha256: string | null = null;
  let sizeBytes: number | null = null;

  if (file) {
    fullBlobKey = randomUUID();
    await app.blobs.put(fullBlobKey, file.data);
    sha256 = createHash('sha256').update(file.data).digest('hex');
    sizeBytes = file.data.length;
    if (metadata.contentType === 'image') {
      try {
        // Cap decoded pixels (~40 MP, far above any legitimate screenshot) so a
        // decompression-bomb image can't exhaust memory during thumbnailing.
        const thumb = await sharp(file.data, { limitInputPixels: 40_000_000 })
          .resize(THUMB_MAX, THUMB_MAX, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        thumbBlobKey = randomUUID();
        await app.blobs.put(thumbBlobKey, thumb);
      } catch (err) {
        app.log.warn({ err }, 'thumbnail generation failed; storing without thumbnail');
      }
    }
  } else if (metadata.content !== undefined && metadata.content !== '') {
    // Inline text content (codeblock/event/note) is stored as a blob too, so all
    // evidence content is retrievable through one content endpoint.
    const buf = Buffer.from(metadata.content, 'utf8');
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
          select: { id: true },
        })
      : [];

  const occurredAt = metadata.occurredAt ? new Date(metadata.occurredAt) : new Date();

  // Preserve the original filename (explicit client value wins, else the uploaded
  // file's own name). Used to name files in the report's supporting-files ZIP and
  // the "Files Attached" table. Truncated to the column bound.
  const rawName = metadata.originalFilename ?? file?.filename ?? null;
  const originalFilename = rawName ? rawName.slice(0, 255) : null;

  const created = await app.db.evidence.create({
    data: {
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
    },
    include: evidenceInclude(args.operatorId),
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
