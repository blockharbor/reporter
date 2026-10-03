import { Link } from 'react-router-dom';
import { Badge, TagChip, useToast } from '@reporter/ui';
import { EVIDENCE_TYPE_LABELS, type Evidence } from '@reporter/shared';
import { useToggleEvidenceStar } from '../../api/hooks.js';
import { evidenceHeading, evidenceSnippet } from '../../lib/evidence-label.js';
import { evidenceThumbUrl } from '../../lib/urls.js';
import { userDisplayName } from '../../lib/user-display.js';
import { EvidenceExclusionBadge } from './ExcludedFromReportBadge.js';
import { TimestampRail } from './TimestampRail.js';

const TYPE_ICON: Record<string, string> = {
  image: '🖼',
  codeblock: '⌨',
  'terminal-recording': '▸',
  'http-request-cycle': '⇄',
  event: '⚑',
  none: '✎',
};

/** Per-user star toggle. Rendered as a sibling of the row Link, never inside it. */
function StarButton({ slug, ev }: { slug: string; ev: Evidence }) {
  const toggle = useToggleEvidenceStar(slug, ev.uuid);
  const toast = useToast();
  return (
    <button
      type="button"
      aria-label="Star"
      aria-pressed={Boolean(ev.starred)}
      disabled={toggle.isPending}
      onClick={() =>
        toggle.mutate(!ev.starred, {
          onError: (err) =>
            toast.error(err instanceof Error ? err.message : 'Could not update star'),
        })
      }
      className={ev.starred ? 'text-warning' : 'text-muted hover:text-warning'}
    >
      {ev.starred ? '★' : '☆'}
    </button>
  );
}

/** One evidence entry in the daily-journal list. The row content links to detail. */
export function EvidenceEntryRow({ slug, ev }: { slug: string; ev: Evidence }) {
  const extraTags = ev.tags.length - 4;
  return (
    <li className="flex items-start gap-3 rounded-card border border-border bg-surface p-3 transition-colors hover:border-accent/50">
      <Link
        to={`/engagements/${slug}/evidence/${ev.uuid}`}
        className="flex min-w-0 flex-1 items-start gap-3"
      >
        <TimestampRail iso={ev.occurredAt} />
        <div className="h-12 w-12 flex-none overflow-hidden rounded-input border border-border bg-surface-2">
          {ev.hasThumbnail ? (
            <img
              src={evidenceThumbUrl(slug, ev.uuid)}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-lg text-muted">
              {TYPE_ICON[ev.contentType] ?? '•'}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text">{evidenceHeading(ev)}</p>
          {evidenceSnippet(ev) && (
            <p className="truncate text-xs text-muted">{evidenceSnippet(ev)}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone="neutral">{EVIDENCE_TYPE_LABELS[ev.contentType]}</Badge>
            <EvidenceExclusionBadge evidence={ev} />
            <span>{userDisplayName(ev.operator)}</span>
            {ev.parentEvidenceUuid && (
              <span
                className="inline-flex items-center gap-1"
                title="Linked evidence — attached to another piece of evidence"
              >
                <span aria-hidden>↳</span> linked evidence
              </span>
            )}
            {ev.commentCount > 0 && (
              <span
                className="inline-flex items-center gap-1"
                title={`${ev.commentCount} linked ${ev.commentCount === 1 ? 'item' : 'items'}`}
              >
                <span aria-hidden>🔗</span> {ev.commentCount}
              </span>
            )}
            {ev.tags.slice(0, 4).map((t) => (
              <TagChip key={t.id} name={t.name} colorName={t.colorName} />
            ))}
            {extraTags > 0 && <Badge tone="neutral">+{extraTags}</Badge>}
          </div>
        </div>
      </Link>
      <div className="flex-none self-center">
        <StarButton slug={slug} ev={ev} />
      </div>
    </li>
  );
}
