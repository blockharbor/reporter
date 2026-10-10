import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  SortableTh,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  cn,
  type BadgeTone,
} from '@reporter/ui';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_TYPE_LABELS,
  AUDIT_SOURCE_LABELS,
  AUDIT_VIA_LABELS,
  DELETED_ENGAGEMENT_LABEL,
  DELETED_USER_LABEL,
  NO_ENGAGEMENT_LABEL,
  SYSTEM_ACTOR_LABEL,
  type AuditAction,
  type AuditEntry,
  type AuditSortKey,
} from '@reporter/shared';
import { formatDateTime, formatTime } from '../../lib/format.js';
import { AuditChangeList, changeName } from './AuditChangeList.js';
import { AUDIT_FIRST_CLICK_DIR, type AuditSort } from './audit-filter.js';

export interface AuditLogTableProps {
  rows: AuditEntry[];
  sort: AuditSort;
  onSortChange: (next: AuditSort) => void;
  /** Where the What column links; undefined (or absent) renders plain text. */
  entityHref?: (row: AuditEntry) => string | undefined;
  /** True while the next page is loading over the previous one's rows. */
  dimmed?: boolean;
  /** The Admin tab's extra column: which engagement a row belongs to. */
  showEngagementColumn?: boolean;
  /** The Admin tab's trailing cell (its Remove control). Rendered for tombstones too. */
  renderActions?: (row: AuditEntry) => ReactNode;
}

/**
 * A total record, so a new action is a compile error here rather than a blank
 * badge: content writes by what they did, the sign-in family as accent, the
 * reads as neutral, and the two that rewrite history (merge, import) as warning.
 */
const ACTION_TONE: Record<AuditAction, BadgeTone> = {
  create: 'success',
  update: 'info',
  delete: 'danger',
  reorder: 'info',
  link: 'info',
  unlink: 'info',
  merge: 'warning',
  unapply: 'warning',
  sign_in: 'accent',
  sign_out: 'accent',
  sign_in_failed: 'danger',
  password_changed: 'accent',
  totp_reset: 'accent',
  recovery_link_issued: 'accent',
  recovery_code_used: 'accent',
  api_key_auth: 'accent',
  report_generated: 'neutral',
  download: 'neutral',
  export: 'neutral',
  import: 'warning',
};

const sameLocalDay = (a: string, b: string) =>
  new Date(a).toDateString() === new Date(b).toDateString();

/** Hover text for the Imported badge; the wire carries no source name, so none is invented. */
const IMPORTED_TITLE =
  'Restored from an engagement export. This server did not witness it; the file could say anything.';
/** The same explanation as a footnote, for readers who never hover. */
export const IMPORTED_FOOTNOTE =
  'Entries marked Imported were restored from a backup; this server did not record them.';

/**
 * The audit log as a table — presentational (rows in, sort out), so both tabs
 * render it and jsdom tests need no hooks. When / Who / Action sort through
 * SortableTh; What is the entity; Change is the server's summary sentence with
 * a toggle that opens a second row listing every field. The snapshot is always
 * primary in Who: the name the row recorded at write time, with the account's
 * current name as a "now called" hint when it differs, because any user can
 * rename themselves and the log must not relabel history. A removed entry
 * renders as a tombstone in place — one muted row naming who removed it, when
 * and why — and still gets its `renderActions` cell, so the Admin tab's Remove
 * control can show disabled there rather than vanish.
 */
