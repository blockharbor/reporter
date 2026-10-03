import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Input, Popover } from '@reporter/ui';

/** Targets are free text, so derive a DOM-safe id for each option. */
const optionId = (target: string) => `target-${target.replace(/\s+/g, '-').toLowerCase()}`;

/**
 * Searchable multi-select over the affected targets actually present on the loaded
 * findings. `affectedTarget` is free text with no catalog behind it, so the option
 * list can only be derived from the data (see `deriveFindingFacets`).
 */
export function TargetFilter({
  targets,
  value,
  onChange,
}: {
  targets: string[];
  value: string[];
  onChange: (targets: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = new Set(value);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) => t.toLowerCase().includes(q));
  }, [targets, search]);

  const toggle = (target: string) => {
    const next = new Set(selected);
    if (next.has(target)) next.delete(target);
    else next.add(target);
    onChange(targets.filter((t) => next.has(t)));
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Filter by affected target"
      trigger={
        <Button variant="secondary" size="sm">
          Target
          {value.length > 0 && <Badge tone="accent">{value.length}</Badge>}
        </Button>
      }
    >
      <div className="flex w-64 flex-col gap-2 p-1">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search targets…"
          aria-label="Search affected targets"
        />
        <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted">
              {targets.length === 0
                ? 'No finding names an affected target yet.'
                : 'No targets found.'}
            </p>
          ) : (
            filtered.map((t) => (
              <Checkbox
                key={t}
                id={optionId(t)}
                label={t}
                checked={selected.has(t)}
                onChange={() => toggle(t)}
              />
            ))
          )}
        </div>
      </div>
    </Popover>
  );
}
