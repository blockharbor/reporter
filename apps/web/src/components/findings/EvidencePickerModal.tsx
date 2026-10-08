import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  Spinner,
  TagChip,
  useToast,
} from '@reporter/ui';
import {
  EVIDENCE_TYPE_ICONS,
  EVIDENCE_TYPE_LABELS,
  parseQuery,
  stringifyQuery,
  type Evidence,
  type ParsedQuery,
} from '@reporter/shared';
import { useAttachEvidence, useTags, useTimeline } from '../../api/hooks.js';
import { EvidenceContent } from '../evidence/EvidenceContent.js';
import { TypeFilter } from '../evidence/filters/TypeFilter.js';
import { TagsFilter } from '../evidence/filters/TagsFilter.js';
import { DateFilter } from '../evidence/filters/DateFilter.js';
import { evidenceHeading, evidenceSnippet } from '../../lib/evidence-label.js';
import { formatDateTime } from '../../lib/format.js';
import { evidenceThumbUrl } from '../../lib/urls.js';
import { userDisplayName } from '../../lib/user-display.js';
import { EvidenceExclusionBadge } from '../evidence/ExcludedFromReportBadge.js';
import { GoalCountBadge } from '../evidence/GoalCountBadge.js';

const EMPTY_QUERY = parseQuery('');

/**
 * Pick evidence to attach to a finding, into one bucket (Attack Path or Attached).
 * Left pane is a filterable, multi-selectable timeline list; right pane previews
 * the highlighted item. Already-attached items are hidden.
 */
export function EvidencePickerModal({
  slug,
  findingUuid,
  attachedUuids,
  targetInPath,
  open,
  onClose,
  onPick,
}: {
  slug: string;
  /** Required when attaching to a finding; unused in `onPick` selection mode. */
  findingUuid?: string;
  attachedUuids: string[];
  targetInPath: boolean;
  open: boolean;
  onClose: () => void;
  /**
   * Selection mode. When provided, the modal returns the picked evidence objects
   * to the caller (e.g. to embed as report-narrative references) instead of
   * attaching them to a finding. `findingUuid`/`targetInPath` are ignored.
   */
  onPick?: (picked: Evidence[]) => void;
}) {
  const toast = useToast();
  const attach = useAttachEvidence(slug, findingUuid ?? '');
  const { data: tags = [] } = useTags(slug);

  const [parsed, setParsed] = useState<ParsedQuery>(EMPTY_QUERY);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [highlighted, setHighlighted] = useState<Evidence | null>(null);
  // Remember the full Evidence object for every uuid the user selects, across
  // pages, so `onPick` can return complete objects even after paging away.
  const pickedById = useRef(new Map<string, Evidence>());

  // Reset transient state whenever the modal (re)opens.
  useEffect(() => {
    if (open) {
      setParsed(EMPTY_QUERY);
      setPage(1);
      setSearch('');
      setSelected([]);
      setHighlighted(null);
      pickedById.current = new Map();
    }
  }, [open]);

  const q = useMemo(() => stringifyQuery(parsed), [parsed]);
  const { data, isLoading, isError, refetch } = useTimeline(slug, q, page);

  const attachedSet = useMemo(() => new Set(attachedUuids), [attachedUuids]);
  // Already-attached items are filtered client-side, so a full server page (20)
  // may render fewer than 20 rows here.
  const candidates = useMemo(
    () => (data?.items ?? []).filter((e) => !attachedSet.has(e.uuid)),
    [data, attachedSet],
  );

  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 20;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const applyFilters = (next: ParsedQuery) => {
    setParsed(next);
    setPage(1);
  };

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    applyFilters({ ...parsed, text: parseQuery(search).text });
  };

  const toggle = (ev: Evidence, checked: boolean) => {
    if (checked) pickedById.current.set(ev.uuid, ev);
    setSelected((s) => (checked ? [...s, ev.uuid] : s.filter((x) => x !== ev.uuid)));
  };

  async function submit() {
    if (selected.length === 0) return;
    // Selection mode: hand the picked evidence back to the caller. Objects are
    // pulled from the cross-page map so multi-page selections are preserved.
    if (onPick) {
      const picked = selected
        .map((uuid) => pickedById.current.get(uuid))
        .filter((e): e is Evidence => Boolean(e));
      onPick(picked);
      setSelected([]);
      onClose();
      return;
    }
    try {
      await attach.mutateAsync({ evidenceUuids: selected, inPath: targetInPath });
      toast.success(
        targetInPath
          ? `Added ${selected.length} step${selected.length === 1 ? '' : 's'}`
          : `Attached ${selected.length}`,
      );
      setSelected([]);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Attach failed');
    }
  }

  const title = onPick
    ? 'Add evidence'
    : targetInPath
      ? 'Add attack-path steps'
      : 'Attach evidence';
  const n = selected.length;
  const submitLabel = onPick
    ? n > 0
      ? `Add ${n}`
      : 'Add'
    : targetInPath
      ? n > 0
        ? `Add ${n} step${n === 1 ? '' : 's'}`
        : 'Add steps'
      : n > 0
        ? `Attach ${n}`
        : 'Attach';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={attach.isPending} disabled={selected.length === 0}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Filter row */}
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={submitSearch} className="min-w-40 flex-1">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search descriptions…"
              aria-label="Search evidence descriptions"
            />
          </form>
          <TypeFilter
            value={parsed.types}
            onChange={(types) => applyFilters({ ...parsed, types })}
          />
          <TagsFilter
            value={parsed.tags}
            tags={tags}
            onChange={(names) => applyFilters({ ...parsed, tags: names })}
          />
          <DateFilter
            value={parsed.dateRanges[0]}
            onChange={(range) =>
              applyFilters({
                ...parsed,
                dateRanges: range
                  ? [range, ...parsed.dateRanges.slice(1)]
                  : parsed.dateRanges.slice(1),
              })
            }
          />
        </div>

        {/* Two-pane body */}
        <div className="grid min-h-[22rem] gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="max-h-[26rem] min-w-0 overflow-auto rounded-card border border-border">
            {isLoading ? (
              <div className="flex h-40 items-center justify-center">
                <Spinner size={22} />
              </div>
            ) : isError ? (
              <div className="p-4">
                <ErrorState
                  title="Couldn't load evidence"
                  description="Something went wrong fetching the timeline. Try again."
                  onRetry={() => refetch()}
                />
              </div>
            ) : candidates.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="No evidence matches these filters."
                  description="Adjust the search or filters above to find evidence to attach."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {candidates.map((ev) => (
                  <PickerRow
                    key={ev.uuid}
                    slug={slug}
                    ev={ev}
                    selected={selected.includes(ev.uuid)}
                    active={highlighted?.uuid === ev.uuid}
                    onToggle={(checked) => toggle(ev, checked)}
                    onHighlight={() => setHighlighted(ev)}
                  />
                ))}
              </ul>
            )}
          </div>

          <PreviewPane slug={slug} ev={highlighted} />
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            Evidence ({total}) · page {page} of {pageCount}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= pageCount}
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

