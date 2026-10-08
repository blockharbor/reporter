import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  EDITABLE_TEXT_EVIDENCE_TYPES,
  EVIDENCE_TYPE_LABELS,
  MAX_SCRIPT_BYTES,
  SCRIPT_TOO_LARGE_REASON,
  createEvidenceCommentInput,
  evidenceCarriesSubtype,
  evidenceFileExtension,
  isEditableTextEvidence,
  isEvidenceType,
  parseQuery,
  updateEvidenceCommentInput,
  updateEvidenceInput,
} from '@reporter/shared';
import { requireAuth, requireEngagementRole, HttpError } from '../../auth/guards.js';
import { parsePagination } from '../../helpers/pagination.js';
import { createEvidence, decodeScriptUpload, listEvidence } from '../../services/evidence.js';
import {
  evidenceInclude,
  serializeEvidence,
  serializeEvidenceComment,
} from '../../services/serializers.js';
import { evidenceContentMime, parseEvidenceRequest } from '../shared-evidence.js';

async function engagementBySlug(app: FastifyInstance, slug: string) {
  return app.db.engagement.findUniqueOrThrow({ where: { slug } });
}

/** The fields {@link evidenceDisposition} needs to name a download. */
interface DownloadNameable {
  originalFilename: string | null;
  contentType: string;
  contentSubtype: string | null;
  uuid: string;
}

/**
 * Build the `Content-Disposition` header for a served evidence blob.
 *
 * `attachment` for everything except screenshots. Nothing in the web app *navigates*
 * to a code block, a script, a HAR or an asciicast: `useEvidenceText` and the
 * evidence viewers read them with `fetch().text()` and the terminal player hands the
 * URL to asciinema, and `Content-Disposition` is only consulted when a response is
 * navigated to — never when it is fetched as a subresource. So this costs those
 * viewers nothing, while a hand-typed or pasted content URL downloads the bytes
 * instead of asking the browser to render operator-supplied text.
 *
 * Screenshots stay `inline` because they are the one case the app really does render
 * as a browser-managed subresource (`<img src>` in `ImageViewer`). Browsers ignore
 * the header for `<img>` either way, but claiming `attachment` for a resource we
 * deliberately display inline is a lie the next reader would have to re-derive.
 * Inline is safe on the image branch's own terms: its MIME comes from sniffing magic
 * bytes against a fixed list of raster formats, so an SVG or an HTML page renamed
 * `.png` is served `application/octet-stream`, not markup.
 *
 * The filename is a download hint only — never a path. It comes from
 * `originalFilename`, which is operator-supplied, so it is reduced to a conservative
 * ASCII subset for the quoted form: a bare CR or LF in a header value is a response
 * splitting attempt, and Node would reject the whole reply rather than send it. The
 * RFC 6266 `filename*` parameter carries the real UTF-8 name for clients that read
 * it.
 */
