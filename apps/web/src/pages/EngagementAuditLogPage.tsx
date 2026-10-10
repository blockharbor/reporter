import { useEffect, useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Button, EmptyState, ErrorState, Spinner } from '@reporter/ui';
import type { AuditEntry } from '@reporter/shared';
import { useAuditFacets, useAuditLog, useEngagement } from '../api/hooks.js';
import { useAuth } from '../auth.js';
import { AuditFilterBar } from '../components/audit/AuditFilterBar.js';
import { AuditLogTable } from '../components/audit/AuditLogTable.js';
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
} from '../components/audit/audit-filter.js';
import { Pagination } from '../components/common/Pagination.js';
import { formatDate } from '../lib/format.js';
import { READ_ONLY_TITLE, useEngagementPermissions } from '../lib/permissions.js';

/**
 * Where a row's What column links. Only the two entities with a page of their
 * own, and never for a delete — the row is gone, and a link to it would be a
 * dead end. `entityId` is the row's uuid for both.
 */
function entityHref(slug: string, row: AuditEntry): string | undefined {
  if (row.action === 'delete' || !row.entityId) return undefined;
  switch (row.entityType) {
    case 'evidence':
      return `/engagements/${slug}/evidence/${row.entityId}`;
    case 'finding':
      return `/engagements/${slug}/findings/${row.entityId}`;
    default:
      return undefined;
  }
}

/**
 * The engagement's Audit log tab: a server-filtered, server-paginated table
 * of who changed what and when, with the whole view in the URL. The route is
 * registered for every member like the other tabs, so the page gates itself:
 * a read-only member (the tab is hidden for them in EngagementLayout) gets an
 * explanatory empty state and the queries never fire — a deep link is not a
 * 403 toast.
 */
export function EngagementAuditLogPage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const {
    data: eng,
    isLoading: engLoading,
    isError: engError,
    refetch: refetchEng,
  } = useEngagement(slug);
  const { canWrite } = useEngagementPermissions(slug);
  // Site admins are known before the engagement loads; everyone else is
  // unresolved until it does, so don't flash the read-only state at a writer.
  const gateSettled = Boolean(user?.admin) || (!engLoading && eng !== undefined);
  const allowed = gateSettled && canWrite;

  // The site-only params (`eng`, `noEng`) are parsed and IGNORED here, as the
  // server ignores them under engagement scope: a link copied from the admin
  // page degrades to this engagement's log, and the bar must not show a chip
  // for a filter that is not narrowing anything.
  const query = useMemo(() => {
    const parsed = parseAuditQuery(params);
    return { ...parsed, filter: { ...parsed.filter, engagements: [], noEngagement: false } };
  }, [params]);
  const qs = auditQueryString(query);
  const { data, isLoading, isError, isFetching, isPlaceholderData, refetch } = useAuditLog(
    slug,
    qs,
    allowed,
  );
  const { data: facets } = useAuditFacets(slug, allowed);
  const totalPages = data ? auditTotalPages(data.total, data.pageSize) : 1;

  // DESIGN.md's convergence rule 2: filters and sort are view state → replace;
  // a page is a place → push. Any filter or sort change returns to page 1
  // (written as an absent key).
  const applyView = (filter: AuditFilterState, sort: AuditSort) =>
    setParams(writeAuditQuery(params, { filter, sort, page: 1 }), { replace: true });
  const clearAll = () => applyView(EMPTY_AUDIT_FILTER, DEFAULT_AUDIT_SORT);
  const goPage = (page: number) => setParams(writeAuditQuery(params, { ...query, page }));

  // Clamp, don't trust: `?page=99` on a 3-page log lands on page 3, with a
  // replace — a correction is not navigation. The server already clamps what
  // it serves; this keeps the URL and the pager honest about it. Never while
  // `data` is keepPreviousData's placeholder from ANOTHER query: Back to a
  // deep page from a narrower filtered view would otherwise be "corrected"
  // against the filtered view's total before this page's own answer arrived.
  useEffect(() => {
    if (data && !isPlaceholderData && query.page > totalPages) {
      setParams(writeAuditQuery(params, { ...query, page: totalPages }), { replace: true });
    }
  }, [data, isPlaceholderData, query, totalPages, params, setParams]);

  const filtersActive = isAuditFilterActive(query.filter);

  return (
    <div className="min-w-0">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-text">Audit log</h2>
        <p className="text-sm text-muted">
          Every change to this engagement — its evidence, findings, goals, tags, reports, members
          and settings — with who made it, when, and what it was changed to.
        </p>
      </div>

      {engError ? (
        <ErrorState description="Couldn’t load this engagement." onRetry={() => refetchEng()} />
      ) : !gateSettled ? (
        <div className="flex justify-center py-16">
          <Spinner size={26} />
        </div>
      ) : !canWrite ? (
        <EmptyState
          title="The audit log needs write access"
          description={`${READ_ONLY_TITLE}. The log records membership and settings changes, so it is shown to writers and admins only.`}
          action={
            <Link to={`/engagements/${slug}/evidence`}>
              <Button variant="secondary">Go to Evidence</Button>
            </Link>
          }
        />
      ) : (
        <>
          {/* Shown whenever the gate passes, even with zero rows, so a filter
              that hid everything can be undone from where it was set. */}
          <div className="mb-4">
            <AuditFilterBar
              filter={query.filter}
              sort={query.sort}
              facets={facets}
              onFilterChange={(f) => applyView(f, query.sort)}
              onClearAll={clearAll}
              total={data?.total ?? 0}
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
              // Distinct from the empty log below: there are entries, the
              // filter just excluded all of them.
              <EmptyState
                title="No entries match these filters"
                description="Try a broader filter, or clear them to see every entry in this engagement."
                action={
                  <Button variant="secondary" onClick={clearAll}>
                    Clear all
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No audit log entries yet"
                description="Changes to this engagement are recorded here as they happen — add evidence, edit a finding or change a setting and it will appear."
                action={
                  <Link to={`/engagements/${slug}/evidence`}>
                    <Button variant="secondary">Go to Evidence</Button>
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
                entityHref={(row) => entityHref(slug, row)}
                dimmed={isFetching}
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
              The log starts on {formatDate(facets.logStartsAt)}; nothing before that date can be
              shown.
            </p>
          )}
        </>
      )}
    </div>
  );
}