/** A rich, selectable timeline row: checkbox + thumb + meta. */
function PickerRow({
  slug,
  ev,
  selected,
  active,
  onToggle,
  onHighlight,
}: {
  slug: string;
  ev: Evidence;
  selected: boolean;
  active: boolean;
  onToggle: (checked: boolean) => void;
  onHighlight: () => void;
}) {
  const extraTags = ev.tags.length - 3;
  return (
    <li
      className={[
        'flex items-start gap-2 p-2 transition-colors',
        active ? 'border-l-2 border-accent bg-surface-2' : 'border-l-2 border-transparent',
      ].join(' ')}
    >
      <div className="pt-1">
        <Checkbox
          label=""
          aria-label={`Select ${evidenceHeading(ev)}`}
          checked={selected}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </div>
      <button
        type="button"
        onClick={onHighlight}
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
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
          {evidenceSnippet(ev) && (
            <p className="truncate text-xs text-muted">{evidenceSnippet(ev)}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone="neutral">{EVIDENCE_TYPE_LABELS[ev.contentType]}</Badge>
            {/* Still selectable: the author may want it on the finding for internal
                work, but they need to know it won't appear in the report. */}
            <EvidenceExclusionBadge evidence={ev} />
            <span>{formatDateTime(ev.occurredAt)}</span>
            <GoalCountBadge evidence={ev} />
            {ev.tags.slice(0, 3).map((t) => (
              <TagChip key={t.id} name={t.name} colorName={t.colorName} />
            ))}
            {extraTags > 0 && <Badge tone="neutral">+{extraTags}</Badge>}
          </div>
        </div>
      </button>
    </li>
  );
}

/** Right-hand preview for the highlighted item. */
function PreviewPane({ slug, ev }: { slug: string; ev: Evidence | null }) {
  if (!ev) {
    return (
      <div className="flex min-h-[22rem] max-h-[26rem] items-center justify-center rounded-card border border-dashed border-border p-4">
        <p className="text-sm text-muted">Select evidence to preview.</p>
      </div>
    );
  }
  return (
    <div className="max-h-[26rem] min-w-0 overflow-auto rounded-card border border-border bg-surface p-3">
      <p className="truncate text-sm font-medium text-text">{evidenceHeading(ev)}</p>
      {evidenceSnippet(ev) && <p className="mt-0.5 text-xs text-muted">{evidenceSnippet(ev)}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone="neutral">{EVIDENCE_TYPE_LABELS[ev.contentType]}</Badge>
        <EvidenceExclusionBadge evidence={ev} />
        <span>{userDisplayName(ev.operator)}</span>
        <span>{formatDateTime(ev.occurredAt)}</span>
        <GoalCountBadge evidence={ev} />
      </div>
      {ev.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {ev.tags.map((t) => (
            <TagChip key={t.id} name={t.name} colorName={t.colorName} />
          ))}
        </div>
      )}
      <div className="mt-3 text-sm">
        <EvidenceContent evidence={ev} slug={slug} />
      </div>
    </div>
  );
}
