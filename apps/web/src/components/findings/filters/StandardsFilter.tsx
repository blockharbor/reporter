import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Input, Popover, Select } from '@reporter/ui';
import type { StandardRef } from '@reporter/shared';
import type { MappingFilter } from '../findings-filter.js';

/**
 * Standards-mapping filter for one catalog (ISO/SAE 21434 or UN R155).
 *
 * The catalogs run to dozens of entries, most of which no engagement will ever
 * map, so the panel offers the two questions that are useful on a whole
 * engagement — "mapped to anything at all?" / "not mapped?" — plus a searchable
 * list of only the references actually present on the loaded findings. Ids that
 * aren't in the catalog (a legacy mapping) are still listed, by raw id, so a
 * stored mapping is never invisible.
 */
export function StandardsFilter({
  name,
  catalog,
  availableRefs,
  mapping,
  refs,
  onChange,
}: {
  /** Short standard name, used in the trigger and the accessible labels. */
  name: string;
  catalog: readonly StandardRef[];
  /** Reference ids present on at least one loaded finding, in catalog order. */
  availableRefs: string[];
  mapping: MappingFilter | undefined;
  refs: string[];
  onChange: (next: { mapping: MappingFilter | undefined; refs: string[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = new Set(refs);
  const count = refs.length + (mapping ? 1 : 0);

  const byId = useMemo(() => new Map(catalog.map((r) => [r.id, r])), [catalog]);
  const labelFor = (id: string) => {
    const ref = byId.get(id);
    return ref ? `${ref.clause} — ${ref.label}` : id;
  };

  // Search covers the clause, the label and the grouping heading, so "annex 5" or
  // "15.6" both find their entries.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return availableRefs;
    return availableRefs.filter((id) => {
      const ref = byId.get(id);
      const haystack = ref ? `${ref.clause} ${ref.label} ${ref.group}` : id;
      return haystack.toLowerCase().includes(q);
    });
  }, [availableRefs, search, byId]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Picking a specific reference contradicts "not mapped", so that constraint
    // steps aside rather than silently emptying the list.
    const nextRefs = availableRefs.filter((r) => next.has(r));
    const keepMapping = mapping === 'none' && nextRefs.length > 0 ? undefined : mapping;
    onChange({ mapping: keepMapping, refs: nextRefs });
  };

  const setMapping = (value: string) => {
    const next = value === 'any' || value === 'none' ? value : undefined;
    // "Not mapped" and a specific reference can never both hold; drop the refs.
    onChange({ mapping: next, refs: next === 'none' ? [] : refs });
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={`Filter by ${name} mapping`}
      trigger={
        <Button variant="secondary" size="sm">
          {name}
          {count > 0 && <Badge tone="accent">{count}</Badge>}
        </Button>
      }
    >
      <div className="flex w-80 max-w-[90vw] flex-col gap-2 p-1">
        <Select
          value={mapping ?? 'all'}
          onChange={(e) => setMapping(e.target.value)}
          aria-label={`${name} mapping`}
        >
          <option value="all">Any mapping state</option>
          <option value="any">Mapped to {name}</option>
          <option value="none">Not mapped to {name}</option>
        </Select>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search references…"
          aria-label={`Search ${name} references`}
        />
        <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
          {availableRefs.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted">No finding maps a {name} reference yet.</p>
          ) : filtered.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted">No references found.</p>
          ) : (
            filtered.map((id) => (
              <Checkbox
                key={id}
                id={`std-${id}`}
                className="items-start"
                label={labelFor(id)}
                title={labelFor(id)}
                checked={selected.has(id)}
                onChange={() => toggle(id)}
              />
            ))
          )}
        </div>
        <p className="text-xs text-muted">References mapped on this engagement’s findings.</p>
      </div>
    </Popover>
  );
}
