import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  SeverityBadge,
  Spinner,
  Textarea,
  useConfirm,
  useToast,
} from '@reporter/ui';
import {
  FINDING_KINDS,
  FINDING_KIND_LABELS,
  type Finding,
  type FindingKind,
} from '@reporter/shared';
import {
  useCreateFinding,
  useDeleteFinding,
  useFindings,
  useImportFindings,
  useReorderFindings,
} from '../api/hooks.js';
import { READ_ONLY_TITLE, useEngagementPermissions } from '../lib/permissions.js';
import { CategorySelect } from '../components/findings/CategorySelect.js';
import { FindingsFilterBar } from '../components/findings/FindingsFilterBar.js';
import {
  DEFAULT_SORT,
  EMPTY_FILTER,
  deriveFindingFacets,
  filterAndSortFindings,
  isFilterActive,
  isManualOrder,
  parseFindingsParams,
  writeFindingsParams,
  type FindingsFilterState,
  type FindingsSort,
} from '../components/findings/findings-filter.js';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard.js';

/**
 * `title` for the drag handle while the list isn't in stored order. The reorder
 * endpoint takes every finding's uuid and reassigns positions by array index, so a
 * filtered or re-sorted list could only ever write the wrong order.
 */
const REORDER_BLOCKED_TITLE = 'Clear filters and sort by Manual order to reorder';

