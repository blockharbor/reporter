/**
 * Restore a whole engagement from an export archive (`POST
 * /web/engagements/import`).
 *
 * The safety property this dialog exists to make visible: an import **always
 * creates a new engagement** and can never modify, overwrite or merge into one that
 * already exists. That is structural on the server — the route has no `:slug`
 * segment, so there is no existing engagement a request could address — and it is
 * stated here before the user commits, not confessed afterwards in a toast.
 *
 * The server's validation messages are written to be actionable ("Unsupported
 * export schema version 2 …", "blobs/<hash> is missing from the archive"), so they
 * are shown verbatim rather than replaced with a generic failure.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Field, Input, Modal, Spinner, useToast } from '@reporter/ui';
import {
  DELETED_USER_LABEL,
  type EngagementImportCreated,
  type EngagementImportResult,
} from '@reporter/shared';
import { ApiError } from '../../api/client.js';
import { useImportEngagement } from '../../api/hooks.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import { slugify, slugifyDraft } from '../../lib/slugify.js';

/** `mm:ss` for the elapsed-time readout while an import runs. */
function fmtElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The row counts worth naming, in the order the import creates them. Labels use the
 * glossary (Engagement, Evidence, Finding, Tag); zeros are hidden so a small
 * archive's summary stays short.
 */
const CREATED_ROWS: { key: keyof EngagementImportCreated; label: string }[] = [
  { key: 'targets', label: 'Targets' },
  { key: 'activities', label: 'Activities' },
  { key: 'goals', label: 'Goals' },
  { key: 'tags', label: 'Tags' },
  { key: 'evidence', label: 'Evidence' },
  { key: 'evidenceComments', label: 'Comments' },
  { key: 'findings', label: 'Findings' },
  { key: 'findingCategories', label: 'Finding categories' },
  { key: 'evidenceLinks', label: 'Evidence attached to Findings' },
  { key: 'goalEvidenceLinks', label: 'Goals linked to Evidence' },
  { key: 'goalFindingLinks', label: 'Goals linked to Findings' },
  { key: 'savedQueries', label: 'Saved queries' },
  { key: 'generatedReports', label: 'Report history entries' },
];

