import { useState } from 'react';
import { Button, Field, Modal, Select, TagChip, useToast } from '@reporter/ui';
import type { Tag } from '@reporter/shared';
import { useMergeTags, useTagReferences } from '../../api/hooks.js';
import { activityTagHint, mergeTagMessage, mergeTagToast, tagUsageSentence } from './tag-copy.js';

/**
 * The merge confirmation: fold `source` into a tag the user picks, then delete
 * `source`. A `Modal` rather than `useConfirm`, because the user has to choose the
 * survivor and `useConfirm` takes a message but no input.
 *
 * Irreversible, so everything the merge touches is stated BEFORE the danger
 * button enables: the combined counts, the places that address the source by
 * name (saved queries, which are not rewritten; report timeline sections, which
 * are), and the Goals activity whose correlation moves. No typed-name
 * confirmation — the blast radius is one tag and a relabel, closer to the
 * existing tag delete than to engagement deletion.
 *
 * Mount this only while a merge is in progress (`{source && <TagMergeModal …/>}`)
 * so the chosen target resets with the dialog instead of leaking into the next
 * one.
 */
export function TagMergeModal({
  slug,
  source,
  tags,
  open,
  onClose,
}: {
  slug: string;
  /** The tag being merged away. */
  source: Tag;
  /** Every tag in the engagement; the picker offers all but `source`. */
  tags: Tag[];
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const merge = useMergeTags(slug);
  // Fetched only while the dialog is open: the hook gates on a non-null id and
  // this component is mounted per merge.
  const refs = useTagReferences(slug, source.id);

  const [targetId, setTargetId] = useState<number | null>(null);
  const others = tags.filter((t) => t.id !== source.id);
  const target = others.find((t) => t.id === targetId) ?? null;

  const hint = activityTagHint(source.activityNames ?? []);
  const savedQueries = refs.data?.savedQueries ?? [];
  const timelineSections = refs.data?.timelineSections ?? [];

  async function submit() {
    if (!target || merge.isPending) return;
    try {
      const r = await merge.mutateAsync({ id: source.id, intoTagId: target.id });
      toast.success(mergeTagToast(source.name, r.tag.name, r));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not merge tags');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Merge tag"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={submit}
            disabled={!target}
            loading={merge.isPending}
            title={target ? undefined : 'Choose the tag to merge into first'}
          >
            Merge and delete “{source.name}”
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-text">
        <div className="flex flex-wrap items-center gap-2">
          <TagChip name={source.name} colorName={source.colorName} />
          <span className="text-muted">{tagUsageSentence(source)}</span>
        </div>

        <Field label="Merge into" htmlFor="tag-merge-target">
          <Select
            id="tag-merge-target"
            value={targetId ?? ''}
            onChange={(e) => setTargetId(e.target.value ? Number(e.target.value) : null)}
            disabled={others.length === 0}
          >
            <option value="">Choose a tag…</option>
            {others.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} — {tagUsageSentence(t)}
              </option>
            ))}
          </Select>
        </Field>

        <p>
          {target
            ? mergeTagMessage(source, target)
            : `Pick the tag that survives. Everything tagged “${source.name}” will carry that tag instead.`}
        </p>

        {(savedQueries.length > 0 || timelineSections.length > 0) && (
          <div className="space-y-1 rounded-input border border-warning/40 bg-surface-2 p-3 text-xs">
            <p className="font-medium">“{source.name}” is also referred to by name:</p>
            {savedQueries.length > 0 && (
              <p>
                The <code>tag:</code> term in the saved{' '}
                {savedQueries.length === 1 ? 'query' : 'queries'}{' '}
                {savedQueries.map((q) => `“${q.name}”`).join(', ')} will match nothing after the
                merge — saved queries are not rewritten.
              </p>
            )}
            {timelineSections.length > 0 && (
              <p>
                The report timeline {timelineSections.length === 1 ? 'section' : 'sections'}{' '}
                {timelineSections.map((s) => `“${s.title}”`).join(', ')}{' '}
                {timelineSections.length === 1 ? 'is' : 'are'} updated to use the surviving tag
                automatically.
              </p>
            )}
          </div>
        )}

        {hint && (
          <p className="text-xs text-muted">
            {hint}{' '}
            {(source.activityNames?.length ?? 0) === 1
              ? 'The activity’s correlation moves to the surviving tag.'
              : 'Their correlations move to the surviving tag.'}
          </p>
        )}

        <p>“{source.name}” is deleted. This cannot be undone.</p>
      </div>
    </Modal>
  );
}
