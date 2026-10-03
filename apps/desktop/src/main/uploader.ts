import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { listQueue, updateItem } from './queue.js';
import { makeClient } from './reporter-client.js';

let running = false;

/**
 * Drain all pending/failed queue items to the server. Serial, with the queue as
 * the source of truth; safe to call repeatedly (guards against re-entry).
 * `onChange` is invoked after each status transition so the UI can refresh.
 */
export async function drainQueue(onChange: () => void): Promise<void> {
  if (running) return;
  running = true;
  try {
    const client = makeClient();
    if (!client) return; // not configured yet

    for (const item of listQueue()) {
      if (item.status !== 'pending' && item.status !== 'failed') continue;

      updateItem(item.id, { status: 'submitting', error: undefined });
      onChange();

      try {
        let file: { filename: string; contentType: string; data: Buffer } | undefined;
        // The on-disk screenshot is a `reporter-<uuid>.png` temp file, so give the
        // upload a meaningful original filename (timestamped) rather than the uuid.
        let originalFilename: string | undefined;
        if (item.contentType === 'image' && item.filePath) {
          const data = await readFile(item.filePath);
          file = { filename: basename(item.filePath), contentType: 'image/png', data };
          const stamp = (item.occurredAt ?? '').replace(/[:.]/g, '-').slice(0, 19) || 'capture';
          originalFilename = `screenshot-${stamp}.png`;
        }
        const created = await client.createEvidence(
          item.engagementSlug,
          {
            contentType: item.contentType,
            title: item.title,
            description: item.description,
            tagIds: item.tagIds,
            occurredAt: item.occurredAt,
            content: item.content,
            contentSubtype: item.contentSubtype,
            parentEvidenceUuid: item.parentEvidenceUuid,
            originalFilename,
            // Captures start report-eligible; excluding one is an editorial call
            // made later in the web UI, so the tray app never sets this.
            excludeFromReport: false,
          },
          file,
        );
        updateItem(item.id, { status: 'submitted', serverUuid: created.uuid, error: undefined });
      } catch (err) {
        updateItem(item.id, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      onChange();
    }
  } finally {
    running = false;
  }
}