export function ImportEngagementModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const importEngagement = useImportEngagement();
  const fileInput = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EngagementImportResult | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const busy = importEngagement.isPending;

  // Reset on close, not on open: the result stays on screen after a successful
  // import until the user dismisses it.
  useEffect(() => {
    if (!open) {
      setFile(null);
      setDragging(false);
      setName('');
      setSlug('');
      setError(null);
      setResult(null);
    }
  }, [open]);

  /**
   * Elapsed seconds while the import runs. `fetch` reports no upload progress, so a
   * percentage would be invented; the honest signals are the archive's size, the
   * time spent, and a description of which half of the work is happening. (A real
   * progress bar needs XMLHttpRequest in the api client, which is a separate
   * change.)
   */
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  // An import can run for minutes and is not cancellable, so Esc, the overlay and
  // the ✕ all stop working while it is in flight rather than orphaning it.
  const requestClose = () => {
    if (!busy) onClose();
  };

  function selectFile(picked: File | undefined) {
    if (!picked) return;
    setFile(picked);
    setError(null);
  }

  function onFileInput(e: ChangeEvent<HTMLInputElement>) {
    selectFile(e.target.files?.[0]);
    e.target.value = ''; // allow re-selecting the same file later
  }

  // What actually leaves the browser. Blank means "not supplied" — the server then
  // derives the slug from the file and uniquifies it.
  const slugForSubmit = slugify(slug);
  const looksLikeArchive = file ? /\.zip$/i.test(file.name) : true;

  async function submit() {
    if (!file || busy) return;
    setError(null);
    try {
      const r = await importEngagement.mutateAsync({
        file,
        name: name.trim() || undefined,
        slug: slugForSubmit || undefined,
      });
      setResult(r);
      toast.success(`Created ${r.engagement.name}`);
    } catch (err) {
      setError(importErrorMessage(err));
    }
  }

  function startOver() {
    setResult(null);
    setFile(null);
    setName('');
    setSlug('');
    setError(null);
  }

  function openImported(created: EngagementImportResult) {
    onClose();
    navigate(`/engagements/${created.engagement.slug}/evidence`);
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title="Import engagement"
      size="lg"
      footer={
        result ? (
          <>
            <Button variant="ghost" onClick={startOver}>
              Import another
            </Button>
            <Button onClick={() => openImported(result)}>Open engagement</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={requestClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy} disabled={!file}>
              Create new engagement from file
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ImportSummary result={result} />
      ) : busy ? (
        <ImportProgress file={file} elapsed={elapsed} />
      ) : (
        <div className="flex flex-col gap-4">
          {/* The guarantee, before the user commits to anything. */}
          <div className="rounded-card border border-info/30 bg-info/5 p-3">
            <p className="text-sm font-medium text-text">This always creates a new engagement.</p>
            <p className="mt-1 text-sm text-muted">
              An import can never modify, overwrite or merge into an engagement that already exists
              — there is no way to ask it to. Everything in the file is restored into a brand-new
              engagement, and your existing engagements are left exactly as they are.
            </p>
          </div>

          <Field
            label="Engagement export"
            htmlFor="imp-file"
            hint="The .zip written by Export engagement on an engagement's Settings tab."
          >
            {/* First focusable control in the body, so Modal's initial focus lands
                on the file chooser — the only thing this dialog needs to proceed. */}
            <div
              role="button"
              tabIndex={0}
              aria-label="Choose an engagement export archive: click to browse, or drag and drop"
              onClick={() => fileInput.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInput.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                selectFile(e.dataTransfer.files?.[0]);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed p-6 text-center transition-colors ${
                dragging
                  ? 'border-accent bg-surface-2'
                  : 'border-border bg-surface-2/40 hover:border-accent/60'
              }`}
            >
              {file ? (
                <>
                  <p className="max-w-full truncate text-sm font-medium text-text">{file.name}</p>
                  <Badge tone="neutral">{formatBytes(file.size)}</Badge>
                  <p className="text-xs text-muted">Click or drop to choose a different file</p>
                </>
              ) : (
                <>
                  <p className="text-sm text-text">
                    <span className="font-medium text-accent">Choose a file</span> or drag &amp;
                    drop
                  </p>
                  <p className="text-xs text-muted">One engagement export archive (.zip)</p>
                </>
              )}
              <input
                ref={fileInput}
                id="imp-file"
                type="file"
                accept="application/zip,.zip"
                className="hidden"
                onChange={onFileInput}
              />
            </div>
          </Field>
          {!looksLikeArchive && (
            <p className="text-xs text-warning">
              That doesn’t look like a .zip archive. The server will reject it unless it really is
              an engagement export.
            </p>
          )}

          {error && (
            <div className="rounded-card border border-danger/30 bg-danger/5 p-3">
              <p className="text-sm font-medium text-danger">Import failed</p>
              {/* Verbatim: the server's message names the entry, the field path or
                  the version that is wrong, which is what the operator needs. */}
              <p className="mt-1 whitespace-pre-wrap text-sm text-text">{error}</p>
              <p className="mt-1 text-xs text-muted">
                Nothing was created — every check runs before the first row is written.
              </p>
            </div>
          )}

          <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
            <Field
              label="Name"
              htmlFor="imp-name"
              hint="Optional. Blank keeps the name stored in the file."
            >
              <Input
                id="imp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name from the file"
              />
            </Field>
            <Field
              label="Slug"
              htmlFor="imp-slug"
              hint="Optional. Blank uses the file’s slug, made unique if it’s taken."
            >
              <Input
                id="imp-slug"
                value={slug}
                onChange={(e) => setSlug(slugifyDraft(e.target.value))}
                onBlur={() => setSlug(slugify(slug))}
                placeholder="Slug from the file"
              />
            </Field>
          </div>

          <ul className="space-y-1 text-xs text-muted">
            <li>
              A slug you type here is used as-is: if an engagement already has it, the import is
              refused rather than landing somewhere unexpected.
            </li>
            <li>
              You become the new engagement’s admin. Membership isn’t in the file, so nobody else
              gets access until you add them.
            </li>
            <li>
              Evidence and comment authors travel as email addresses and are matched to accounts on
              this server. No match leaves the byline as “{DELETED_USER_LABEL}”; no account is ever
              created by an import.
            </li>
            <li>
              Restoring a large engagement can take several minutes. Keep this tab open until it
              finishes.
            </li>
          </ul>
        </div>
      )}
    </Modal>
  );
}

/** Pending state: what is happening, how long it has been going, and what is at stake. */
function ImportProgress({ file, elapsed }: { file: File | null; elapsed: number }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <Spinner size={26} />
      <p className="text-sm font-medium text-text">
        Restoring {file ? `${file.name} (${formatBytes(file.size)})` : 'the archive'}…
      </p>
      <p className="text-sm tabular-nums text-muted">{fmtElapsed(elapsed)} elapsed</p>
      <p className="max-w-md text-xs text-muted">
        The archive uploads, then every record is written in a single transaction. If anything
        fails, the whole import is rolled back and no engagement is created. Don’t close this tab.
      </p>
    </div>
  );
}

/** The server's result: what was created, what was rewritten, what was dropped. */
function ImportSummary({ result }: { result: EngagementImportResult }) {
  const rows = CREATED_ROWS.filter(({ key }) => result.created[key] > 0);
  const { dropped, remapped, created } = result;
  const droppedAnything =
    dropped.unmatchedAuthorRefs > 0 ||
    dropped.unknownTagRefs > 0 ||
    dropped.danglingEvidenceRefs > 0 ||
    dropped.danglingFindingRefs > 0 ||
    dropped.duplicates > 0;
  const remappedAnything = remapped.recommendationFindingRefs + remapped.narrativeEvidenceRefs > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-card border border-success/30 bg-success/5 p-3">
        <p className="text-sm font-medium text-text">
          Created <span className="font-semibold">{result.engagement.name}</span>
        </p>
        <p className="mt-1 text-sm text-muted">
          Slug <span className="font-mono text-text">{result.engagement.slug}</span> · restored from{' '}
          {result.source.name} (<span className="font-mono">{result.source.slug}</span>), exported{' '}
          {formatDateTime(result.source.exportedAt)}. Nothing that already existed was touched.
        </p>
      </div>

      {rows.length === 0 && created.blobs === 0 ? (
        // An export of an engagement with no content at all is valid — say so
        // rather than showing an empty table.
        <p className="text-sm text-muted">
          The archive held no content, so the engagement was created empty. Its details and report
          configuration were still restored.
        </p>
      ) : (
        <div>
          <p className="mb-2 text-sm font-medium text-text">Created</p>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {rows.map(({ key, label }) => (
              <div key={key} className="flex items-baseline justify-between gap-2">
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="text-sm font-medium tabular-nums text-text">
                  {created[key].toLocaleString()}
                </dd>
              </div>
            ))}
            {created.blobs > 0 && (
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-sm text-muted">Evidence and report files</dt>
                <dd className="text-sm font-medium tabular-nums text-text">
                  {created.blobs.toLocaleString()} · {formatBytes(created.blobBytes)}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {remappedAnything && (
        <p className="text-xs text-muted">
          Rewrote {remapped.recommendationFindingRefs.toLocaleString()} strategic-recommendation
          reference{remapped.recommendationFindingRefs === 1 ? '' : 's'} to Findings and{' '}
          {remapped.narrativeEvidenceRefs.toLocaleString()} execution-narrative reference
          {remapped.narrativeEvidenceRefs === 1 ? '' : 's'} to Evidence, so the report content
          points at the new rows.
        </p>
      )}

      {droppedAnything && (
        <div className="rounded-card border border-warning/30 bg-warning/5 p-3">
          <p className="text-sm font-medium text-text">Not carried over</p>
          <ul className="mt-1 space-y-1 text-sm text-muted">
            {dropped.unmatchedAuthorRefs > 0 && (
              <li>
                {dropped.unmatchedAuthorRefs.toLocaleString()} byline
                {dropped.unmatchedAuthorRefs === 1 ? '' : 's'} left as “{DELETED_USER_LABEL}” — no
                account here matches
                {dropped.unmatchedAuthorEmails.length > 0 && (
                  <>
                    {' '}
                    <span className="font-mono text-xs text-text">
                      {dropped.unmatchedAuthorEmails.join(', ')}
                    </span>
                  </>
                )}
                . Create those accounts and import again if the bylines matter.
              </li>
            )}
            {dropped.unknownTagRefs > 0 && (
              <li>
                {dropped.unknownTagRefs.toLocaleString()} Tag reference
                {dropped.unknownTagRefs === 1 ? '' : 's'} the file never defined.
              </li>
            )}
            {dropped.danglingEvidenceRefs > 0 && (
              <li>
                {dropped.danglingEvidenceRefs.toLocaleString()} reference
                {dropped.danglingEvidenceRefs === 1 ? '' : 's'} to Evidence that isn’t in the file.
              </li>
            )}
            {dropped.danglingFindingRefs > 0 && (
              <li>
                {dropped.danglingFindingRefs.toLocaleString()} reference
                {dropped.danglingFindingRefs === 1 ? '' : 's'} to a Finding that isn’t in the file.
              </li>
            )}
            {dropped.duplicates > 0 && (
              <li>
                {dropped.duplicates.toLocaleString()} duplicate link
                {dropped.duplicates === 1 ? '' : 's'} collapsed — the file listed the same pair
                twice.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Server errors are shown as the server wrote them, with one exception: Fastify's
 * own body-limit refusal says only "Payload Too Large", which tells the operator
 * nothing about what to do next. The import's *own* 413s (one oversized blob, or a
 * declared inflated size that looks like a zip bomb) carry real explanations and are
 * left alone.
 */
function importErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 413 && /payload too large/i.test(err.message)) {
    return 'That archive is larger than this server accepts in one request. Raise MAX_UPLOAD_BYTES on the server, or export a smaller engagement.';
  }
  return err instanceof Error ? err.message : 'Import failed';
}
