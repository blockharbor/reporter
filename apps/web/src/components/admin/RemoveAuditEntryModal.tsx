import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Field, Modal, Textarea, useToast } from '@reporter/ui';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_DELETE_REASON_MAX_CHARS,
  AUDIT_ENTITY_TYPE_LABELS,
  AUDIT_ENTRY_ALREADY_REMOVED,
  NO_ENGAGEMENT_LABEL,
  SYSTEM_ACTOR_LABEL,
  type AuditEntry,
} from '@reporter/shared';
import { ApiError } from '../../api/client.js';
import { useRemoveAuditEntry } from '../../api/hooks.js';
import { formatDateTime } from '../../lib/format.js';

/** `title` on the disabled Remove entry button until a reason is typed. */
export const REASON_REQUIRED_TITLE = 'Give a reason first';
/** Field error and button `title` once the reason passes the shared cap. */
export const REASON_TOO_LONG = `Keep the reason within ${AUDIT_DELETE_REASON_MAX_CHARS} characters`;
/**
 * The statement of consequence, in one place so the test can hold the modal to
 * it word for word: the details go, the record of the removal stays, and that
 * record is itself beyond removal (DECISIONS.md: tamper-evident, never undoable).
 */
export const REMOVAL_CONSEQUENCE =
  'The entry’s details are erased for good. A permanent record that you removed it — who, when, and this reason — takes their place, and that record can never itself be removed.';
export const REMOVED_TOAST =
  'Entry removed — a permanent record of the removal now stands in its place';

/**
 * The site admin's removal dialog. A `Modal` rather than `useConfirm`, because
 * the reason is mandatory input and `useConfirm` takes a message but no input
 * (the TagMergeModal reasoning). Mount it per entry — `{removing && …}` — so
 * the typed reason resets with the dialog instead of leaking into the next one.
 *
 * On success the hook invalidates both audit lists and this closes; the row
 * re-renders as a tombstone where it was. A 409 means another admin removed
 * the entry first: that is not a failure to retry, so it reads as "already
 * removed", refetches so the tombstone appears, and closes. Anything else
 * toasts the server's message and keeps the dialog open with the reason intact.
 */
export function RemoveAuditEntryModal({
  entry,
  open,
  onClose,
}: {
  entry: AuditEntry;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const remove = useRemoveAuditEntry();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const tooLong = trimmed.length > AUDIT_DELETE_REASON_MAX_CHARS;
  // Why the danger button is disabled right now, or undefined when it is live.
  const blocked = trimmed === '' ? REASON_REQUIRED_TITLE : tooLong ? REASON_TOO_LONG : undefined;

  async function submit() {
    if (blocked || remove.isPending) return;
    try {
      await remove.mutateAsync({ uuid: entry.uuid, reason: trimmed });
      toast.success(REMOVED_TOAST);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.warning(AUDIT_ENTRY_ALREADY_REMOVED);
        qc.invalidateQueries({ queryKey: ['admin-audit'] });
        qc.invalidateQueries({ queryKey: ['admin-audit-facets'] });
        onClose();
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Couldn’t remove the entry');
    }
  }

  const who = entry.actor ? `${entry.actor.name} (${entry.actor.email})` : SYSTEM_ACTOR_LABEL;
  const what = `${AUDIT_ACTION_LABELS[entry.action]} · ${AUDIT_ENTITY_TYPE_LABELS[entry.entityType]}${
    entry.entityLabel !== '' ? ` “${entry.entityLabel}”` : ''
  }`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Remove audit entry"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={submit}
            disabled={blocked !== undefined}
            loading={remove.isPending}
            title={blocked}
          >
            Remove entry
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-text">
        {/* What is about to be erased, in the row's own words, so the admin
            confirms the entry they meant and not the one below it. */}
        <div className="space-y-0.5 rounded-input border border-border bg-surface-2 p-3 text-xs">
          <p>
            <span className="font-medium">{formatDateTime(entry.createdAt)}</span> · {who}
          </p>
          <p>{what}</p>
          <p className="text-muted">
            {entry.engagement ? entry.engagement.name : NO_ENGAGEMENT_LABEL}
          </p>
        </div>

        <Field
          label="Reason"
          htmlFor="audit-remove-reason"
          required
          hint="Recorded permanently, with your name, in place of the entry."
          error={tooLong ? REASON_TOO_LONG : undefined}
        >
          <Textarea
            id="audit-remove-reason"
            rows={3}
            value={reason}
            autoFocus
            invalid={tooLong}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </Field>

        <p className="text-warning">{REMOVAL_CONSEQUENCE}</p>
      </div>
    </Modal>
  );
}