export function AuditLogTable({
  rows,
  sort,
  onSortChange,
  entityHref,
  dimmed,
  showEngagementColumn = false,
  renderActions,
}: AuditLogTableProps) {
  // Expanded rows are view-local, like the timeline's collapse set: a shared
  // link reproduces the view, not which rows the reader had open.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (uuid: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });

  const toggleSort = (key: AuditSortKey) =>
    onSortChange(
      sort.key === key
        ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: AUDIT_FIRST_CLICK_DIR[key] },
    );
  const directionOf = (key: AuditSortKey) => (sort.key === key ? sort.dir : undefined);

  const contentColumns = 5 + (showEngagementColumn ? 1 : 0);
  const totalColumns = contentColumns + (renderActions ? 1 : 0);
  const anyImported = rows.some((r) => r.source === 'import');

  return (
    <>
      <Table className={cn(dimmed && 'opacity-70 transition-opacity')}>
        <Thead>
          <Tr>
            <SortableTh direction={directionOf('when')} onSort={() => toggleSort('when')}>
              When
            </SortableTh>
            <SortableTh direction={directionOf('who')} onSort={() => toggleSort('who')}>
              Who
            </SortableTh>
            <SortableTh direction={directionOf('action')} onSort={() => toggleSort('action')}>
              Action
            </SortableTh>
            <Th>What</Th>
            {showEngagementColumn && <Th>Engagement</Th>}
            <Th>Change</Th>
            {renderActions && (
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            )}
          </Tr>
        </Thead>
        <Tbody>
          {rows.map((row) => {
            if (row.deleted) {
              // The tombstone keeps its place (its When sorts it) but its content
              // is gone for good; the row says so instead of showing blanks.
              const removed = row.deleted;
              return (
                <Tr key={row.uuid} className="bg-surface-2/40">
                  <Td className="whitespace-nowrap align-top text-muted">
                    <time dateTime={row.createdAt}>{formatDateTime(row.createdAt)}</time>
                  </Td>
                  <Td colSpan={contentColumns - 1} className="text-sm italic text-muted">
                    An entry was removed here by{' '}
                    <span title={removed.byEmail}>{removed.byName}</span> on{' '}
                    <time dateTime={removed.at}>{formatDateTime(removed.at)}</time>:{' '}
                    {removed.reason}
                  </Td>
                  {renderActions && <Td className="text-right">{renderActions(row)}</Td>}
                </Tr>
              );
            }

            const isOpen = expanded.has(row.uuid);
            const detailId = `audit-${row.uuid}-changes`;
            const href = entityHref?.(row);
            const n = row.changes.length;
            const names = row.changes.slice(0, 2).map((c) => changeName(c, row.entityType));

            return [
              <Tr key={row.uuid}>
                <Td className="whitespace-nowrap align-top">
                  <time dateTime={row.createdAt} title={formatDateTime(row.lastAt)}>
                    {formatDateTime(row.createdAt)}
                  </time>
                  {row.coalescedCount > 1 && (
                    <span className="block text-xs text-muted">
                      {row.coalescedCount} saves, last{' '}
                      {sameLocalDay(row.createdAt, row.lastAt)
                        ? `at ${formatTime(row.lastAt)}`
                        : formatDateTime(row.lastAt)}
                    </span>
                  )}
                </Td>
                <Td className="align-top">
                  {row.actor === null ? (
                    <span className="text-muted" title={AUDIT_VIA_LABELS[row.via]}>
                      {SYSTEM_ACTOR_LABEL}
                    </span>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-1">
                        <span className="font-medium text-text">{row.actor.name}</span>
                        {row.actor.slug === null && row.source !== 'import' && (
                          <Badge tone="neutral">{DELETED_USER_LABEL}</Badge>
                        )}
                        {row.via === 'apikey' && (
                          <Badge tone="neutral">{AUDIT_VIA_LABELS.apikey}</Badge>
                        )}
                      </span>
                      <span className="text-xs text-muted">{row.actor.email}</span>
                      {row.actor.currentName !== null && (
                        <span className="text-xs text-muted">
                          now called {row.actor.currentName}
                        </span>
                      )}
                    </div>
                  )}
                </Td>
                <Td className="align-top">
                  {/* nowrap: the column is sized by its widest badge, and a two-word
                    label ("Generated report") must not break mid-badge. */}
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge tone={ACTION_TONE[row.action]} className="whitespace-nowrap">
                      {AUDIT_ACTION_LABELS[row.action]}
                    </Badge>
                    {row.source === 'import' && (
                      // The title sits on a wrapper, so the whole pill explains itself
                      // on hover (the ExcludedFromReportBadge shape).
                      <span title={IMPORTED_TITLE} className="inline-flex">
                        <Badge tone="warning" className="whitespace-nowrap">
                          {AUDIT_SOURCE_LABELS.import}
                        </Badge>
                      </span>
                    )}
                  </span>
                </Td>
                <Td className="align-top">
                  <span className="block text-xs uppercase tracking-wide text-muted">
                    {AUDIT_ENTITY_TYPE_LABELS[row.entityType]}
                  </span>
                  {row.entityLabel !== '' &&
                    (href ? (
                      <Link
                        to={href}
                        className="block max-w-80 truncate text-accent hover:underline"
                        title={row.entityLabel}
                      >
                        {row.entityLabel}
                      </Link>
                    ) : (
                      <span className="block max-w-80 truncate" title={row.entityLabel}>
                        {row.entityLabel}
                      </span>
                    ))}
                </Td>
                {showEngagementColumn && (
                  <Td className="align-top">
                    {row.engagement === null ? (
                      <span className="text-muted">{NO_ENGAGEMENT_LABEL}</span>
                    ) : row.engagement.deleted ? (
                      // The slug may since have been reissued; never link a snapshot.
                      <span className="flex flex-wrap items-center gap-1">
                        <span title={row.engagement.slug}>{row.engagement.name}</span>
                        <Badge tone="neutral">{DELETED_ENGAGEMENT_LABEL}</Badge>
                      </span>
                    ) : (
                      <Link
                        to={`/engagements/${row.engagement.slug}/audit-log`}
                        className="text-accent hover:underline"
                        title={row.engagement.slug}
                      >
                        {row.engagement.name}
                      </Link>
                    )}
                  </Td>
                )}
                <Td className="align-top">
                  {row.summary !== '' && <span className="block">{row.summary}</span>}
                  {n === 0 ? (
                    row.summary === '' && <span className="text-muted">—</span>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={detailId}
                      onClick={() => toggleExpanded(row.uuid)}
                      className="mt-0.5 text-xs text-accent hover:underline"
                    >
                      <span aria-hidden="true">{isOpen ? '▾ ' : '▸ '}</span>
                      {n} {n === 1 ? 'change' : 'changes'}: {names.join(', ')}
                      {n > 2 ? `, +${n - 2} more` : ''}
                    </button>
                  )}
                </Td>
                {renderActions && <Td className="text-right align-top">{renderActions(row)}</Td>}
              </Tr>,
              isOpen && (
                <Tr key={`${row.uuid}-changes`} id={detailId}>
                  <Td colSpan={totalColumns} className="bg-surface-2/40 p-3">
                    <AuditChangeList changes={row.changes} entityType={row.entityType} />
                  </Td>
                </Tr>
              ),
            ];
          })}
        </Tbody>
      </Table>
      {anyImported && <p className="mt-2 text-xs text-muted">{IMPORTED_FOOTNOTE}</p>}
    </>
  );
}
