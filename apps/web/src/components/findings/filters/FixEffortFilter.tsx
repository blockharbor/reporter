import { useState } from 'react';
import { Badge, Button, Checkbox, Popover } from '@reporter/ui';
import { FIX_EFFORTS, FIX_EFFORT_LABELS, type FixEffort } from '@reporter/shared';

/** Multi-select over the estimated-remediation-effort enum. */
export function FixEffortFilter({
  value,
  onChange,
}: {
  value: FixEffort[];
  onChange: (efforts: FixEffort[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = new Set(value);

  const toggle = (e: FixEffort) => {
    const next = new Set(selected);
    if (next.has(e)) next.delete(e);
    else next.add(e);
    onChange(FIX_EFFORTS.filter((x) => next.has(x)));
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Filter by fix effort"
      trigger={
        <Button variant="secondary" size="sm">
          Fix effort
          {value.length > 0 && <Badge tone="accent">{value.length}</Badge>}
        </Button>
      }
    >
      <div className="flex w-44 flex-col gap-1.5 p-1">
        {FIX_EFFORTS.map((e) => (
          <Checkbox
            key={e}
            id={`effort-${e}`}
            label={FIX_EFFORT_LABELS[e]}
            checked={selected.has(e)}
            onChange={() => toggle(e)}
          />
        ))}
      </div>
    </Popover>
  );
}
