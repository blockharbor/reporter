import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Spinner,
  TagChip,
  useConfirm,
  useTheme,
  useToast,
} from '@reporter/ui';
import {
  TAG_COLORS,
  defaultTagColorFor,
  type Tag,
  type TagColorName,
  type TagReferences,
  type UpdateTagInput,
} from '@reporter/shared';
import { api } from '../../api/client.js';
import {
  useCreateTag,
  useDeleteTag,
  useReorderTags,
  useTagReferences,
  useTags,
  useUnapplyTag,
  useUpdateTag,
} from '../../api/hooks.js';
import { READ_ONLY_TITLE } from '../../lib/permissions.js';
import { SortableList, SortableRow } from '../common/Sortable.js';
import { TagMergeModal } from './TagMergeModal.js';
import {
  activityTagHint,
  deleteTagMessage,
  deleteTagReferencesNote,
  tagUsageSentence,
  tagUsageShort,
  unapplyTagMessage,
  unapplyTagToast,
} from './tag-copy.js';

/**
 * Tag list + "new tag" form for one engagement. Presentational block meant to
 * live inside a Settings Card. Tags are scoped to the engagement.
 *
 * The list is the engagement's curated tag ORDER, not an alphabetical index:
 * the array the server returns is the order every picker and every chip row
 * follows, so dragging a row (or pinning it to the top) is a real edit. Each row
 * carries the four management actions — rename/recolor inline, merge into
 * another tag, strip it from everything, delete it — and the two irreversible
 * ones state their blast radius first (`tag-copy.ts`).
 */
