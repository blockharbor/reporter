import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Input } from '@reporter/ui';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_TYPES,
  AUDIT_ENTITY_TYPE_LABELS,
  type AuditFacets,
} from '@reporter/shared';
import { ActiveAuditFilterChips } from './ActiveAuditFilterChips.js';
import {
  AUDIT_SORT_LABELS,
  isAuditFilterActive,
  isDefaultAuditSort,
  type AuditFilterState,
  type AuditSort,
} from './audit-filter.js';
import { ActorFilter } from './filters/ActorFilter.js';
import { DateFilter } from '../common/DateFilter.js';
import { EnumFacetFilter } from './filters/EnumFacetFilter.js';

/** Idle time after the last keystroke before the search reaches the URL (and the server). */
export const SEARCH_DEBOUNCE_MS = 250;

export interface AuditFilterBarProps {
  filter: AuditFilterState;
  sort: AuditSort;
  /** Undefined while loading; the enum facets then offer the whole vocabulary. */
  facets: AuditFacets | undefined;
  onFilterChange: (next: AuditFilterState) => void;
  /** Reset filters, sort AND page in one URL write — two sequential writes would race. */
  onClearAll: () => void;
  /** Entries matching the current filter (the server's exact count). */
  total: number;
  /**
   * Extra facet controls rendered FIRST, before Who — the Admin tab's
   * engagement picker, which is the facet an admin reaches for first.
   */
  leadingFacets?: ReactNode;
}

/**
 * The vocabulary to offer: every value the facets say is present, plus any
 * already-selected one (a deep link to a value this scope no longer has must
 * keep its checkbox), in canonical enum order. The whole enum while loading.
 */
function offered<T extends string>(
  all: readonly T[],
  present: T[] | undefined,
  selected: T[],
): T[] {
  if (!present) return [...all];
  const keep = new Set([...present, ...selected]);
  return all.filter((v) => keep.has(v));
}

/**
 * The audit filter bar, shared by the engagement tab and Admin → Audit log.
 * Fully controlled: the page owns the state in the URL and this component only
 * proposes the next value. It follows DESIGN.md's three convergence rules —
 * text applies as you type (debounced, because every application here is a
 * server round trip, unlike the client-side findings bar), the page replaces
 * history for filter and sort changes, and Clear all sits in the right-hand
 * group beside the one `role="status"` count line. There is no sort control:
 * the table's headers sort, and the status line names the order.
 */
export function AuditFilterBar({
  filter,
  sort,
  facets,
  onFilterChange,
  onClearAll,
  total,
  leadingFacets,
}: AuditFilterBarProps) {
  // The box keeps a local draft so a slow render can never swallow a
  // keystroke, and re-syncs if the URL changes elsewhere (Back, a chip).
  // `typed` marks a draft that came from the keyboard: only those are
  // debounced out to the page. A reset from the URL or from Clear all is
  // already applied by whoever made it, and must not schedule a second,
  // racing write of its own.
  const [search, setSearchState] = useState(filter.search);
  const typed = useRef(false);
  useEffect(() => {
    typed.current = false;
    setSearchState(filter.search);
  }, [filter.search]);
  const setSearch = (next: string) => {
    typed.current = true;
    setSearchState(next);
  };

  // Latest-value refs (the Popover.tsx idiom): the timer applies the search
  // over whatever filter and callback are current when it FIRES, not the ones
  // at keystroke time — a facet toggled during the debounce must survive it.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const onFilterChangeRef = useRef(onFilterChange);
  onFilterChangeRef.current = onFilterChange;

  useEffect(() => {
    if (!typed.current || search === filterRef.current.search) return;
    const t = setTimeout(() => {
      typed.current = false;
      onFilterChangeRef.current({ ...filterRef.current, search });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const filtersActive = isAuditFilterActive(filter);
  const anythingActive = filtersActive || !isDefaultAuditSort(sort);

  const clearAll = () => {
    typed.current = false;
    setSearchState('');
    onClearAll();
  };

  const noun = total === 1 ? 'entry' : 'entries';

  return (
    <div className="rounded-card border border-border bg-surface p-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search the audit log…"
            aria-label="Search audit log entries"
          />
        </div>

        {leadingFacets}

        <ActorFilter
          value={filter.actors}
          actors={facets?.actors ?? []}
          onChange={(actors) => onFilterChange({ ...filter, actors })}
        />
        <EnumFacetFilter
          name="Action"
          idPrefix="audit-action"
          label="Filter by action"
          options={offered(AUDIT_ACTIONS, facets?.actions, filter.actions)}
          labels={AUDIT_ACTION_LABELS}
          value={filter.actions}
          onChange={(actions) => onFilterChange({ ...filter, actions })}
        />
        <EnumFacetFilter
          name="What"
          idPrefix="audit-entity"
          label="Filter by what was changed"
          options={offered(AUDIT_ENTITY_TYPES, facets?.entityTypes, filter.entityTypes)}
          labels={AUDIT_ENTITY_TYPE_LABELS}
          value={filter.entityTypes}
          onChange={(entityTypes) => onFilterChange({ ...filter, entityTypes })}
        />
        <DateFilter
          value={filter.dateRange}
          onChange={(dateRange) => onFilterChange({ ...filter, dateRange })}
        />
      </div>

      <div className="mt-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {filtersActive && (
            <ActiveAuditFilterChips filter={filter} facets={facets} onChange={onFilterChange} />
          )}
        </div>
        <div className="flex flex-none items-center gap-2">
          {/* One live region for both the count and the ordering, so a screen
              reader hears the result of a filter or sort change once. */}
          <p role="status" aria-live="polite" className="text-xs text-muted">
            {filtersActive ? `${total} matching ${noun}` : `${total} ${noun}`}
            {` · sorted by ${AUDIT_SORT_LABELS[sort.key].toLowerCase()}, `}
            {sort.dir === 'asc' ? 'ascending' : 'descending'}
          </p>
          {anythingActive && (
            <Button variant="ghost" size="sm" onClick={clearAll}>
              Clear all
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
