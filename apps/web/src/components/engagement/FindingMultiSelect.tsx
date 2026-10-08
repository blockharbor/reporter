import { Link } from 'react-router-dom';
import { Badge, SeverityBadge, Select } from '@reporter/ui';
import type { Finding } from '@reporter/shared';

/**
 * Multi-select for linking a strategic recommendation to the findings it
 * addresses. Selected findings show as removable chips; a dropdown adds more.
 * Findings are referenced by `uuid`, so a link survives reordering/renaming and a
 * deleted finding surfaces as a removable "Removed finding" chip.
 *
 * Each chip's title opens that finding. The three hit areas stay separate so
 * navigating can't be mistaken for editing: linking happens in the dropdown below,
 * unlinking on the chip's own ✕, and only the title text is a link.
 */
export function FindingMultiSelect({
  slug,
  findings,
  selected,
  onChange,
  disabled,
  disabledTitle,
  id,
}: {
  slug: string;
  findings: Finding[];
  selected: string[];
  onChange: (uuids: string[]) => void;
  disabled?: boolean;
  disabledTitle?: string;
  /** id for the "add" <select>, so a <Field label> can point at it. */
  id?: string;
}) {
  const byUuid = new Map(findings.map((f) => [f.uuid, f]));
  const selectedSet = new Set(selected);
  const available = findings.filter((f) => !selectedSet.has(f.uuid));

  const add = (uuid: string) => {
    if (!uuid || selectedSet.has(uuid)) return;
    onChange([...selected, uuid]);
  };
  const remove = (uuid: string) => onChange(selected.filter((u) => u !== uuid));

  if (findings.length === 0) {
    return (
      <p className="text-sm text-warning">
        No findings yet — create a finding first, then link it here. Every recommendation must
        address at least one finding.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((uuid) => {
            const f = byUuid.get(uuid);
            return (
              <li key={uuid}>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 py-0.5 pl-2 pr-1 text-xs">
                  {f ? (
                    <>
                      <SeverityBadge severity={f.severity} className="!px-1.5" />
                      <Link
                        to={`/engagements/${slug}/findings/${f.uuid}`}
                        title={`Open “${f.title}”`}
                        className="max-w-[16rem] truncate rounded text-text hover:text-accent hover:underline"
                      >
                        {f.title}
                      </Link>
                    </>
                  ) : (
                    <Badge tone="warning">Removed finding</Badge>
                  )}
                  {!disabled && (
                    <button
                      type="button"
                      onClick={() => remove(uuid)}
                      aria-label={f ? `Unlink ${f.title}` : 'Remove deleted finding'}
                      title="Unlink finding"
                      className="rounded px-1 text-muted hover:text-danger"
                    >
                      ✕
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Select
        id={id}
        value=""
        disabled={disabled || available.length === 0}
        title={disabledTitle}
        aria-label="Link a finding"
        onChange={(e) => {
          add(e.target.value);
          e.target.value = '';
        }}
      >
        <option value="">
          {available.length === 0 ? 'All findings linked' : '＋ Link a finding…'}
        </option>
        {available.map((f) => (
          <option key={f.uuid} value={f.uuid}>
            {f.severity ? `[${f.severity}] ` : ''}
            {f.title}
          </option>
        ))}
      </Select>
    </div>
  );
}
