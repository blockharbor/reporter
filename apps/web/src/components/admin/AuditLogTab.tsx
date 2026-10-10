import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, EmptyState, ErrorState, Spinner } from '@reporter/ui';
import { AUDIT_ENTRY_ALREADY_REMOVED, type AuditEntry } from '@reporter/shared';
import { useAdminAuditFacets, useAdminAuditLog } from '../../api/hooks.js';
import { formatDate } from '../../lib/format.js';
import { AuditFilterBar } from '../audit/AuditFilterBar.js';
import { AuditLogTable } from '../audit/AuditLogTable.js';
import {
  DEFAULT_AUDIT_SORT,
  EMPTY_AUDIT_FILTER,
  auditQueryString,
  auditTotalPages,
  isAuditFilterActive,
  parseAuditQuery,
  writeAuditQuery,
  type AuditFilterState,
  type AuditSort,
} from '../audit/audit-filter.js';
import { Pagination } from '../common/Pagination.js';
import { AuditEngagementFilter } from './AuditEngagementFilter.js';
import { RemoveAuditEntryModal } from './RemoveAuditEntryModal.js';

/**
 * Hover text for a live Remove control. The disabled one, on a tombstone,
 * carries the shared 409 message instead, so the button and the server refuse
 * in the same words.
 */
export const REMOVE_ENTRY_TITLE =
  'Erase this entry’s details for good, leaving a permanent record of the removal';

/**
 * Where a row's What column links: the two entities with a page of their own,
 * never for a delete (the row is gone), and only inside a LIVE engagement — a
 * deleted engagement's slug may since have been reissued, so a link built from
 * the snapshot could land on someone else's evidence.
 */
function entityHref(row: AuditEntry): string | undefined {
  if (row.action === 'delete' || !row.entityId) return undefined;
  const eng = row.engagement;
  if (!eng || eng.deleted) return undefined;
  switch (row.entityType) {
    case 'evidence':
      return `/engagements/${eng.slug}/evidence/${row.entityId}`;
    case 'finding':
      return `/engagements/${eng.slug}/findings/${row.entityId}`;
    default:
      return undefined;
  }
}

/**
 * The trailing cell's control. On a tombstone it renders DISABLED with the
 * shared "already removed" message as its `title` rather than vanishing —
 * DESIGN.md's rule for a control the user cannot use right now — and the
 * ghost variant keeps a disabled button hoverable so that title can show.
 */
function RemoveEntryButton({ row, onClick }: { row: AuditEntry; onClick: () => void }) {
  const removed = row.deleted !== null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-danger"
      disabled={removed}
      title={removed ? AUDIT_ENTRY_ALREADY_REMOVED : REMOVE_ENTRY_TITLE}
      onClick={onClick}
    >
      Remove
    </Button>
  );
}

/**
 * Admin → Audit log: every entry on the server, across all engagements and the
 * sign-ins and admin changes that belong to none. The first admin list that is
 * filtered and paged on the server — the other admin tabs fetch everything and
 * filter in memory, which a forever-retained log cannot — so the whole view
 * lives in the URL beside the page's own `?tab=audit-log`, which
 * `writeAuditQuery` preserves because it deletes only the keys it owns.
 *
 * It composes the shared components/audit module the engagement tab is built
 * from, plus the three things only a site admin gets: the Engagement facet
 * (leading, because it is the facet an admin reaches for first), the
 * Engagement column, and the tamper-evident Remove control (DECISIONS.md:
 * site admins only, never undoable). Mounted only for site admins by App.tsx's
 * `/admin` route, so there is no role gate of its own.
 */