export function TagManager({ slug, readOnly = false }: { slug: string; readOnly?: boolean }) {
  const { data: tags, isLoading, isError, refetch } = useTags(slug);
  const create = useCreateTag(slug);
  const del = useDeleteTag(slug);
  const reorder = useReorderTags(slug);
  const unapply = useUnapplyTag(slug);
  const toast = useToast();
  const confirm = useConfirm();

  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColorName>('teal');
  // One row editor open at a time: two open editors could both rename onto the
  // same name, and the second save would then hit the 409 the first caused.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [mergeSource, setMergeSource] = useState<Tag | null>(null);

  const readOnlyTitle = readOnly ? READ_ONLY_TITLE : undefined;

  // When the inline editor closes its form unmounts and the row's buttons are
  // re-created, so without help keyboard focus falls to <body> and the next Tab
  // starts from the top of the page. Remember which row to return to, and move
  // focus to its Edit button once that button exists again.
  const editButtons = useRef(new Map<number, HTMLButtonElement>());
  const [returnFocusTo, setReturnFocusTo] = useState<number | null>(null);
  useEffect(() => {
    if (returnFocusTo === null) return;
    editButtons.current.get(returnFocusTo)?.focus();
    setReturnFocusTo(null);
  }, [returnFocusTo]);
  function closeEditor(tagId: number) {
    setEditingId(null);
    setReturnFocusTo(tagId);
  }

  async function removeTag(tag: Tag) {
    // Rename and merge warn about the places that address a tag by name; delete
    // must too, or the one irreversible action gets the least warning. Best
    // effort: if the lookup fails the plain confirmation still shows, because a
    // broken hint must not make a tag undeletable.
    let note: string | null = null;
    try {
      const refs = await api.get<TagReferences>(
        `/web/engagements/${slug}/tags/${tag.id}/references`,
      );
      note = deleteTagReferencesNote(refs);
    } catch {
      // fall through to the plain message
    }
    const ok = await confirm({
      title: 'Delete tag',
      message: note ? `${deleteTagMessage(tag)} ${note}` : deleteTagMessage(tag),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(tag.id);
      toast.success(`Deleted “${tag.name}”`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete tag');
    }
  }

  async function unapplyTag(tag: Tag) {
    const ok = await confirm({
      title: 'Remove tag from everything',
      message: unapplyTagMessage(tag),
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await unapply.mutateAsync(tag.id);
      toast.success(unapplyTagToast(tag.name, result));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove tag');
    }
  }

  /** Persist a new full order. The server insists on the complete id list. */
  function persistOrder(orderedIds: number[]) {
    reorder.mutate(orderedIds, {
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not reorder tags'),
    });
  }

  /** "Pin to top" is a move-to-index-0 through the same reorder endpoint. */
  function pinToTop(tag: Tag) {
    if (!tags) return;
    persistOrder([tag.id, ...tags.filter((t) => t.id !== tag.id).map((t) => t.id)]);
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name) return;
    try {
      await create.mutateAsync({ name, colorName: color });
      setName('');
      setColor(defaultTagColorFor(name));
      toast.success('Tag created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create tag');
    }
  }

  return (
    <div className="space-y-4">
      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorState description="Couldn’t load tags." onRetry={() => refetch()} />
      ) : !tags || tags.length === 0 ? (
        <EmptyState
          title="No tags yet"
          description="Create tags to organize and filter evidence and findings."
        />
      ) : (
        <SortableList ids={tags.map((t) => t.id)} onReorder={persistOrder}>
          {/* `div`s with list roles rather than `ul`/`li`: SortableRow wraps each
              row in its own `div` (the dnd-kit node), and `ul > div > li` is not
              valid nesting. Same shape as the Goals page's sortable lists. */}
          <div role="list" className="space-y-1.5">
            {tags.map((t, index) => (
              <SortableRow key={t.id} id={t.id} disabled={readOnly}>
                {(handle) => (
                  <div
                    role="listitem"
                    className="rounded-input border border-border bg-surface px-2 py-1.5"
                  >
                    {editingId === t.id ? (
                      <TagRowEditor slug={slug} tag={t} onDone={() => closeEditor(t.id)} />
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        {handle}
                        <TagChip name={t.name} colorName={t.colorName} />
                        <span
                          className="min-w-0 flex-1 truncate text-xs text-muted"
                          title={tagUsageSentence(t)}
                        >
                          {tagUsageShort(t)}
                        </span>
                        <div className="flex flex-wrap items-center gap-1">
                          {index > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => pinToTop(t)}
                              disabled={readOnly || reorder.isPending}
                              title={readOnlyTitle}
                              aria-label={`Pin ${t.name} to top`}
                            >
                              Pin to top
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            ref={(el) => {
                              if (el) editButtons.current.set(t.id, el);
                              else editButtons.current.delete(t.id);
                            }}
                            onClick={() => setEditingId(t.id)}
                            disabled={readOnly}
                            title={readOnlyTitle}
                            aria-label={`Edit tag ${t.name}`}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setMergeSource(t)}
                            disabled={readOnly || tags.length < 2}
                            title={
                              readOnlyTitle ??
                              (tags.length < 2 ? 'There is no other tag to merge into' : undefined)
                            }
                            aria-label={`Merge tag ${t.name}`}
                          >
                            Merge…
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => unapplyTag(t)}
                            disabled={readOnly}
                            title={readOnlyTitle}
                            aria-label={`Remove tag ${t.name} from everything`}
                          >
                            Unapply
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-danger"
                            onClick={() => removeTag(t)}
                            disabled={readOnly}
                            title={readOnlyTitle}
                            aria-label={`Delete tag ${t.name}`}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </SortableRow>
            ))}
          </div>
        </SortableList>
      )}

      {mergeSource && tags && (
        <TagMergeModal
          slug={slug}
          source={mergeSource}
          tags={tags}
          open
          onClose={() => setMergeSource(null)}
        />
      )}

      <form onSubmit={add} className="space-y-3 border-t border-border pt-4">
        <p className="text-sm font-medium text-text">New tag</p>
        <Field label="Name" htmlFor="tag-name">
          <Input
            id="tag-name"
            value={name}
            maxLength={64}
            disabled={readOnly}
            title={readOnlyTitle}
            onChange={(e) => {
              setName(e.target.value);
              setColor(defaultTagColorFor(e.target.value));
            }}
          />
        </Field>
        <Field label="Color">
          <ColorSwatches
            label="Color for the new tag"
            value={color}
            onChange={setColor}
            disabled={readOnly}
            disabledTitle={readOnlyTitle}
          />
        </Field>
        <Button
          type="submit"
          loading={create.isPending}
          disabled={readOnly || !name}
          title={readOnlyTitle}
        >
          Add tag
        </Button>
      </form>
    </div>
  );
}

/**
 * The twelve-swatch palette picker, shared by the new-tag form and the row
 * editor — that reuse is what makes recolor cheap. Reads each swatch's light or
 * dark value through the theme so the picker shows the colour the chip will
 * actually render in. `value` is a loose string because a legacy row may hold an
 * off-palette name; then simply no swatch is selected.
 */
function ColorSwatches({
  label,
  value,
  onChange,
  disabled,
  disabledTitle,
}: {
  /** Accessible name for the group, so two pickers on one page stay distinguishable. */
  label: string;
  value: string;
  onChange: (color: TagColorName) => void;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  const { resolved } = useTheme();
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {TAG_COLORS.map((c) => (
        <button
          key={c.name}
          type="button"
          aria-label={c.name}
          aria-pressed={value === c.name}
          disabled={disabled}
          title={disabled ? disabledTitle : c.name}
          onClick={() => onChange(c.name)}
          className={`h-6 w-6 rounded-full disabled:opacity-50 ${value === c.name ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface' : ''}`}
          style={{ backgroundColor: resolved === 'dark' ? c.dark : c.light }}
        />
      ))}
    </div>
  );
}

/**
 * Inline rename/recolor for one row. Sends ONLY the fields that changed, so a
 * recolor never re-sends the name (and so cannot trip the rename 409), and a
 * rename never resets the colour. The by-name references are fetched while the
 * editor is open: a rename follows the tag row everywhere it is addressed by id,
 * but saved queries and the report's timeline config address it by NAME.
 */
function TagRowEditor({ slug, tag, onDone }: { slug: string; tag: Tag; onDone: () => void }) {
  const update = useUpdateTag(slug);
  const refs = useTagReferences(slug, tag.id);
  const toast = useToast();

  const [name, setName] = useState(tag.name);
  // `null` means "unchanged" — the swatch shows the stored colour, which may be
  // off-palette on a legacy row and so cannot be typed as `TagColorName`.
  const [color, setColor] = useState<TagColorName | null>(null);

  const trimmed = name.trim();
  const patch: UpdateTagInput = {};
  if (trimmed && trimmed !== tag.name) patch.name = trimmed;
  if (color !== null && color !== tag.colorName) patch.colorName = color;
  const dirty = patch.name !== undefined || patch.colorName !== undefined;

  const hint = activityTagHint(tag.activityNames ?? []);
  const savedQueries = refs.data?.savedQueries ?? [];
  const timelineSections = refs.data?.timelineSections ?? [];

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    if (!dirty) {
      onDone();
      return;
    }
    try {
      await update.mutateAsync({ id: tag.id, patch });
      toast.success(patch.name ? `Renamed “${tag.name}” to “${patch.name}”` : 'Tag updated');
      onDone();
    } catch (err) {
      // The rename collision (409) arrives as the server's own message — "A tag
      // with that name already exists" — which is the right thing to show.
      toast.error(err instanceof Error ? err.message : 'Could not update tag');
    }
  }

  const inputId = `tag-${tag.id}-name`;
  return (
    <form
      onSubmit={save}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone();
      }}
      className="space-y-3 py-1"
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Name" htmlFor={inputId} className="min-w-48 flex-1">
          <Input
            id={inputId}
            value={name}
            maxLength={64}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Color">
          <ColorSwatches
            label={`Color for “${tag.name}”`}
            value={color ?? tag.colorName}
            onChange={setColor}
          />
        </Field>
      </div>

      {hint && <p className="text-xs text-muted">{hint}</p>}

      {(savedQueries.length > 0 || timelineSections.length > 0) && (
        <div className="space-y-1 rounded-input border border-warning/40 bg-surface-2 p-3 text-xs text-text">
          <p className="font-medium">“{tag.name}” is also referred to by name:</p>
          {savedQueries.length > 0 && (
            <p>
              The <code>tag:</code> term in the saved{' '}
              {savedQueries.length === 1 ? 'query' : 'queries'}{' '}
              {savedQueries.map((q) => `“${q.name}”`).join(', ')} will need editing after a rename —
              saved queries are not rewritten.
            </p>
          )}
          {timelineSections.length > 0 && (
            <p>
              The report timeline {timelineSections.length === 1 ? 'section' : 'sections'}{' '}
              {timelineSections.map((s) => `“${s.title}”`).join(', ')}{' '}
              {timelineSections.length === 1 ? 'is' : 'are'} updated to the new name automatically.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" loading={update.isPending} disabled={!trimmed}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
