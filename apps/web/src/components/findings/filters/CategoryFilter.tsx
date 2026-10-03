import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Input, Popover } from '@reporter/ui';

/** The label used everywhere a finding has no category (matches the list rows). */
export const UNCATEGORIZED_LABEL = 'Uncategorized';

/** Category names are free text, so derive a DOM-safe id for each option. */
const optionId = (category: string) => `cat-${category.replace(/\s+/g, '-').toLowerCase()}`;

/**
 * Searchable multi-select over the engagement's finding categories. `category` is
 * nullable, so "Uncategorized" is pinned at the top as its own option; it is never
 * hidden by the search box, which only narrows the real categories.
 */
export function CategoryFilter({
  categories,
  value,
  uncategorized,
  onChange,
}: {
  /** Every selectable category (the engagement's list, plus any value already selected). */
  categories: string[];
  value: string[];
  uncategorized: boolean;
  onChange: (next: { categories: string[]; uncategorized: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = new Set(value);
  const count = value.length + (uncategorized ? 1 : 0);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.toLowerCase().includes(q));
  }, [categories, search]);

  const toggle = (category: string) => {
    const next = new Set(selected);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    // Keep the option list's order so the URL doesn't churn on re-selection.
    onChange({ categories: categories.filter((c) => next.has(c)), uncategorized });
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Filter by category"
      trigger={
        <Button variant="secondary" size="sm">
          Category
          {count > 0 && <Badge tone="accent">{count}</Badge>}
        </Button>
      }
    >
      <div className="flex w-60 flex-col gap-2 p-1">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search categories…"
          aria-label="Search categories"
        />
        <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
          <Checkbox
            id="cat-none"
            label={UNCATEGORIZED_LABEL}
            checked={uncategorized}
            onChange={() => onChange({ categories: value, uncategorized: !uncategorized })}
          />
          {filtered.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted">No categories found.</p>
          ) : (
            filtered.map((c) => (
              <Checkbox
                key={c}
                id={optionId(c)}
                label={c}
                checked={selected.has(c)}
                onChange={() => toggle(c)}
              />
            ))
          )}
        </div>
      </div>
    </Popover>
  );
}
