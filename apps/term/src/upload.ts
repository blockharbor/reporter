import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { TermConfig } from './config.js';
import { makeClient } from './client.js';

export interface RecordingMeta {
  engagementSlug: string;
  /** Short label shown as the evidence heading (required). */
  title: string;
  description: string;
  tagIds: number[];
  /** When set, upload this recording as linked evidence on the given evidence. */
  parentEvidenceUuid?: string;
}

/** Upload an asciicast file as terminal-recording evidence. Returns its uuid. */
export async function uploadCast(
  config: TermConfig,
  castPath: string,
  meta: RecordingMeta,
): Promise<string> {
  const data = await readFile(castPath);
  const client = makeClient(config);
  const evidence = await client.createEvidence(
    meta.engagementSlug,
    {
      contentType: 'terminal-recording',
      title: meta.title,
      description: meta.description,
      tagIds: meta.tagIds,
      occurredAt: new Date().toISOString(),
      parentEvidenceUuid: meta.parentEvidenceUuid,
      // Recordings are captured to be reported on; exclusion is a later editorial
      // call, made in the web UI on the evidence itself.
      excludeFromReport: false,
    },
    { filename: basename(castPath), contentType: 'application/x-asciicast', data },
  );
  return evidence.uuid;
}
