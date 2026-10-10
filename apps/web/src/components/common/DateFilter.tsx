import { useState } from 'react';
import { Badge, Button, DateRangePicker, Popover } from '@reporter/ui';
import type { DateRange } from '@reporter/shared';

/**
 * Date-range popover, backed by the shared DateRangePicker, emitting the shared
 * `DateRange` (`YYYY-MM-DD`, either side open). The evidence bar reads it as
 * occurred-at and the audit bar as recorded-at; the control is the same, so
 * it lives here rather than as a twin in each module.
 */
export function DateFilter({
  value,
  onChange,
}: {
  value?: DateRange;
  onChange: (range: DateRange | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = Boolean(value && (value.from || value.to));

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label="Filter by date"
      trigger={
        <Button variant="secondary" size="sm">
          Date
          {active && <Badge tone="accent">1</Badge>}
        </Button>
      }
    >
      <div className="w-72 p-1">
        <DateRangePicker value={value} onChange={onChange} />
      </div>
    </Popover>
  );
}
