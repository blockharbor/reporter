import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, EmptyState, ErrorState, Input, Modal, Spinner } from '@reporter/ui';
import { EVIDENCE_TYPE_ICONS, EVIDENCE_TYPE_LABELS, type Evidence } from '@reporter/shared';
import { useTimeline } from '../../api/hooks.js';
import { evidenceHeading, evidenceSnippet } from '../../lib/evidence-label.js';
import { formatDateTime } from '../../lib/format.js';
import { evidenceThumbUrl } from '../../lib/urls.js';

/**
 * Pick a single top-level piece of evidence to (re)parent the current evidence
 * onto — i.e. make the current item a comment on the chosen target, or move it
 * to a new parent. Comments are one level deep, so the candidate list excludes
 * the current evidence and any item that is itself a comment
 * (`parentEvidenceUuid !== null`).
 *
 * Filtering is client-side over a single timeline page: the list is a picker,
 * not a full browse surface, and `useTimeline` already returns the newest items
 * first. A search box narrows by heading so a specific target is reachable.
 */
export function ReparentEvidenceModal({
  slug,
  open,
  currentUuid,
  title,
  confirmLabel,
  onPick,
  onClose,
  busy = false,
}: {
  slug: string;
  open: boolean;
  /** The evidence being reparented — excluded from the candidate list. */
  currentUuid: string;
  title: string;
  confirmLabel: string;
  /** Called with the chosen target's uuid when the user confirms. */
  onPick: (targetUuid: string) => void;
  onClose: () => void;
  /** The reparent mutation is in flight — disables input and shows the button spinner. */
  busy?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  // Reset transient state whenever the modal (re)opens.
  useEffect(() => {
    if (open) {
      setPage(1);
      setSearch('');
      setSelected(null);
    }
  }, [open]);

  const { data, isLoading, isError, refetch } = useTimeline(slug, '', page);

  // Top-level evidence only, never the current item. Comments can't host comments.
  const topLevel = useMemo(
    () =>
      (data?.items ?? []).filter((e) => e.parentEvidenceUuid === null && e.uuid !== currentUuid),
    [data, currentUuid],
  );

  const term = search.trim().toLowerCase();
  const candidates = useMemo(
    () =>
      term ? topLevel.filter((e) => evidenceHeading(e).toLowerCase().includes(term)) : topLevel,
    [topLevel, term],
  );

  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 20;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  function confirm() {
    if (selected) onPick(selected);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={confirm} loading={busy} disabled={!selected || busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search evidence by title…"
          aria-label="Search evidence"
          disabled={busy}
        />

        <div className="max-h-[26rem] min-h-[18rem] overflow-auto rounded-card border border-border">
          {isLoading ? (
            <div className="flex h-40 items-center justify-center">
              <Spinner size={22} />
            </div>
          ) : isError ? (
            <div className="p-4">
              <ErrorState
                title="Couldn’t load evidence"
                description="Something went wrong fetching the timeline. Try again."
                onRetry={() => refetch()}
              />
            </div>
          ) : candidates.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={term ? 'No evidence matches that search.' : 'No other evidence to link to.'}
                description={
                  term
                    ? 'Clear the search or try a different title.'
                    : 'Create another top-level piece of evidence to make this a comment on it.'
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {candidates.map((ev) => (
                <PickerRow
                  key={ev.uuid}
                  slug={slug}
                  ev={ev}
                  selected={selected === ev.uuid}
                  disabled={busy}
                  onSelect={() => setSelected(ev.uuid)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Pagination — the candidate list is one server page at a time. */}
        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            Evidence ({total}) · page {page} of {pageCount}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1 || busy}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= pageCount || busy}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** A single-select candidate row: type thumb/icon + heading + meta. */
function PickerRow({
  slug,
  ev,
  selected,
  disabled,
  onSelect,
}: {
  slug: string;
  ev: Evidence;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const snippet = evidenceSnippet(ev);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-pressed={selected}
        className={[
          'flex w-full items-start gap-2 p-2 text-left transition-colors',
          selected
            ? 'border-l-2 border-accent bg-surface-2'
            : 'border-l-2 border-transparent hover:bg-surface-2',
          disabled ? 'cursor-not-allowed opacity-60' : '',
        ].join(' ')}
      >
        <div className="h-9 w-9 flex-none overflow-hidden rounded-input border border-border bg-surface-2">
          {ev.hasThumbnail ? (
            <img
              src={evidenceThumbUrl(slug, ev.uuid)}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-muted">
              {EVIDENCE_TYPE_ICONS[ev.contentType]}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text">{evidenceHeading(ev)}</p>
          {snippet && <p className="truncate text-xs text-muted">{snippet}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone="neutral">{EVIDENCE_TYPE_LABELS[ev.contentType]}</Badge>
            <span>{formatDateTime(ev.occurredAt)}</span>
          </div>
        </div>
      </button>
    </li>
  );
}
