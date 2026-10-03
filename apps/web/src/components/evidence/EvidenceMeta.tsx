import { Badge } from '@reporter/ui';
import { EVIDENCE_TYPE_LABELS, type Evidence } from '@reporter/shared';
import { formatDateTime, formatDayHeading, formatRelative, formatTime } from '../../lib/format.js';
import { userDisplayName } from '../../lib/user-display.js';
import { EvidenceExclusionBadge } from './ExcludedFromReportBadge.js';

/** Shared evidence chrome: type, operator, timestamp, and last-edited. Tags live
 *  in the Details section on the detail page, so they aren't repeated here. */
export function EvidenceMeta({ evidence }: { evidence: Evidence }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
      <Badge tone="accent">{EVIDENCE_TYPE_LABELS[evidence.contentType]}</Badge>
      <EvidenceExclusionBadge evidence={evidence} />
      <span>{userDisplayName(evidence.operator)}</span>
      <span>·</span>
      <time dateTime={evidence.occurredAt} title={formatDateTime(evidence.occurredAt)}>
        {formatDayHeading(evidence.occurredAt)} at {formatTime(evidence.occurredAt)}
      </time>
      <span>({formatRelative(evidence.occurredAt)})</span>
      {evidence.lastEditedBy && (
        <span title={formatDateTime(evidence.updatedAt)}>
          · edited by {evidence.lastEditedBy.firstName} {evidence.lastEditedBy.lastName}{' '}
          {formatRelative(evidence.updatedAt)}
        </span>
      )}
    </div>
  );
}