function evidenceDisposition(ev: DownloadNameable): string {
  const type = ev.contentType === 'image' ? 'inline' : 'attachment';
  const base = ev.originalFilename?.split(/[\\/]/).pop()?.trim();
  const name = (
    base ||
    `${ev.contentType}-${ev.uuid.slice(0, 8)}${evidenceFileExtension(ev.contentType, ev.contentSubtype)}`
  ).slice(0, 120);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'evidence';
  // encodeURIComponent leaves ' ( ) * alone; they are not RFC 5987 attr-chars.
  const utf8 = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * The types a piece of evidence may be re-typed to, as report-caption labels —
 * derived from `EVIDENCE_TEXT_EDITABLE`, so a new text type joins this sentence
 * without being hand-added to it.
 */
const TEXT_TYPE_LABELS = EDITABLE_TEXT_EVIDENCE_TYPES.map((t) => EVIDENCE_TYPE_LABELS[t]).join(
  ', ',
);

/** Label for a stored `contentType`, narrowed rather than cast: the column is
 *  plain TEXT, so a value this build doesn't know prints as itself instead of
 *  `undefined`. */
function typeLabel(contentType: string): string {
  return isEvidenceType(contentType) ? EVIDENCE_TYPE_LABELS[contentType] : contentType;
}

export async function evidenceRoutes(app: FastifyInstance): Promise<void> {
  // Timeline listing with filter query.
  app.get(
    '/engagements/:slug/evidence',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const query = (req.query as { q?: string }).q ?? '';
      const eng = await engagementBySlug(app, slug);
      return listEvidence(
        app,
        eng.id,
        slug,
        parseQuery(query),
        parsePagination(req.query as any),
        req.authedUser!.id,
      );
    },
  );

  // Create evidence (multipart or JSON).
  app.post(
    '/engagements/:slug/evidence',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const eng = await engagementBySlug(app, slug);
      const { metadata, file } = await parseEvidenceRequest(req);
      const evidence = await createEvidence(app, {
        engagementId: eng.id,
        engagementSlug: slug,
        operatorId: req.authedUser!.id,
        metadata,
        file,
      });
      reply.status(201);
      return evidence;
    },
  );

  // Distinct operators who have evidence in this engagement (powers the operator filter).
  // Declared before the `:uuid` handler so intent is clear; find-my-way also prioritizes
  // the static `operators` segment over the `:uuid` param.
  // Driven from `users`, so a deleted operator drops out rather than arriving as a null
  // entry — their anonymized evidence stays in the timeline, just no longer filterable.
  app.get(
    '/engagements/:slug/evidence/operators',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug } = req.params as { slug: string };
      const eng = await engagementBySlug(app, slug);
      const users = await app.db.user.findMany({
        where: { evidence: { some: { engagementId: eng.id } } },
        select: { slug: true, firstName: true, lastName: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      });
      return users;
    },
  );

  app.get(
    '/engagements/:slug/evidence/:uuid',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const eng = await engagementBySlug(app, slug);
      const ev = await app.db.evidence.findFirst({
        where: { uuid, engagementId: eng.id },
        include: evidenceInclude(req.authedUser!.id),
      });
      if (!ev) throw new HttpError(404, 'Evidence not found');
      return serializeEvidence(ev, slug);
    },
  );

  // Star / unstar a piece of evidence for the current user. Read-only members
  // may star too — it's a personal marker, like engagement favorites.
  app.post(
    '/engagements/:slug/evidence/:uuid/star',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const { starred } = z.object({ starred: z.boolean() }).parse(req.body);
      const eng = await engagementBySlug(app, slug);
      const ev = await app.db.evidence.findFirst({
        where: { uuid, engagementId: eng.id },
        select: { id: true },
      });
      if (!ev) throw new HttpError(404, 'Evidence not found');
      await app.db.userEvidencePref.upsert({
        where: { userId_evidenceId: { userId: req.authedUser!.id, evidenceId: ev.id } },
        create: { userId: req.authedUser!.id, evidenceId: ev.id, isFavorite: starred },
        update: { isFavorite: starred },
      });
      return { starred };
    },
  );

  // Serve the full blob content.
  app.get(
    '/engagements/:slug/evidence/:uuid/content',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req, reply) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const eng = await engagementBySlug(app, slug);
      const ev = await app.db.evidence.findFirst({ where: { uuid, engagementId: eng.id } });
      if (!ev || !ev.fullBlobKey) throw new HttpError(404, 'No content for this evidence');
      const blob = await app.blobs.getBuffer(ev.fullBlobKey);
      // INVARIANT: the MIME served here is derived from the *evidence type* (plus,
      // for images, sniffed magic bytes against a closed list of raster formats) and
      // never from the uploaded file's own Content-Type. That is load-bearing, not a
      // shortcut. Evidence is same-origin with the session cookie, so echoing an
      // uploader's `image/svg+xml` or `text/html` back here would turn any upload
      // into stored XSS against every reviewer who opens it — one evidence item to
      // read any engagement the viewer can see. Keep `evidenceContentMime` answering
      // from its fixed list; never pass `file.mimeType` through to a response.
      reply.header('Content-Type', evidenceContentMime(ev.contentType, blob));
      // Defence in depth behind that invariant: no MIME sniffing, so a text/plain
      // body that happens to open with `<html>` is not re-read as markup, and an
      // `application/octet-stream` image is not promoted to anything renderable.
      //
      // It does not cost us the one response the browser fetches for itself. An
      // image whose format is outside `evidenceContentMime`'s raster list (AVIF,
      // HEIC, BMP…) is served `application/octet-stream`, and `nosniff` + a
      // non-image type sounds like it should break `<img>`. It does not here: per
      // Fetch, nosniff only turns a response into a network error for the `script`
      // and `style` destinations, and Chrome's opaque-response blocking — which does
      // reject nosniff'd non-media types — applies to cross-origin no-cors responses
      // only, while every evidence `<img src>` in the app is same-origin. The
      // timeline is insulated regardless: it renders `thumbBlobKey`, which is always
      // a sharp-re-encoded JPEG.
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', evidenceDisposition(ev));
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(blob);
    },
  );

  // Serve the thumbnail (images only).
  app.get(
    '/engagements/:slug/evidence/:uuid/thumbnail',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req, reply) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const eng = await engagementBySlug(app, slug);
      const ev = await app.db.evidence.findFirst({ where: { uuid, engagementId: eng.id } });
      if (!ev || !ev.thumbBlobKey) throw new HttpError(404, 'No thumbnail');
      const blob = await app.blobs.getBuffer(ev.thumbBlobKey);
      // Not a guess: a thumbnail is always a JPEG this server re-encoded with sharp,
      // so none of the uploaded bytes survive into it. `nosniff` is still set, since
      // the whole point of the header is that no response on this origin invites the
      // browser to second-guess a declared type. No disposition: thumbnails exist to
      // be rendered inline in timeline rows (`<img src>`), which is the default.
      reply.header('Content-Type', 'image/jpeg');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, max-age=86400');
      return reply.send(blob);
    },
  );

  // List the linked evidence (child evidence) attached to this piece of evidence,
  // oldest first — a chronological thread of follow-ups/updates.
  app.get(
    '/engagements/:slug/evidence/:uuid/linked-evidence',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const eng = await engagementBySlug(app, slug);
      const parent = await app.db.evidence.findFirst({
        where: { uuid, engagementId: eng.id },
        select: { id: true },
      });
      if (!parent) throw new HttpError(404, 'Evidence not found');
      const linked = await app.db.evidence.findMany({
        where: { parentEvidenceId: parent.id },
        include: evidenceInclude(req.authedUser!.id),
        orderBy: { occurredAt: 'asc' },
      });
      return linked.map((c) => serializeEvidence(c, slug));
    },
  );

  // --- Plain-text comments (a discussion thread on the evidence) ---
  const commentAuthorInclude = {
    author: { select: { slug: true, firstName: true, lastName: true } },
  } as const;

  /** Resolve the evidence row (scoped to the engagement) or 404. */
  async function evidenceOr404(engId: number, uuid: string) {
    const ev = await app.db.evidence.findFirst({
      where: { uuid, engagementId: engId },
      select: { id: true },
    });
    if (!ev) throw new HttpError(404, 'Evidence not found');
    return ev;
  }

  // List comments on a piece of evidence, oldest first.
  app.get(
    '/engagements/:slug/evidence/:uuid/comments',
    { preHandler: [requireAuth, requireEngagementRole('read')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const eng = await engagementBySlug(app, slug);
      const ev = await evidenceOr404(eng.id, uuid);
      const comments = await app.db.evidenceComment.findMany({
        where: { evidenceId: ev.id },
        include: commentAuthorInclude,
        orderBy: { createdAt: 'asc' },
      });
      return comments.map(serializeEvidenceComment);
    },
  );

  // Add a comment (any writer).
  app.post(
    '/engagements/:slug/evidence/:uuid/comments',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req, reply) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const eng = await engagementBySlug(app, slug);
      const ev = await evidenceOr404(eng.id, uuid);
      const body = createEvidenceCommentInput.parse(req.body);
      // Pin created == updated at insert so `edited` (updatedAt > createdAt) is a
      // clean strict comparison — otherwise the tiny app/DB clock skew between the
      // `@default(now())` and `@updatedAt` values could read as "edited".
      const now = new Date();
      const created = await app.db.evidenceComment.create({
        data: {
          evidenceId: ev.id,
          authorId: req.authedUser!.id,
          body: body.body,
          createdAt: now,
          updatedAt: now,
        },
        include: commentAuthorInclude,
      });
      reply.code(201);
      return serializeEvidenceComment(created);
    },
  );

  // Edit a comment — author only.
  app.put(
    '/engagements/:slug/evidence/comments/:commentUuid',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, commentUuid } = req.params as { slug: string; commentUuid: string };
      const eng = await engagementBySlug(app, slug);
      const body = updateEvidenceCommentInput.parse(req.body);
      const existing = await app.db.evidenceComment.findFirst({
        where: { uuid: commentUuid, evidence: { engagementId: eng.id } },
        select: { id: true, authorId: true },
      });
      if (!existing) throw new HttpError(404, 'Comment not found');
      // `authorId` is null once that user has been deleted, so this also (correctly)
      // refuses: an anonymized comment is nobody's to edit.
      if (existing.authorId !== req.authedUser!.id) {
        throw new HttpError(403, 'You can only edit your own comments.');
      }
      const updated = await app.db.evidenceComment.update({
        where: { id: existing.id },
        data: { body: body.body },
        include: commentAuthorInclude,
      });
      return serializeEvidenceComment(updated);
    },
  );

  // Delete a comment — author only.
  app.delete(
    '/engagements/:slug/evidence/comments/:commentUuid',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, commentUuid } = req.params as { slug: string; commentUuid: string };
      const eng = await engagementBySlug(app, slug);
      const existing = await app.db.evidenceComment.findFirst({
        where: { uuid: commentUuid, evidence: { engagementId: eng.id } },
        select: { id: true, authorId: true },
      });
      if (!existing) throw new HttpError(404, 'Comment not found');
      // As with the edit above, a null (deleted) author matches nobody.
      if (existing.authorId !== req.authedUser!.id) {
        throw new HttpError(403, 'You can only delete your own comments.');
      }
      await app.db.evidenceComment.delete({ where: { id: existing.id } });
      return { ok: true };
    },
  );

  // Update title / description / tags / occurredAt / report exclusion / body text /
  // language-interpreter / content type, and optionally re-parent the evidence
  // (attach/move/detach its comment link) via `parentEvidenceUuid`.
  app.put(
    '/engagements/:slug/evidence/:uuid',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const eng = await engagementBySlug(app, slug);
      const body = updateEvidenceInput.parse(req.body);

      const ev = await app.db.evidence.findFirst({ where: { uuid, engagementId: eng.id } });
      if (!ev) throw new HttpError(404, 'Evidence not found');

      // Re-parenting the comment link (attach/move/detach). Only touched when the
      // field is present: `undefined` leaves the link unchanged, `null` detaches to
      // top-level, a uuid attaches/moves this evidence as a comment on the referenced
      // (top-level, same-engagement) item. Comments are one level deep. The self
      // check is cheap and stateless, so it's done up front.
      const reparent = body.parentEvidenceUuid !== undefined;
      if (reparent && body.parentEvidenceUuid !== null && body.parentEvidenceUuid === ev.uuid) {
        throw new HttpError(400, "Evidence can't be a comment on itself.");
      }
      let parentEvidenceId: number | null = null;

      // Type change — code block ↔ script above all, now that one renders through
      // the markdown renderer and the other prints verbatim. Allowed between any
      // two text-backed types, in either direction, because they all store the same
      // UTF-8 text blob: the change is metadata only and the stored bytes are never
      // rewritten. `isEditableTextEvidence` is that set — the same one that decides
      // whether the body is editable at all, rather than a second hand-written list
      // of permitted pairs that would drift from it.
      const requestedType = body.contentType;
      const changingType = requestedType !== undefined && requestedType !== ev.contentType;
      if (changingType) {
        // 400 like the content/interpreter guards below, and for the same reason:
        // the payload is well formed and names a real type, it just asks for
        // something this row's stored bytes cannot support. Both messages name the
        // side that failed — "the request was invalid" would leave the operator to
        // guess which of the two types was the problem.
        //
        // Phrased by what the stored file *is for* rather than by its bytes: an
        // asciicast is perfectly good text, so "not text" is a reason the operator
        // could disprove by opening it. What rules a recording out is that its file
        // is a player's format with no editable body in it, which is true of a
        // screenshot too.
        if (!isEditableTextEvidence(ev.contentType)) {
          throw new HttpError(
            400,
            `A ${typeLabel(ev.contentType)} can't change type — what's stored for it is a file only its own viewer reads, not an editable text body. Only text evidence (${TEXT_TYPE_LABELS}) can be re-typed.`,
          );
        }
        if (!isEditableTextEvidence(requestedType)) {
          throw new HttpError(
            400,
            `This evidence can't become a ${EVIDENCE_TYPE_LABELS[requestedType]} — that type is stored as a file for its own viewer, and this evidence holds an editable text body. Pick one of ${TEXT_TYPE_LABELS}.`,
          );
        }
      }
      /**
       * The type this request leaves behind. Everything below reads it instead of
       * `ev.contentType`: one request may change the type *and* the interpreter (a
       * code block becoming a `bash` script), and judging the interpreter against
       * the stale stored type would refuse that legitimate edit outright.
       */
      const effectiveType = requestedType ?? ev.contentType;

      // Content edit: replace the stored text blob. Only text evidence has an
      // editable body; images/recordings keep their uploaded file. The new blob is
      // written up front (outside the DB tx, mirroring create); the old one is
      // reclaimed only after the row update commits. Empty content clears the blob.
      // Which types have an editable body is decided once, in `EVIDENCE_TEXT_EDITABLE`
      // — a hand-copied list here is how this route came to reject a `content` update
      // for a type the web app was happily offering an editor for.
      const editingContent = body.content !== undefined;
      if (editingContent && !isEditableTextEvidence(effectiveType)) {
        throw new HttpError(400, "This evidence type's content can't be edited.");
      }

      /*
       * Becoming a script means taking on the only type-level invariant any of
       * these types has about its stored bytes: UTF-8 text, no embedded NULs, and
       * under `MAX_SCRIPT_BYTES`. Both ways into that column already enforce it
       * (`decodeScriptUpload` for an upload, the same cap for typed content), and a
       * re-type is now a third — so it has to enforce it too. Neither precondition
       * is exotic: the cap is a script's alone, so a 2 MB code block is ordinary,
       * and nothing at create pairs an uploaded `file` with a *text* type, so a
       * code block whose blob is a binary is equally ordinary. Relabelled into a
       * script, either one renders verbatim — a wall of replacement characters, or
       * a megabyte of text, straight into a client's PDF.
       *
       * Only when the request isn't also replacing the body: then it is the new
       * bytes that matter, and those are checked below against the same cap.
       */
      if (changingType && effectiveType === 'script' && !editingContent && ev.fullBlobKey) {
        // Size off the column first. Refusing an oversized blob must not require
        // reading it into memory, which is the very thing the cap exists to prevent.
        if ((ev.sizeBytes ?? 0) > MAX_SCRIPT_BYTES) {
          throw new HttpError(413, SCRIPT_TOO_LARGE_REASON);
        }
        // Then the text test itself, from the one place that owns it — it re-checks
        // the size as well, which also covers a row whose `sizeBytes` is missing.
        decodeScriptUpload(await app.blobs.getBuffer(ev.fullBlobKey));
      }

      // Language / interpreter edit. Correctable on purpose: for a script this value
      // chooses the extension the supporting-files ZIP entry gets, so a typo in it
      // mis-names a file handed to a client, and re-creating the evidence was the only
      // remedy while the column was write-once. Refused outright for a type that has
      // no reader for it (`evidenceCarriesSubtype`) rather than stored and ignored.
      // Blank normalizes to null, so "no interpreter" is one value in the column.
      // Judged against `effectiveType`: a code block becoming a `bash` script sends
      // both fields in one request, and checking the interpreter against the type
      // being left behind would refuse that edit for a type it no longer has.
      // An explicit `null` is exempt: it is a clear, not a value, and there is
      // nothing for a type with no reader to disagree with. Refusing it made the
      // obvious request — "become a Note and drop the interpreter" — an error,
      // while *omitting* the field cleared the column anyway (just below).
      const editingSubtype = body.contentSubtype !== undefined;
      if (
        editingSubtype &&
        body.contentSubtype !== null &&
        !evidenceCarriesSubtype(effectiveType)
      ) {
        throw new HttpError(400, "This evidence type doesn't carry a language or interpreter.");
      }
      // A type change carries the interpreter / language over when the new type
      // reads one too — a code block's `bash` is a script's `bash`, and the name the
      // report derives for it goes from `.bash` to `.sh` (only derives: evidence
      // that arrived as an upload keeps its `originalFilename`, which beats the
      // type-derived name everywhere, deliberately — a file already listed in a
      // delivered archive's "Files Attached" table must not be renamed under the
      // client). When the new type reads none, the column is
      // cleared rather than left holding a value nothing will ever show again, so a
      // stale `bash` can't linger invisibly and reappear on a later re-type.
      const subtypePatch = editingSubtype
        ? { contentSubtype: body.contentSubtype?.trim() || null }
        : changingType && !evidenceCarriesSubtype(effectiveType)
          ? { contentSubtype: null }
          : undefined;
      let blobPatch:
        { fullBlobKey: string | null; sha256: string | null; sizeBytes: number | null } | undefined;
      if (editingContent) {
        const text = body.content ?? '';
        if (text === '') {
          blobPatch = { fullBlobKey: null, sha256: null, sizeBytes: null };
        } else {
          // The script cap applies to an edit as well as a create, or a 1 KB script
          // could be grown past it by the very editor the cap exists to protect.
          // Against the resulting type, so a code block cannot be re-typed to a
          // script and grown past the cap in the same request.
          if (effectiveType === 'script' && Buffer.byteLength(text, 'utf8') > MAX_SCRIPT_BYTES) {
            throw new HttpError(413, SCRIPT_TOO_LARGE_REASON);
          }
          const buf = Buffer.from(text, 'utf8');
          const key = randomUUID();
          await app.blobs.put(key, buf);
          blobPatch = {
            fullBlobKey: key,
            sha256: createHash('sha256').update(buf).digest('hex'),
            sizeBytes: buf.length,
          };
        }
      }

      await app.db.$transaction(async (tx) => {
        if (reparent && body.parentEvidenceUuid !== null) {
          // Attach/move: resolve the target, then lock BOTH the subject and target
          // rows FOR UPDATE (ordered by id to avoid deadlock) and re-check the
          // one-level-deep invariant under the lock. Validating inside the transaction
          // closes the check-then-act race where two concurrent re-parents could
          // otherwise slip past and build a cycle (A↔B) or a 2-level chain.
          const target = await tx.evidence.findFirst({
            where: { uuid: body.parentEvidenceUuid, engagementId: eng.id },
            select: { id: true },
          });
          if (!target) throw new HttpError(400, 'Target evidence not found in this engagement.');

          const ids = [ev.id, target.id].sort((a, b) => a - b);
          await tx.$queryRaw`SELECT id FROM evidence WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;

          // Target must (still) be top-level — no commenting on a comment.
          const targetRow = await tx.evidence.findUnique({
            where: { id: target.id },
            select: { parentEvidenceId: true },
          });
          if (!targetRow) throw new HttpError(400, 'Target evidence not found in this engagement.');
          if (targetRow.parentEvidenceId !== null) {
            throw new HttpError(
              400,
              'Cannot comment on a comment (linked evidence is one level deep)',
            );
          }
          // The evidence being re-linked must (still) not host its own comments — a
          // comment can't have children.
          const childCount = await tx.evidence.count({ where: { parentEvidenceId: ev.id } });
          if (childCount > 0) {
            throw new HttpError(
              400,
              `Detach its ${childCount} comment(s) first — comments are one level deep.`,
            );
          }
          parentEvidenceId = target.id;
        }

        await tx.evidence.update({
          where: { id: ev.id },
          data: {
            title: body.title ?? undefined,
            description: body.description ?? undefined,
            occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
            // Re-label the type, validated above as a move between two text-backed
            // types. Nothing else moves with it: the blob keys, hash and size stay
            // as they are, and the content route re-reads this column on every
            // request, so the MIME it serves — and the download name, where that is
            // derived from the type rather than taken from `originalFilename` —
            // follow the new type from the next read on.
            contentType: body.contentType,
            // Hide from / re-include in every report output; absent leaves it as it is.
            // The evidence itself stays fully visible in the app either way.
            excludeFromReport: body.excludeFromReport,
            // Record who made this edit (any field), which also bumps updatedAt. That
            // includes a bare `excludeFromReport` toggle: deciding what the client does
            // and does not see is exactly what an audit trail should record.
            lastEditedById: req.authedUser!.id,
            // Only re-link when the field was present (value may be null for detach).
            ...(reparent ? { parentEvidenceId } : {}),
            // Swap the content blob when the body was edited.
            ...(blobPatch ?? {}),
            // Re-name the language / interpreter when that field was present.
            ...(subtypePatch ?? {}),
          },
        });
        if (body.tagIds) {
          const valid = await tx.tag.findMany({
            where: { id: { in: body.tagIds }, engagementId: eng.id },
            select: { id: true },
          });
          await tx.evidenceTag.deleteMany({ where: { evidenceId: ev.id } });
          await tx.evidenceTag.createMany({
            data: valid.map((t) => ({ evidenceId: ev.id, tagId: t.id })),
          });
        }
      });

      // Reclaim the replaced/cleared content blob now the swap has committed.
      if (editingContent && ev.fullBlobKey && ev.fullBlobKey !== blobPatch?.fullBlobKey) {
        await app.blobs.delete(ev.fullBlobKey).catch(() => {});
      }

      const updated = await app.db.evidence.findUniqueOrThrow({
        where: { id: ev.id },
        include: evidenceInclude(req.authedUser!.id),
      });
      return serializeEvidence(updated, slug);
    },
  );

  // Delete evidence. When it has comments (linked evidence), `?comments=` decides
  // their fate: `cascade` deletes them too; `orphan` (default) promotes them to
  // top-level evidence via the SetNull self-relation, preserving their content.
  app.delete(
    '/engagements/:slug/evidence/:uuid',
    { preHandler: [requireAuth, requireEngagementRole('write')] },
    async (req) => {
      const { slug, uuid } = req.params as { slug: string; uuid: string };
      const mode =
        (req.query as { comments?: string }).comments === 'cascade' ? 'cascade' : 'orphan';
      const eng = await engagementBySlug(app, slug);
      const ev = await app.db.evidence.findFirst({ where: { uuid, engagementId: eng.id } });
      if (!ev) throw new HttpError(404, 'Evidence not found');

      // Blobs to reclaim once the rows are gone: always the target's own; plus each
      // comment's when cascading (orphaned comments keep their content).
      const blobKeys: (string | null)[] = [ev.fullBlobKey, ev.thumbBlobKey];

      if (mode === 'cascade') {
        // Read the comments here so the rows we delete and the blobs we reclaim come
        // from the same set. A comment created concurrently (after this read) isn't
        // in the list; the parent delete's SetNull promotes it to top-level with its
        // blob intact rather than leaking it.
        const comments = await app.db.evidence.findMany({
          where: { parentEvidenceId: ev.id },
          select: { id: true, fullBlobKey: true, thumbBlobKey: true },
        });
        for (const c of comments) blobKeys.push(c.fullBlobKey, c.thumbBlobKey);
        await app.db.$transaction([
          app.db.evidence.deleteMany({ where: { id: { in: comments.map((c) => c.id) } } }),
          app.db.evidence.delete({ where: { id: ev.id } }),
        ]);
      } else {
        // orphan: deleting the parent nulls each comment's parentEvidenceId.
        await app.db.evidence.delete({ where: { id: ev.id } });
      }

      for (const key of blobKeys) if (key) await app.blobs.delete(key).catch(() => {});
      return { ok: true };
    },
  );
}
