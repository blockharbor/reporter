/**
 * Whole-engagement transfer: download one engagement as a self-contained `.zip`
 * that can recreate it on another reporter server.
 *
 * Separate from `report.ts` (report documents and the findings-scoped JSON export,
 * which are deliverables) and from the engagement CRUD in `engagements.ts`. The
 * matching import lives here too, as `POST /engagements/import` — deliberately
 * without a `:slug`, so no existing engagement is addressable and an import can
 * only ever create a new one.
 */
import type { FastifyInstance } from 'fastify';
import { engagementImportInput } from '@reporter/shared';
import { HttpError, requireAdmin, requireAuth, requireEngagementRole } from '../../auth/guards.js';
import { stamp } from '../../helpers/filename.js';
import { parseMultipart } from '../../helpers/multipart.js';
import { auditCtx, n, q, recordAudit } from '../../services/audit.js';
import { buildEngagementExport } from '../../services/engagement-export.js';
import { engagementImportBodyLimit, importEngagement } from '../../services/engagement-import.js';

/** Full engagement export and import. */
export async function engagementTransferRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Download the whole engagement as a backup archive.
   *
   * Guarded on the engagement `admin` role, a step above the `read` that the report
   * routes in `report.ts` use — including `GET /findings/export.json`, which with
   * `?includeExcludedEvidence` is the closest existing thing to a backup.
   *
   * The bar was first set as *aggregation*: a `read` member can already fetch every
   * evidence blob, every comment and every stored report artifact one request at a
   * time, and this route only bundles them. That is no longer the whole story. The
   * archive now carries the engagement's audit log, which a read member cannot see
   * at all (the Audit log tab is writers and admins), and which includes the
   * engagement's membership history and the display name and email of everyone who
   * ever acted on it. So the `admin` bar is now also about *new access*, and it
   * stays an engagement role rather than a site-admin one because that is the same
   * class of act as the operations already gated on `admin` here — editing the
   * engagement's settings, managing its membership, and deleting it. DESIGN.md's
   * description of what an export contains says the same.
   *
   * `?includeAuditLog=0` leaves the log out, for a hand-off that should not carry
   * who-did-what; the file then stamps the older version and imports anywhere.
   */
  app.get(
    '/engagements/:slug/export.zip',
    { preHandler: [requireAuth, requireEngagementRole('admin')] },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const includeAuditLog = (req.query as { includeAuditLog?: string }).includeAuditLog !== '0';
      const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug } });
      const { archive, manifest, finalize } = await buildEngagementExport(app, eng, new Date(), {
        includeAuditLog,
      });

      // Recorded BEFORE the first byte goes out. The manifest's counts are final
      // here (the records and the blob inventory were read above; `finalize`
      // only streams the bytes), the entry cannot be in the file it describes
      // (the audit rows were read above too), and nothing audit-related runs
      // after `reply.send`: an entry written while the response drains could
      // land after the client holds the whole archive, which is a race a reader
      // of the log would see and a write the request's audit store should not
      // have to outlive. Best-effort, like every read event; a stream that
      // fails part-way still leaves an entry saying the download was begun.
      const c = manifest.counts;
      await recordAudit(auditCtx(req, { id: eng.id, slug: eng.slug, name: eng.name }), {
        action: 'export',
        entityType: 'engagement',
        entity: { id: String(eng.id), label: eng.name },
        summary: `Exported engagement ${q(eng.name)} as a backup (${n(c.evidence, 'evidence', 'evidence')}, ${n(c.findings, 'finding')}, ${c.blobBytes} blob bytes${
          includeAuditLog
            ? `, ${c.auditEntries} of ${c.auditEntriesTotal} audit entries`
            : ', audit log left out'
        })`,
        changes: [
          { kind: 'count', label: 'Evidence', count: c.evidence },
          { kind: 'count', label: 'Findings', count: c.findings },
          { kind: 'count', label: 'Reports', count: c.generatedReports },
          { kind: 'count', label: 'Audit entries written', count: c.auditEntries },
          { kind: 'count', label: 'Audit entries total', count: c.auditEntriesTotal },
        ],
      });

      reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${slug}-engagement-${stamp()}.zip"`);
      // Start streaming before the blob entries are appended, so the archiver
      // drains as they are fed in (bounded memory even for a large engagement).
      reply.send(archive);
      app.log.info({ slug, counts: manifest.counts }, 'engagement export');
      await finalize();
      return reply;
    },
  );

  /**
   * Restore an engagement from an export archive, as a NEW engagement.
   *
   * There is no `:slug` in this path, on purpose: with no engagement in the route
   * there is none for a request to address, so "import into an existing engagement"
   * — overwriting someone's live work with a file — is not a thing a caller can
   * express, rather than a thing the handler has to refuse. The new engagement's
   * slug is derived from the file (uniquified) or taken from the request.
   *
   * Gated on **site admin**, which is deliberately stricter than `POST
   * /engagements`. Creating an empty engagement is an everyday act; restoring one is
   * not, and an import does two things no other route does. It attributes rows to
   * *other* local accounts — `createEvidence` always stamps the caller as operator,
   * so matching exported authorship by email is the only way to write evidence
   * "captured by" somebody else — and it creates an effectively unbounded number of
   * rows and blobs in one request. Both belong with the operator who runs the
   * server, alongside the other site-wide lists in `admin.ts`.
   *
   * The archive arrives as `multipart/form-data` (a `file` part plus optional `name`
   * / `slug` fields), matching the evidence upload rather than inventing a second
   * upload shape. The route raises its body limit well above `MAX_UPLOAD_BYTES` —
   * see `engagementImportBodyLimit`: that config bounds *one* blob, while this file
   * aggregates every blob in an engagement.
   */
  app.post(
    '/engagements/import',
    { preHandler: [requireAuth, requireAdmin], bodyLimit: engagementImportBodyLimit(app) },
    async (req) => {
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.startsWith('multipart/form-data')) {
        throw new HttpError(415, 'Send the export archive as multipart/form-data');
      }
      if (!req.rawBody) throw new HttpError(400, 'Empty multipart body');
      const { fields, files } = await parseMultipart(req.rawBody, contentType);
      const archive = files.find((f) => f.field === 'file');
      if (!archive) throw new HttpError(400, 'Missing "file" part (the engagement export .zip)');

      // Blank form fields mean "not supplied" — an empty string would otherwise
      // fail validation for a field the caller never filled in.
      const overrides = engagementImportInput.parse({
        name: fields.name?.trim() || undefined,
        slug: fields.slug?.trim() || undefined,
      });
      return importEngagement(app, {
        ...overrides,
        archive: archive.data,
        userId: req.authedUser!.id,
        // The import writes its one summary entry inside its own transaction,
        // attributed to this admin and attached to the NEW engagement; it names
        // the source slug and the archive's exportedAt, which is the only place
        // the restored log's provenance survives.
        audit: auditCtx(req),
      });
    },
  );
}