export function FindingsPage() {
  const { slug = '' } = useParams();
  const toast = useToast();
  const { canWrite } = useEngagementPermissions(slug);
  const { data: findings, isLoading, isError, refetch } = useFindings(slug);
  const reorder = useReorderFindings(slug);
  const importFindings = useImportFindings(slug);
  const fileInput = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();

  // Filters and sort live in the URL, so a narrowed view is deep-linkable and
  // survives a reload. Everything is applied over the already-fetched array —
  // the list route has no query params and nothing refetches.
  const { filter, sort } = useMemo(() => parseFindingsParams(params), [params]);
  const facets = useMemo(() => deriveFindingFacets(findings ?? []), [findings]);
  const visible = useMemo(
    () => filterAndSortFindings(findings ?? [], filter, sort),
    [findings, filter, sort],
  );

  // Filter/sort changes replace the history entry rather than pushing one: they're
  // view state, not navigation, and search-as-you-type would otherwise bury Back
  // under an entry per keystroke.
  const applyState = (nextFilter: FindingsFilterState, nextSort: FindingsSort) =>
    setParams(writeFindingsParams(params, nextFilter, nextSort), { replace: true });

  const total = findings?.length ?? 0;
  const filtersActive = isFilterActive(filter);
  const canReorder = canWrite && !filtersActive && isManualOrder(sort);
  const dragTitle = !canWrite ? READ_ONLY_TITLE : canReorder ? undefined : REORDER_BLOCKED_TITLE;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id || !findings || !canReorder) return;
    // Always the full list in stored order — a partial order is rejected (400).
    const ids = findings.map((f) => f.uuid);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    reorder.mutate(arrayMove(ids, from, to));
  }

  async function onImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast.error('That file is not valid JSON');
      return;
    }
    try {
      const r = await importFindings.mutateAsync(data);
      const findingsMsg = [`${r.findingsCreated} created`, `${r.findingsUpdated} updated`]
        .concat(r.findingsSkipped ? [`${r.findingsSkipped} skipped`] : [])
        .join(', ');
      const evidence = r.evidenceCreated + r.evidenceLinked;
      const evidenceMsg =
        evidence || r.evidenceSkipped
          ? ` · ${evidence} evidence${r.evidenceSkipped ? `, ${r.evidenceSkipped} skipped` : ''}`
          : '';
      toast.success(`Imported ${findingsMsg}${evidenceMsg}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text">Findings</h2>
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={onImportFile}
          />
          <Button
            variant="ghost"
            onClick={() => fileInput.current?.click()}
            loading={importFindings.isPending}
            disabled={!canWrite}
            title={canWrite ? undefined : READ_ONLY_TITLE}
          >
            Import
          </Button>
          <Button
            onClick={() => setCreating(true)}
            disabled={!canWrite}
            title={canWrite ? undefined : READ_ONLY_TITLE}
          >
            New finding
          </Button>
        </div>
      </div>

      {total > 0 && (
        <div className="mb-4">
          <FindingsFilterBar
            slug={slug}
            filter={filter}
            sort={sort}
            facets={facets}
            onFilterChange={(next) => applyState(next, sort)}
            onSortChange={(next) => applyState(filter, next)}
            onClearAll={() => applyState(EMPTY_FILTER, DEFAULT_SORT)}
            shown={visible.length}
            total={total}
            reorderHint={canWrite && !canReorder ? REORDER_BLOCKED_TITLE : undefined}
          />
        </div>
      )}

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorState description="Couldn’t load findings." onRetry={() => refetch()} />
      ) : total === 0 ? (
        <EmptyState
          title="No findings yet"
          description="Group related evidence into a finding to build your report."
          action={
            <Button
              onClick={() => setCreating(true)}
              disabled={!canWrite}
              title={canWrite ? undefined : READ_ONLY_TITLE}
            >
              New finding
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        // Distinct from "No findings yet" above: there are findings, the filter just
        // excluded all of them. The action clears the filters and keeps the sort,
        // which hid nothing.
        <EmptyState
          title="No findings match these filters"
          description="Try a broader filter, or clear them to see every finding in this engagement."
          action={
            <Button variant="secondary" onClick={() => applyState(EMPTY_FILTER, sort)}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={visible.map((f) => f.uuid)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col gap-2">
              {visible.map((f) => (
                <SortableFindingRow
                  key={f.uuid}
                  slug={slug}
                  finding={f}
                  canWrite={canWrite}
                  canReorder={canReorder}
                  dragTitle={dragTitle}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <CreateFindingModal slug={slug} open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function SortableFindingRow({
  slug,
  finding: f,
  canWrite,
  canReorder,
  dragTitle,
}: {
  slug: string;
  finding: Finding;
  canWrite: boolean;
  /** Dragging is only offered on the unfiltered list in stored order. */
  canReorder: boolean;
  /** Why the handle is disabled, if it is (read-only role, or an active filter/sort). */
  dragTitle: string | undefined;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const del = useDeleteFinding(slug);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: f.uuid,
    disabled: !canReorder,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  async function remove() {
    const ok = await confirm({
      title: 'Delete finding',
      message: `Delete “${f.title}”? Attached evidence is kept; this can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(f.uuid);
      toast.success('Finding deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-card border border-border bg-surface p-3 hover:border-accent/50"
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        disabled={!canReorder}
        title={dragTitle}
        aria-label={dragTitle ? `Drag to reorder — unavailable: ${dragTitle}` : 'Drag to reorder'}
        className="cursor-grab touch-none px-1 text-muted hover:text-text active:cursor-grabbing disabled:opacity-50"
      >
        ⠿
      </button>
      <Link
        to={`/engagements/${slug}/findings/${f.uuid}`}
        className="flex min-w-0 flex-1 items-center justify-between gap-3"
      >
        <div className="min-w-0">
          <p className="truncate font-medium text-text">{f.title}</p>
          <p className="text-xs text-muted">
            {f.category ?? 'Uncategorized'} · Evidence ({f.numEvidence})
            {f.numGoals > 0 && ` · Goals (${f.numGoals})`}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {f.kind === 'strength' ? (
            <Badge tone="success">{FINDING_KIND_LABELS.strength}</Badge>
          ) : (
            <SeverityBadge severity={f.severity} score={f.cvssScore} />
          )}
          {f.readyToReport && <Badge tone="success">Ready to report</Badge>}
        </div>
      </Link>
      <button
        type="button"
        onClick={remove}
        disabled={!canWrite}
        title={canWrite ? undefined : READ_ONLY_TITLE}
        aria-label="Delete finding"
        className="px-1 text-muted hover:text-danger disabled:opacity-50"
      >
        ✕
      </button>
    </li>
  );
}

function CreateFindingModal({
  slug,
  open,
  onClose,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useCreateFinding(slug);
  const [kind, setKind] = useState<FindingKind>('weakness');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');

  // Clear the form whenever the modal closes so a discarded draft doesn't carry
  // into the next open (and re-trigger the discard-confirm on a fresh session).
  useEffect(() => {
    if (!open) {
      setKind('weakness');
      setTitle('');
      setDescription('');
      setCategory('');
    }
  }, [open]);

  // Dirty when anything's been entered beyond the default kind. Drives the
  // discard-confirm on close/cancel/Esc/backdrop.
  const isDirty = useMemo(
    () =>
      title.trim().length > 0 ||
      description.trim().length > 0 ||
      category.length > 0 ||
      kind !== 'weakness',
    [title, description, category, kind],
  );

  const { requestClose } = useUnsavedGuard({
    isDirty,
    enabled: open,
    onClose,
    onSave: submit,
    canSave: Boolean(title),
  });

  async function submit() {
    try {
      await create.mutateAsync({
        kind,
        title,
        description,
        category: category || null,
        // The schema defaults these server-side; the generated input type (the
        // schema's *output*) lists them as required, so send explicit defaults.
        affectedTarget: '',
        impact: '',
        fixEffort: 'none',
        iso21434Refs: [],
        unr155Refs: [],
      });
      toast.success('Finding created');
      setKind('weakness');
      setTitle('');
      setDescription('');
      setCategory('');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create finding');
    }
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title="New finding"
      footer={
        <>
          <Button variant="ghost" onClick={requestClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={create.isPending} disabled={!title}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Kind"
          htmlFor="f-kind"
          hint="Weaknesses carry severity and remediation; strengths note good practices."
        >
          <div id="f-kind" role="radiogroup" aria-label="Finding kind" className="flex gap-2">
            {FINDING_KINDS.map((k) => (
              <Button
                key={k}
                type="button"
                size="sm"
                variant={kind === k ? 'primary' : 'secondary'}
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
              >
                {FINDING_KIND_LABELS[k]}
              </Button>
            ))}
          </div>
        </Field>
        <Field label="Title" htmlFor="f-title">
          <Input id="f-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="Category" htmlFor="f-cat" hint="Optional">
          <CategorySelect id="f-cat" slug={slug} value={category} onChange={setCategory} />
        </Field>
        <Field label="Description" htmlFor="f-desc">
          <Textarea
            id="f-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
        </Field>
      </div>
    </Modal>
  );
}
