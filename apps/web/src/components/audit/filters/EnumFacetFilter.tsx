import { useState } from 'react';
import { Badge, Button, Checkbox, Popover } from '@reporter/ui';

/**
 * A multi-select over a closed vocabulary — the generic form of the findings
 * KindFilter. `options` is the list to offer, in canonical enum order (the
 * caller unions any already-selected value in, so a deep link never loses its
 * checkbox), and `labels` is the shared `*_LABELS` table for it; the component
 * never invents a word. Emits in option order so the URL is stable whatever
 * the click order.
 */
export function EnumFacetFilter<T extends string>({
  name,
  idPrefix,
  options,
  labels,
  value,
  onChange,
  label,
}: {
  /** The trigger's word, e.g. `Action`. */
  name: string;
  /** Checkbox id prefix, unique per bar, e.g. `audit-action`. */
  idPrefix: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T[];
  onChange: (next: T[]) => void;
  /** The popover's accessible name, e.g. `Filter by action`. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = new Set(value);

  const toggle = (v: T) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(options.filter((x) => next.has(x)));
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={label}
      trigger={
        <Button variant="secondary" size="sm">
          {name}
          {value.length > 0 && <Badge tone="accent">{value.length}</Badge>}
        </Button>
      }
    >
      <div className="flex max-h-72 w-52 flex-col gap-1.5 overflow-y-auto p-1">
        {options.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted">Nothing to filter by yet.</p>
        ) : (
          options.map((v) => (
            <Checkbox
              key={v}
              id={`${idPrefix}-${v}`}
              label={labels[v]}
              checked={selected.has(v)}
              onChange={() => toggle(v)}
            />
          ))
        )}
      </div>
    </Popover>
  );
}
