import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Checkbox,
  ErrorState,
  Field,
  Input,
  MarkdownField,
  MarkdownPreview,
  Spinner,
  TagChip,
  TagPicker,
  useConfirm,
  useToast,
} from '@reporter/ui';
import { defaultTagColorFor } from '@reporter/shared';
import {
  useCreateTag,
  useDeleteEvidence,
  useEvidence,
  useLinkedEvidence,
  useTags,
  useUpdateEvidence,
} from '../api/hooks.js';
import { READ_ONLY_TITLE, useEngagementPermissions } from '../lib/permissions.js';
import type { SaveStatus } from '../hooks/useAutosave.js';
import { SaveStatusIndicator } from '../components/SaveStatusIndicator.js';
import { EvidenceBody } from '../components/evidence/EvidenceBody.js';
import { EvidenceMeta } from '../components/evidence/EvidenceMeta.js';
import { EvidenceEntryRow } from '../components/evidence/EvidenceEntryRow.js';
import { EvidenceCommentsCard } from '../components/evidence/EvidenceCommentsCard.js';
import { CreateEvidenceModal } from '../components/evidence/CreateEvidenceModal.js';
import { ReparentEvidenceModal } from '../components/evidence/ReparentEvidenceModal.js';
import {
  DeleteEvidenceDialog,
  type DeleteEvidenceMode,
} from '../components/evidence/DeleteEvidenceDialog.js';
import {
  EXCLUDED_FROM_REPORT_HINT,
  EXCLUDED_FROM_REPORT_INHERITED_HINT,
  ExcludedFromReportBadge,
} from '../components/evidence/ExcludedFromReportBadge.js';
import { LinkedGoalsSection } from '../components/goals/LinkedGoalsSection.js';

interface EvidenceForm {
  title: string;
  description: string;
  tagIds: number[];
}

