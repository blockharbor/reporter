import { useEffect, useState } from 'react';
import { Button, Input, Select } from '@reporter/ui';
import { ISO_21434_WORK_PRODUCTS, UN_R155_REQUIREMENTS } from '@reporter/shared';
import { useFindingCategories } from '../../api/hooks.js';
import { ActiveFindingFilterChips } from './ActiveFindingFilterChips.js';
import { CategoryFilter } from './filters/CategoryFilter.js';
import { FixEffortFilter } from './filters/FixEffortFilter.js';
import { FindingsSortControls } from './filters/FindingsSortControls.js';
import { KindFilter } from './filters/KindFilter.js';
import { SeverityFilter } from './filters/SeverityFilter.js';
import { StandardsFilter } from './filters/StandardsFilter.js';
import { TargetFilter } from './filters/TargetFilter.js';
import {
  FINDING_SORT_LABELS,
  isFilterActive,
  isManualOrder,
  type FindingFacets,
  type FindingsFilterState,
  type FindingsSort,
} from './findings-filter.js';

/** `yes` / `no` / unset, as a labelled dropdown — the honest control for a tri-state. */
function TriStateFilter({
  value,
  onChange,
  label,
  anyLabel,
  yesLabel,
  noLabel,
}: {
  value: boolean | undefined;
  onChange: (next: boolean | undefined) => void;
  label: string;
  anyLabel: string;
  yesLabel: string;
  noLabel: string;
}) {
  // Sized by its wrapper, like every other Select in the app: `cn` doesn't resolve
  // Tailwind conflicts, so a width class on the control can't beat its own w-full.
  return (
    <div className="w-40">
      <Select
        value={value === undefined ? 'any' : value ? 'yes' : 'no'}
        onChange={(e) => onChange(e.target.value === 'any' ? undefined : e.target.value === 'yes')}
        aria-label={label}
      >
        <option value="any">{anyLabel}</option>
        <option value="yes">{yesLabel}</option>
        <option value="no">{noLabel}</option>
      </Select>
    </div>
  );
}

/**
 * The findings filter: free-text search, the structured facets, sort, removable
 * active-filter chips and a result count. Mirrors the evidence FilterBar's layout
 * and control idiom, but everything here is applied client-side over the already
 * fetched findings — there is no server query and nothing refetches.
 *
 * All state is owned by the caller (and lives in the URL); this component only
 * proposes the next value.
 */
export function FindingsFilterBar({
  slug,
  filter,
  sort,
  facets,
  onFilterChange,
  onSortChange,
  onClearAll,
  shown,
  total,
  /** Why dragging is off right now, if it is. Shown as a hint next to the count. */
  reorderHint,
}: {
  slug: string;
  filter: FindingsFilterState;
  sort: FindingsSort;
  facets: FindingFacets;
  onFilterChange: (next: FindingsFilterState) => void;
  onSortChange: (next: FindingsSort) => void;
  /** Reset filters *and* sort in one write — two sequential writes would race. */
  onClearAll: () => void;
  shown: number;
  total: number;
  reorderHint?: string;
}) {
  const { data: categories } = useFindingCategories(slug);

  // The engagement's categories, with any already-selected value unioned in so a
  // deep-linked filter is never dropped from its own option list (a category can
  // be renamed or soft-deleted while a link to it is still in circulation).
  const categoryNames = (categories ?? []).map((c) => c.category);
  for (const selected of filter.categories) {
    if (!categoryNames.includes(selected)) categoryNames.push(selected);
  }

  // Search is applied as the user types; the box keeps a local draft so a slow
  // render can never swallow a keystroke, and re-syncs if the URL changes elsewhere.
  const [search, setSearch] = useState(filter.search);
  useEffect(() => setSearch(filter.search), [filter.search]);

  const filtersActive = isFilterActive(filter);
  const sorted = !isManualOrder(sort);
  const anythingActive = filtersActive || sorted;

  const clearAll = () => {
    setSearch('');
    onClearAll();
  };

  return (
    <div className="rounded-card border border-border bg-surface p-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              onFilterChange({ ...filter, search: e.target.value });
            }}
            placeholder="Search findings…"
            aria-label="Search findings by title, description or affected target"
          />
        </div>

        <SeverityFilter
          severities={filter.severities}
          unrated={filter.unrated}
          onChange={(next) => onFilterChange({ ...filter, ...next })}
        />
        <KindFilter
          value={filter.kinds}
          onChange={(kinds) => onFilterChange({ ...filter, kinds })}
        />
        <CategoryFilter
          categories={categoryNames}
          value={filter.categories}
          uncategorized={filter.uncategorized}
          onChange={(next) => onFilterChange({ ...filter, ...next })}
        />
        <FixEffortFilter
          value={filter.fixEfforts}
          onChange={(fixEfforts) => onFilterChange({ ...filter, fixEfforts })}
        />
        <TargetFilter
          targets={facets.targets}
          value={filter.affectedTargets}
          onChange={(affectedTargets) => onFilterChange({ ...filter, affectedTargets })}
        />
        <StandardsFilter
          name="ISO 21434"
          catalog={ISO_21434_WORK_PRODUCTS}
          availableRefs={facets.iso21434Refs}
          mapping={filter.iso21434}
          refs={filter.iso21434Refs}
          onChange={(next) =>
            onFilterChange({ ...filter, iso21434: next.mapping, iso21434Refs: next.refs })
          }
        />
        <StandardsFilter
          name="UN R155"
          catalog={UN_R155_REQUIREMENTS}
          availableRefs={facets.unr155Refs}
          mapping={filter.unr155}
          refs={filter.unr155Refs}
          onChange={(next) =>
            onFilterChange({ ...filter, unr155: next.mapping, unr155Refs: next.refs })
          }
        />
        <TriStateFilter
          value={filter.readyToReport}
          onChange={(readyToReport) => onFilterChange({ ...filter, readyToReport })}
          label="Filter by report readiness"
          anyLabel="Any readiness"
          yesLabel="Ready to report"
          noLabel="Not ready"
        />
        <TriStateFilter
          value={filter.hasEvidence}
          onChange={(hasEvidence) => onFilterChange({ ...filter, hasEvidence })}
          label="Filter by linked evidence"
          anyLabel="Any evidence"
          yesLabel="Has evidence"
          noLabel="No evidence"
        />
        <TriStateFilter
          value={filter.hasRecommendations}
          onChange={(hasRecommendations) => onFilterChange({ ...filter, hasRecommendations })}
          label="Filter by strategic recommendations"
          anyLabel="Any recommendations"
          yesLabel="Has recommendations"
          noLabel="No recommendations"
        />

        <div className="ml-auto">
          <FindingsSortControls sort={sort} onChange={onSortChange} />
        </div>
      </div>

      <div className="mt-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {filtersActive && <ActiveFindingFilterChips filter={filter} onChange={onFilterChange} />}
        </div>
        <div className="flex flex-none items-center gap-2">
          {/* One live region for both the count and the ordering, so a screen
              reader hears the result of a filter or sort change once. */}
          <p role="status" aria-live="polite" className="text-xs text-muted">
            {filtersActive ? `${shown} of ${total} findings` : `${total} findings`}
            {` · sorted by ${FINDING_SORT_LABELS[sort.key].toLowerCase()}, `}
            {sort.dir === 'asc' ? 'ascending' : 'descending'}
            {reorderHint && ` · ${reorderHint}`}
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