export function AuditLogTab() {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => parseAuditQuery(params), [params]);
  const qs = auditQueryString(query);
  const { data, isLoading, isError, isFetching, isPlaceholderData, refetch } = useAdminAuditLog(qs);
  const { data: facets } = useAdminAuditFacets();
  const totalPages = data ? auditTotalPages(data.total, data.pageSize) : 1;

  // The modal is mounted per entry (`{removing && …}`) so its typed reason
  // resets with the dialog instead of leaking into the next removal.
  const [removing, setRemoving] = useState<AuditEntry | null>(null);

  // DESIGN.md's convergence rule 2: filters and sort are view state → replace;
  // a page is a place → push. Any filter or sort change returns to page 1
  // (written as an absent key).
  const applyView = (filter: AuditFilterState, sort: AuditSort) =>
    setParams(writeAuditQuery(params, { filter, sort, page: 1 }), { replace: true });
  const clearAll = () => applyView(EMPTY_AUDIT_FILTER, DEFAULT_AUDIT_SORT);
  const goPage = (page: number) => setParams(writeAuditQuery(params, { ...query, page }));

  // Clamp, don't trust: `?page=99` on a 3-page log lands on page 3, with a
  // replace — a correction is not navigation. The server already clamps what
  // it serves; this keeps the URL and the pager honest about it.
  // Never while `data` is keepPreviousData's placeholder from another query —
  // see EngagementAuditLogPage for the Back-from-a-filter case.
  useEffect(() => {
    if (data && !isPlaceholderData && query.page > totalPages) {
      setParams(writeAuditQuery(params, { ...query, page: totalPages }), { replace: true });
    }
  }, [data, isPlaceholderData, query, totalPages, params, setParams]);

  const filtersActive = isAuditFilterActive(query.filter);

  return (
    <div className="min-w-0">
      <p className="mb-4 text-sm text-muted">
        Every recorded action on this server — across all engagements, plus the sign-ins and admin
        changes that belong to none. Entries are kept forever; removing one erases its details and
        leaves a permanent record of the removal in its place.
      </p>

      {/* Shown even with zero rows, so a filter that hid everything can be
          undone from where it was set. */}
      <div className="mb-4">
        <AuditFilterBar
          filter={query.filter}
          sort={query.sort}
          facets={facets}
          onFilterChange={(f) => applyView(f, query.sort)}
          onClearAll={clearAll}
          total={data?.total ?? 0}
          leadingFacets={
            <AuditEngagementFilter
              value={{
                engagements: query.filter.engagements,
                noEngagement: query.filter.noEngagement,
              }}
              options={facets?.engagements}
              onChange={(next) => applyView({ ...query.filter, ...next }, query.sort)}
            />
          }
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner size={26} />
        </div>
      ) : isError ? (
        <ErrorState description="Couldn’t load the audit log." onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        filtersActive ? (
          // Distinct from the empty log below: there are entries, the filter
          // just excluded all of them.
          <EmptyState
            title="No entries match these filters"
            description="Try a broader filter, or clear them to see every entry on this server."
            action={
              <Button variant="secondary" onClick={clearAll}>
                Clear all
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="No audit log entries yet"
            description="Sign-ins, edits, exports and admin changes are recorded here as they happen, across every engagement."
            action={
              <Link to="/engagements">
                <Button variant="secondary">Go to Engagements</Button>
              </Link>
            }
          />
        )
      ) : (
        <>
          <AuditLogTable
            rows={data.items}
            sort={query.sort}
            onSortChange={(s) => applyView(query.filter, s)}
            entityHref={entityHref}
            dimmed={isFetching}
            showEngagementColumn
            renderActions={(row) => (
              <RemoveEntryButton row={row} onClick={() => setRemoving(row)} />
            )}
          />
          <Pagination
            page={query.page}
            totalPages={totalPages}
            onPageChange={goPage}
            className="mt-2"
          />
        </>
      )}

      {facets?.logStartsAt && (
        <p className="mt-4 text-xs text-muted">
          The log starts on {formatDate(facets.logStartsAt)}; nothing before that date can be shown.
        </p>
      )}

      {removing && (
        <RemoveAuditEntryModal entry={removing} open onClose={() => setRemoving(null)} />
      )}
    </div>
  );
}
