import type { FastifyRequest } from 'fastify';
import { createEvidenceInput, type CreateEvidenceInput } from '@reporter/shared';
import { HttpError } from '../auth/guards.js';
import { parseMultipart } from '../helpers/multipart.js';

export interface EvidenceRequest {
  metadata: CreateEvidenceInput;
  file?: { data: Buffer; mimeType: string; filename: string };
}

/**
 * Extract evidence metadata (+ optional file) from a create-evidence request,
 * supporting both `multipart/form-data` (JSON `notes` part + `file` part) and a
 * plain JSON body (inline content, no file). Shared by the web and client APIs.
 *
 * Clients that predate `excludeFromReport` keep parsing: the schema defaults it to
 * false. There is no HMAC *update* route, so a client can only ever set the flag as it
 * creates the evidence (findings-import does, to restore an export); the web UI toggles
 * it afterwards through `PUT /web/engagements/:slug/evidence/:uuid`.
 */
export async function parseEvidenceRequest(req: FastifyRequest): Promise<EvidenceRequest> {
  const contentType = req.headers['content-type'] ?? '';

  if (contentType.startsWith('multipart/form-data')) {
    if (!req.rawBody) throw new HttpError(400, 'Empty multipart body');
    const { fields, files } = await parseMultipart(req.rawBody, contentType);
    if (!fields.notes) throw new HttpError(400, 'Missing "notes" metadata part');

    let notes: unknown;
    try {
      notes = JSON.parse(fields.notes);
    } catch {
      throw new HttpError(400, 'The "notes" part is not valid JSON');
    }
    const metadata = createEvidenceInput.parse(notes);
    const filePart = files.find((f) => f.field === 'file');
    return {
      metadata,
      file: filePart
        ? { data: filePart.data, mimeType: filePart.mimeType, filename: filePart.filename }
        : undefined,
    };
  }

  // JSON body: inline content only.
  const metadata = createEvidenceInput.parse(req.body);
  return { metadata };
}

/** Best-effort content-type for serving a stored evidence blob back to a client. */
export function evidenceContentMime(evidenceContentType: string, blob: Buffer): string {
  if (evidenceContentType === 'image') {
    // Sniff common image magic bytes.
    if (blob.length >= 8 && blob[0] === 0x89 && blob[1] === 0x50) return 'image/png';
    if (blob.length >= 3 && blob[0] === 0xff && blob[1] === 0xd8) return 'image/jpeg';
    if (blob.length >= 4 && blob[0] === 0x47 && blob[1] === 0x49) return 'image/gif';
    if (blob.length >= 12 && blob.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return 'application/octet-stream';
  }
  if (evidenceContentType === 'http-request-cycle') return 'application/json; charset=utf-8';
  // codeblock / script / terminal-recording / event / none are all text.
  return 'text/plain; charset=utf-8';
}