export function EvidenceDetailPage() {
  const { slug = '', uuid = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data: evidence, isLoading, isError, refetch } = useEvidence(slug, uuid);
  const { canWrite } = useEngagementPermissions(slug);
  const { data: tags } = useTags(slug);
  const linkedEvidence = useLinkedEvidence(slug, uuid);
  // The parent this item is linked to (only fetched when it's linked evidence),
  // so the banner can name it.
  const { data: parentEvidence } = useEvidence(slug, evidence?.parentEvidenceUuid ?? '');
  const update = useUpdateEvidence(slug);
  const del = useDeleteEvidence(slug);
  const createTag = useCreateTag(slug);

  // Inline "+ New tag" in the picker: create a tag with a name-derived color and
  // return its id so the picker can select it. Writers only; read-only omits it.
  const onCreateTag = canWrite
    ? async (tagName: string) => {
        try {
          const t = await createTag.mutateAsync({
            name: tagName,
            colorName: defaultTagColorFor(tagName),
          });
          return t.id;
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not create tag');
          throw err;
        }
      }
    : undefined;

  // Deliberate Details edit: an explicit Edit button seeds a draft; only Save
  // persists it (Cancel discards). Mirrors the Content section's Edit → Save flow.
  const [editingDetails, setEditingDetails] = useState(false);
  const [draft, setDraft] = useState<EvidenceForm>({ title: '', description: '', tagIds: [] });
  const [savingDetails, setSavingDetails] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // `attach` opens the picker to make this top-level item a comment on another;
  // `move` opens it to move this comment under a different parent. Only one at a time.
  const [reparenting, setReparenting] = useState<null | 'attach' | 'move'>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  // Report exclusion saves the moment it's clicked, deliberately outside the
  // Details Edit → Save draft: a decision about what the client does and doesn't
  // see must never be discarded by Cancel. `pendingExclude` holds the optimistic
  // value so the box flips at once; it survives a success (it already matches
  // what the server stored — clearing it would flash the old state until the
  // refetch lands) and is dropped on failure to revert the box.
  const [pendingExclude, setPendingExclude] = useState<boolean | null>(null);
  const [excludeStatus, setExcludeStatus] = useState<SaveStatus>('idle');

  function startEditDetails() {
    if (!evidence) return;
    setDraft({
      title: evidence.title,
      description: evidence.description,
      tagIds: evidence.tags.map((t) => t.id),
    });
    setEditingDetails(true);
  }

  async function saveDetails() {
    if (!draft.title.trim()) {
      toast.error('A title is required.');
      return;
    }
    setSavingDetails(true);
    try {
      await update.mutateAsync({
        uuid,
        patch: { title: draft.title.trim(), description: draft.description, tagIds: draft.tagIds },
      });
      toast.success('Details saved');
      setEditingDetails(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save details');
    } finally {
      setSavingDetails(false);
    }
  }

  async function saveExcludeFromReport(next: boolean) {
    setPendingExclude(next);
    setExcludeStatus('saving');
    try {
      await update.mutateAsync({ uuid, patch: { excludeFromReport: next } });
      setExcludeStatus('saved');
    } catch (err) {
      setPendingExclude(null);
      setExcludeStatus('error');
      toast.error(err instanceof Error ? err.message : 'Could not change report exclusion');
    }
  }

  if (isLoading) return <Spinner size={26} />;
  if (isError)
    return <ErrorState description="Couldn’t load this evidence." onRetry={() => refetch()} />;
  if (!evidence) return <p className="text-danger">Evidence not found.</p>;

  // A comment is one level deep, so only top-level evidence hosts linked evidence.
  const isComment = evidence.parentEvidenceUuid !== null;
  const linkedList = linkedEvidence.data ?? [];
  const excludeFromReport = pendingExclude ?? evidence.excludeFromReport;

  // Attach (parent uuid) / move (new parent uuid) / detach (null) all funnel
  // through one PUT of `parentEvidenceUuid`.
  async function reparent(target: string | null) {
    const oldParent = evidence?.parentEvidenceUuid ?? null;
    setLinkBusy(true);
    try {
      await update.mutateAsync({ uuid, patch: { parentEvidenceUuid: target } });
      for (const p of [oldParent, target]) {
        if (p) {
          qc.invalidateQueries({ queryKey: ['linked-evidence', slug, p] });
          qc.invalidateQueries({ queryKey: ['evidence', slug, p] });
        }
      }
      qc.invalidateQueries({ queryKey: ['linked-evidence', slug, uuid] });
      setReparenting(null);
      toast.success(
        target === null
          ? 'Detached — now standalone evidence'
          : oldParent
            ? 'Moved to another evidence'
            : 'Now linked to the selected evidence',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update linking');
    } finally {
      setLinkBusy(false);
    }
  }

  async function detach() {
    const ok = await confirm({
      title: 'Detach this evidence?',
      message:
        'This will become a standalone, top-level piece of evidence. Its own linked evidence (if any) stays attached to it.',
      confirmLabel: 'Detach',
    });
    if (ok) await reparent(null);
  }

  async function remove(mode: DeleteEvidenceMode) {
    try {
      await del.mutateAsync({ uuid, comments: mode });
      toast.success('Evidence deleted');
      navigate(`/engagements/${slug}/evidence`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link to={`/engagements/${slug}/evidence`} className="text-sm text-muted hover:text-text">
          ← Back to timeline
        </Link>
        <h2 className="min-w-0 break-words text-xl font-semibold text-text">
          {evidence.title.trim() || <span className="text-muted">Untitled evidence</span>}
        </h2>
      </div>

      {isComment && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-surface-2 px-4 py-2 text-sm">
          <p className="min-w-0 text-muted">
            <span aria-hidden="true">↳</span> Linked evidence — attached to{' '}
            <Link
              to={`/engagements/${slug}/evidence/${evidence.parentEvidenceUuid}`}
              className="font-medium text-accent hover:underline"
            >
              {parentEvidence ? `“${parentEvidence.title}”` : 'the linked evidence'}
            </Link>
          </p>
          <div className="flex flex-none gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setReparenting('move')}
              loading={linkBusy && reparenting === 'move'}
              disabled={!canWrite || linkBusy}
              title={canWrite ? undefined : READ_ONLY_TITLE}
            >
              Move to another evidence…
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void detach()}
              loading={linkBusy && reparenting === null}
              disabled={!canWrite || linkBusy}
              title={canWrite ? undefined : READ_ONLY_TITLE}
            >
              Detach (make standalone)
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 min-w-0 space-y-4">
        {/* Meta header (type, capturer, when, last-edited) — above content. */}
        <Card className="p-4">
          <EvidenceMeta evidence={evidence} />
        </Card>

        {/* Details — read-only with an explicit Edit button (like Content). */}
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-text">Details</h3>
            {!editingDetails ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={startEditDetails}
                disabled={!canWrite}
                title={canWrite ? undefined : READ_ONLY_TITLE}
              >
                Edit
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditingDetails(false)}
                  disabled={savingDetails}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => void saveDetails()}
                  loading={savingDetails}
                  disabled={!canWrite || !draft.title.trim()}
                >
                  Save
                </Button>
              </div>
            )}
          </div>

          {editingDetails ? (
            <div className="space-y-4">
              <Field
                label="Title"
                htmlFor="d-title"
                required
                error={!draft.title.trim() ? 'A title is required.' : undefined}
              >
                <Input
                  id="d-title"
                  value={draft.title}
                  onChange={(e) => setDraft((f) => ({ ...f, title: e.target.value }))}
                  invalid={!draft.title.trim()}
                />
              </Field>
              <Field label="Description" htmlFor="d-desc" hint="Optional">
                <MarkdownField
                  id="d-desc"
                  rows={3}
                  value={draft.description}
                  onChange={(v) => setDraft((f) => ({ ...f, description: v }))}
                />
              </Field>
              <Field label="Tags">
                <TagPicker
                  tags={tags ?? []}
                  selectedIds={draft.tagIds}
                  onChange={(tagIds) => setDraft((f) => ({ ...f, tagIds }))}
                  onCreateTag={onCreateTag}
                />
              </Field>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Title is shown as the page heading above; here it's the editable
                  field (in edit mode) so it isn't repeated in the read-only view. */}
              {evidence.description.trim() ? (
                <MarkdownPreview source={evidence.description} />
              ) : (
                <p className="text-sm text-muted">No description.</p>
              )}
              {evidence.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {evidence.tags.map((t) => (
                    <TagChip key={t.id} name={t.name} colorName={t.colorName} />
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Linked goals — available on any evidence (including linked evidence). */}
        <LinkedGoalsSection slug={slug} kind="evidence" uuid={uuid} canWrite={canWrite} />

        {/* Linked evidence (child evidence). Hidden on a linked-evidence item —
            linking is one level deep, so it can't host its own children. */}
        {!isComment && (
          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-text">Linked evidence</h3>
              <div className="flex flex-none gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setReparenting('attach')}
                  loading={linkBusy && reparenting === 'attach'}
                  disabled={!canWrite || linkBusy || evidence.commentCount > 0}
                  title={
                    !canWrite
                      ? READ_ONLY_TITLE
                      : evidence.commentCount > 0
                        ? `Detach its ${evidence.commentCount} linked item(s) first — linking is one level deep.`
                        : undefined
                  }
                >
                  Link to another evidence…
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setAdding(true)}
                  disabled={!canWrite}
                  title={canWrite ? undefined : READ_ONLY_TITLE}
                >
                  Add linked evidence
                </Button>
              </div>
            </div>
            {linkedEvidence.isLoading ? (
              <Spinner />
            ) : linkedList.length === 0 ? (
              <p className="text-sm text-muted">
                No linked evidence yet. Attach a related capture as a follow-up on this item.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {linkedList.map((c) => (
                  // Each row badges its own inherited exclusion from the serialized
                  // `parentExcludedFromReport`, so nothing about this item's flag has
                  // to be threaded down. Toggling it below invalidates this list.
                  <EvidenceEntryRow key={c.uuid} slug={slug} ev={c} />
                ))}
              </ul>
            )}
          </Card>
        )}

        {/* The evidence content — its own deliberate Edit → Save. */}
        <EvidenceBody slug={slug} evidence={evidence} canWrite={canWrite} />

        {/* Plain-text discussion comments — available on any evidence. */}
        <EvidenceCommentsCard slug={slug} uuid={uuid} canWrite={canWrite} />

        {/* Report — whether this evidence reaches the client at all. Its own card
            above the Danger zone, and saved on click rather than folded into the
            Details draft. */}
        <Card className="space-y-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-text">Report</h3>
            <div className="flex items-center gap-2">
              {/* `excludeFromReport` rather than the serialized flag so the badge
                  tracks the checkbox optimistically; inheritance can't change here. */}
              {(excludeFromReport || evidence.parentExcludedFromReport) && (
                <ExcludedFromReportBadge inherited={!excludeFromReport} />
              )}
              {canWrite && <SaveStatusIndicator status={excludeStatus} />}
            </div>
          </div>
          <Checkbox
            label="Exclude from reports"
            checked={excludeFromReport}
            onChange={(e) => void saveExcludeFromReport(e.target.checked)}
            disabled={!canWrite || excludeStatus === 'saving'}
            title={canWrite ? undefined : READ_ONLY_TITLE}
          />
          <p className="pl-6 text-xs text-muted">{EXCLUDED_FROM_REPORT_HINT}</p>
          {/* Ticking the box is the moment someone wonders whether it reaches the
              report they already sent. It doesn't: a generated report keeps the exact
              bytes that were delivered, so say so here rather than only on the
              Reports tab, where they may never look. */}
          <p className="pl-6 text-xs text-muted">
            Applies to reports generated from now on — reports already in the history keep the exact
            bytes that were delivered.
          </p>
          {excludeFromReport && (
            <p className="pl-6 text-xs text-muted">
              It stays visible here, in the timeline and on every finding it’s attached to, so you
              can include it again later.
            </p>
          )}
          {/* An unticked box on evidence that is withheld anyway needs explaining: it
              is linked under an excluded capture, and the fix is on that capture. */}
          {!excludeFromReport && evidence.parentExcludedFromReport && (
            <p className="pl-6 text-xs text-muted">{EXCLUDED_FROM_REPORT_INHERITED_HINT}</p>
          )}
        </Card>

        {/* Danger zone — deletion lives on its own at the very bottom, deliberately
            separated from the Details edit flow, mirroring the engagement settings
            Danger zone. The confirm step is the DeleteEvidenceDialog below. */}
        {canWrite && (
          <Card className="space-y-4 border-danger/40 p-4">
            <h3 className="text-sm font-semibold text-danger">Danger zone</h3>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-text">Delete this evidence</p>
                <p className="text-sm text-muted">
                  Permanently removes this evidence and its content, comments, and goal links.{' '}
                  {evidence.commentCount > 0
                    ? `You’ll choose what happens to its ${evidence.commentCount} linked item(s). `
                    : ''}
                  This cannot be undone.
                </p>
              </div>
              <Button
                variant="danger"
                onClick={() => setDeleting(true)}
                loading={del.isPending}
                className="shrink-0"
              >
                Delete evidence
              </Button>
            </div>
          </Card>
        )}
      </div>

      <CreateEvidenceModal
        slug={slug}
        open={adding}
        onClose={() => setAdding(false)}
        parentEvidenceUuid={evidence.uuid}
        title="Add linked evidence"
      />
      <ReparentEvidenceModal
        slug={slug}
        open={reparenting !== null}
        currentUuid={uuid}
        title={reparenting === 'move' ? 'Move to…' : 'Link to…'}
        confirmLabel={reparenting === 'move' ? 'Move here' : 'Link here'}
        busy={linkBusy}
        onPick={(target) => void reparent(target)}
        onClose={() => setReparenting(null)}
      />
      <DeleteEvidenceDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        commentCount={evidence.commentCount}
        pending={del.isPending}
        onConfirm={remove}
      />
    </div>
  );
}
