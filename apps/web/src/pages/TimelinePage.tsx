import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Button, EmptyState, ErrorState, Spinner, cn } from '@reporter/ui';
import {
  isEmptyQuery,
  parseQuery,
  stringifyQuery,
  type Evidence,
  type ParsedQuery,
} from '@reporter/shared';
import { useTimeline, type EvidenceOperator } from '../api/hooks.js';
import { READ_ONLY_TITLE, useEngagementPermissions } from '../lib/permissions.js';
import { CreateEvidenceModal } from '../components/evidence/CreateEvidenceModal.js';
import { FilterBar } from '../components/evidence/FilterBar.js';
import { EvidenceDayGroup } from '../components/evidence/EvidenceDayGroup.js';
import { groupByLocalDay } from '../lib/group-evidence.js';

const EMPTY_QUERY: ParsedQuery = {
  text: [],
  tags: [],
  operators: [],
  types: [],
  dateRanges: [],
  uuids: [],
  sortAsc: false,
};

/**
 * The distinct operators present on the current page (a fallback filter source).
 * Anonymized evidence (its operator was deleted) contributes nobody — there is no
 * identity left to filter by, and the rows themselves stay in the timeline.
 */
function operatorsFromItems(items: Evidence[]): EvidenceOperator[] {
  const bySlug = new Map<string, EvidenceOperator>();
  for (const ev of items) {
    if (!ev.operator) continue;
    if (!bySlug.has(ev.operator.slug)) bySlug.set(ev.operator.slug, ev.operator);
  }
  return [...bySlug.values()];
}

export function TimelinePage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const page = Number(params.get('page') ?? '1');
  const [adding, setAdding] = useState(false);

  const parsed = useMemo(() => parseQuery(q), [q]);
  const { canWrite } = useEngagementPermissions(slug);
  const { data, isLoading, isError, isFetching, refetch } = useTimeline(slug, q, page);

  const applyQuery = useCallback(
    (next: ParsedQuery) => {
      const nextParams = new URLSearchParams(params);
      const canonical = stringifyQuery(next);
      if (canonical) nextParams.set('q', canonical);
      else nextParams.delete('q');
      nextParams.delete('page'); // any filter change returns to the first page
      setParams(nextParams);
    },
    [params, setParams],
  );

  const goPage = (p: number) => {
    const nextParams = new URLSearchParams(params);
    nextParams.set('page', String(p));
    setParams(nextParams);
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const groups = useMemo(() => (data ? groupByLocalDay(data.items) : []), [data]);
  const operatorsOnPage = useMemo(() => operatorsFromItems(data?.items ?? []), [data]);

  // Collapse state is view-local (not in the URL, so shared links stay clean).
  // Default policy: the newest day is always open; if there are <=3 days open all
  // of them (the common, sparse case), otherwise collapse all but the first.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const groupSig = groups.map((g) => g.key).join('|');
  // groupSig captures the identity of the current day set; re-run only when it changes.
  useEffect(() => {
    setCollapsed(groups.length <= 3 ? new Set() : new Set(groups.slice(1).map((g) => g.key)));
  }, [groupSig]);

  const toggleDay = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(groups.map((g) => g.key)));

  return (
    <div>
      <FilterBar
        slug={slug}
        parsed={parsed}
        onChange={applyQuery}
        operatorsOnPage={operatorsOnPage}
        onAdd={() => setAdding(true)}
        canAdd={canWrite}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        showGroupControls={groups.length > 1}
      />

      <div className="mt-4">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner size={26} />
          </div>
        ) : isError ? (
          <ErrorState description="Couldn't load the timeline." onRetry={() => refetch()} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            title={isEmptyQuery(parsed) ? 'No evidence yet' : 'No evidence matches your filter'}
            description={
              isEmptyQuery(parsed)
                ? 'Capture your first screenshot with the desktop app, record a terminal session, or add evidence here.'
                : 'Try a broader query, or clear the filter to see everything.'
            }
            action={
              isEmptyQuery(parsed) ? (
                <Button
                  onClick={() => setAdding(true)}
                  disabled={!canWrite}
                  title={canWrite ? undefined : READ_ONLY_TITLE}
                >
                  Add evidence
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => applyQuery(EMPTY_QUERY)}>
                  Clear filters
                </Button>
              )
            }
          />
        ) : (
          <div className={cn('flex flex-col gap-4', isFetching && 'opacity-70 transition-opacity')}>
            {groups.map((g) => (
              <EvidenceDayGroup
                key={g.key}
                group={g}
                slug={slug}
                isOpen={!collapsed.has(g.key)}
                onToggle={() => toggleDay(g.key)}
              />
            ))}
            {totalPages > 1 && (
              <div className="mt-2 flex items-center justify-center gap-3 text-sm">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => goPage(page - 1)}
                >
                  Previous
                </Button>
                <span className="text-muted">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => goPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <CreateEvidenceModal slug={slug} open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
