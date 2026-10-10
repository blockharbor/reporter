import { Badge } from './Badge.js';

export interface FilterChipProps {
  /** What the chip says, e.g. "Action: Updated"; also names the remove button. */
  label: string;
  /** Hover text for the label, for a value that was folded or abbreviated. */
  title?: string;
  onRemove: () => void;
}

/**
 * One active filter as a removable accent pill: the evidence, findings and
 * audit bars all draw their chips with it, so the three cannot drift. The
 * remove control is a real button named after the chip, for keyboards and
 * screen readers alike.
 */
export function FilterChip({ label, title, onRemove }: FilterChipProps) {
  return (
    <Badge tone="accent" className="pr-1">
      <span title={title}>{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="ml-0.5 rounded-full px-1 leading-none opacity-80 hover:opacity-100"
      >
        ×
      </button>
    </Badge>
  );
}
