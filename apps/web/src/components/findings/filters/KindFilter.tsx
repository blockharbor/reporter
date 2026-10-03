import { useState } from 'react';
import { Badge, Button, Checkbox, Popover } from '@reporter/ui';
import { FINDING_KINDS, FINDING_KIND_LABELS, type FindingKind } from '@reporter/shared';

/** Weakness / Strength multi-select. Selecting both reads the same as neither. */
export function KindFilter({
  value,
  onChange,
}: {
  value: FindingKind[];
  onChange: (kinds: FindingKind[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = new Set(value);

  const toggle = (k: FindingKind) => {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onChange(FINDING_KINDS.filter((x) => next.has(x)));
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Filter by finding kind"
      trigger={
        <Button variant="secondary" size="sm">
          Kind
          {value.length > 0 && <Badge tone="accent">{value.length}</Badge>}
        </Button>
      }
    >
      <div className="flex w-44 flex-col gap-1.5 p-1">
        {FINDING_KINDS.map((k) => (
          <Checkbox
            key={k}
            id={`kind-${k}`}
            label={FINDING_KIND_LABELS[k]}
            checked={selected.has(k)}
            onChange={() => toggle(k)}
          />
        ))}
      </div>
    </Popover>
  );
}
