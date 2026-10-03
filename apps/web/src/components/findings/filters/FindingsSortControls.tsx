import { Button, Select } from '@reporter/ui';
import {
  DEFAULT_SORT_DIR,
  FINDING_SORT_KEYS,
  FINDING_SORT_LABELS,
  type FindingSortKey,
  type FindingsSort,
} from '../findings-filter.js';

/**
 * Sort key + direction for the findings list. Picking a key applies that key's
 * natural first direction (worst/most/newest first for the quantitative keys,
 * A→Z for the title) rather than keeping whatever the previous key used.
 *
 * Manual order is the stored report order, and the only one in which findings may
 * be dragged — see `isManualOrder`.
 */
export function FindingsSortControls({
  sort,
  onChange,
}: {
  sort: FindingsSort;
  onChange: (next: FindingsSort) => void;
}) {
  const ascending = sort.dir === 'asc';
  return (
    <div className="flex items-center gap-1">
      <div className="w-40">
        <Select
          value={sort.key}
          onChange={(e) => {
            const key = e.target.value as FindingSortKey;
            onChange({ key, dir: DEFAULT_SORT_DIR[key] });
          }}
          aria-label="Sort findings by"
        >
          {FINDING_SORT_KEYS.map((k) => (
            <option key={k} value={k}>
              {FINDING_SORT_LABELS[k]}
            </option>
          ))}
        </Select>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onChange({ ...sort, dir: ascending ? 'desc' : 'asc' })}
        aria-label={`Sorted ${ascending ? 'ascending' : 'descending'}; switch to ${
          ascending ? 'descending' : 'ascending'
        }`}
        title={`Sorted ${ascending ? 'ascending' : 'descending'}`}
      >
        <span aria-hidden="true">{ascending ? '▲' : '▼'}</span>
      </Button>
    </div>
  );
}
