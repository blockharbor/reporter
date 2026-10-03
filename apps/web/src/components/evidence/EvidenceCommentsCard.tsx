import { useState } from 'react';
import {
  Button,
  Card,
  MarkdownField,
  MarkdownPreview,
  Spinner,
  useConfirm,
  useToast,
} from '@reporter/ui';
import type { EvidenceComment } from '@reporter/shared';
import {
  useAddEvidenceComment,
  useDeleteEvidenceComment,
  useEvidenceComments,
  useUpdateEvidenceComment,
} from '../../api/hooks.js';
import { useAuth } from '../../auth.js';
import { READ_ONLY_TITLE } from '../../lib/permissions.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { userDisplayName } from '../../lib/user-display.js';

/**
 * A flat, chronological discussion thread on a piece of evidence — plain notes,
 * distinct from linked evidence. Any writer can add a markdown comment (deliberate
 * post, not autosave); authors can edit/delete their own. Internal-only.
 */
export function EvidenceCommentsCard({
  slug,
  uuid,
  canWrite,
}: {
  slug: string;
  uuid: string;
  canWrite: boolean;
}) {
  const { user } = useAuth();
  const query = useEvidenceComments(slug, uuid);
  const add = useAddEvidenceComment(slug, uuid);
  const toast = useToast();
  const [draft, setDraft] = useState('');

  const comments = query.data ?? [];

  async function submit() {
    const body = draft.trim();
    if (!body) return;
    try {
      await add.mutateAsync(body);
      setDraft('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add comment');
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold text-text">
        Comments{' '}
        {comments.length > 0 && <span className="font-normal text-muted">({comments.length})</span>}
      </h3>

      {query.isLoading ? (
        <Spinner />
      ) : query.isError ? (
        <p className="text-sm text-danger">Couldn’t load comments.</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted">No comments yet. Add a note for the team below.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {/* An anonymized comment (its author was deleted) is nobody's to edit —
              the server refuses the edit too, so no one gets the controls. */}
          {comments.map((c) => (
            <CommentRow
              key={c.uuid}
              slug={slug}
              uuid={uuid}
              comment={c}
              canEdit={canWrite && c.author !== null && user?.slug === c.author.slug}
            />
          ))}
        </ul>
      )}

      {canWrite ? (
        <div className="space-y-2 border-t border-border pt-3">
          <MarkdownField value={draft} onChange={setDraft} rows={3} placeholder="Add a comment…" />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => void submit()}
              loading={add.isPending}
              disabled={!draft.trim()}
            >
              Comment
            </Button>
          </div>
        </div>
      ) : (
        <p className="border-t border-border pt-3 text-xs text-muted" title={READ_ONLY_TITLE}>
          Read-only access — you can’t add comments.
        </p>
      )}
    </Card>
  );
}

function CommentRow({
  slug,
  uuid,
  comment,
  canEdit,
}: {
  slug: string;
  uuid: string;
  comment: EvidenceComment;
  canEdit: boolean;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const updateComment = useUpdateEvidenceComment(slug, uuid);
  const deleteComment = useDeleteEvidenceComment(slug, uuid);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  function startEdit() {
    setDraft(comment.body);
    setEditing(true);
  }

  async function save() {
    const body = draft.trim();
    if (!body) return;
    try {
      await updateComment.mutateAsync({ commentUuid: comment.uuid, body });
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save comment');
    }
  }

  async function remove() {
    const ok = await confirm({
      title: 'Delete comment',
      message: 'Delete this comment? This can’t be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteComment.mutateAsync(comment.uuid);
      toast.success('Comment deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete comment');
    }
  }

  return (
    <li className="rounded-input border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          <span className={comment.author ? 'font-medium text-text' : 'font-medium text-muted'}>
            {userDisplayName(comment.author)}
          </span>{' '}
          ·{' '}
          <span title={formatDateTime(comment.createdAt)}>{formatRelative(comment.createdAt)}</span>
          {comment.edited && <span title={formatDateTime(comment.updatedAt)}> · edited</span>}
        </span>
        {canEdit && !editing && (
          <span className="flex gap-2">
            <button type="button" onClick={startEdit} className="text-muted hover:text-text">
              Edit
            </button>
            <button
              type="button"
              onClick={() => void remove()}
              className="text-muted hover:text-danger"
            >
              Delete
            </button>
          </span>
        )}
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
          <MarkdownField value={draft} onChange={setDraft} rows={3} />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
              disabled={updateComment.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              loading={updateComment.isPending}
              disabled={!draft.trim()}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 text-sm text-text">
          <MarkdownPreview source={comment.body} />
        </div>
      )}
    </li>
  );
}
