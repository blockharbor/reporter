import { useState, type ReactNode } from 'react';
import { Badge, Button, Checkbox, Popover, SeverityBadge } from '@reporter/ui';
import { SEVERITIES, type Severity } from '@reporter/shared';

/** Most severe first — the order an operator triages in. */
const DISPLAY_ORDER: readonly Severity[] = [...SEVERITIES].reverse();

/**
 * Severity multi-select. Severity is nullable on a finding, so "Unrated" is an
 * explicit option alongside the enum rather than an absence the user can't ask
 * for. Each option is labeled by a `SeverityBadge`, so the colors and words match
 * the badges in the list exactly.
 */
export function SeverityFilter({
  severities,
  unrated,
  onChange,
}: {
  severities: Severity[];
  unrated: boolean;
  onChange: (next: { severities: Severity[]; unrated: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = new Set(severities);
  const count = severities.length + (unrated ? 1 : 0);

  const toggle = (s: Severity) => {
    const next = new Set(selected);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    // Emit in canonical enum order, not click order, so the URL is stable.
    onChange({ severities: SEVERITIES.filter((x) => next.has(x)), unrated });
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Filter by severity"
      trigger={
        <Button variant="secondary" size="sm">
          Severity
          {count > 0 && <Badge tone="accent">{count}</Badge>}
        </Button>
      }
    >
      <div className="flex w-48 flex-col gap-1.5 p-1">
        {DISPLAY_ORDER.map((s) => (
          <Option
            key={s}
            id={`sev-${s}`}
            checked={selected.has(s)}
            onChange={() => toggle(s)}
            badge={<SeverityBadge severity={s} />}
          />
        ))}
        <Option
          id="sev-unrated"
          checked={unrated}
          onChange={() => onChange({ severities, unrated: !unrated })}
          badge={<SeverityBadge severity={null} />}
        />
      </div>
    </Popover>
  );
}

/**
 * One checkbox whose visible label is a badge. The badge sits in a sibling
 * `<label htmlFor>` (not wrapped around the Checkbox, which renders its own
 * label): the badge text becomes the checkbox's accessible name and clicking it
 * still toggles.
 */
function Option({
  id,
  checked,
  onChange,
  badge,
}: {
  id: string;
  checked: boolean;
  onChange: () => void;
  badge: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} label="" checked={checked} onChange={onChange} />
      <label htmlFor={id} className="cursor-pointer">
        {badge}
      </label>
    </div>
  );
}
