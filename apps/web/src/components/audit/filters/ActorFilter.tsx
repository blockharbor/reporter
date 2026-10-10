import { useId, useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Input, Popover } from '@reporter/ui';
import { DELETED_USER_LABEL, type AuditActorOption } from '@reporter/shared';

/**
 * Searchable multi-select over the actors the facets endpoint offers. Values
 * are whatever the facet hands back — a live user's slug, a deleted user's
 * snapshotted email, or the literal `system` — and go to the server verbatim.
 * Modelled on the evidence bar's OperatorFilter.
 */
export function ActorFilter({
  value,
  actors,
  onChange,
}: {
  value: string[];
  actors: AuditActorOption[];
  onChange: (values: string[]) => void;
}) {
  // Per-instance prefix + option index: a value-derived id is lossy (two
  // values differing only in punctuation would share one id and one label).
  const idPrefix = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = new Set(value);

  // Any already-selected value missing from the list is unioned in, so a deep
  // link (or a stale URL after a user was deleted and the facet refolded) never
  // loses its chip or its checkbox.
  const options = useMemo(() => {
    const known = new Set(actors.map((a) => a.value));
    const extra = value
      .filter((v) => !known.has(v))
      .map((v): AuditActorOption => ({ value: v, label: v, email: null, deleted: false }));
    return [...actors, ...extra];
  }, [actors, value]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (a) => a.label.toLowerCase().includes(q) || (a.email ?? '').toLowerCase().includes(q),
    );
  }, [options, search]);

  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    // Emit in option order so the URL is stable whatever the click order.
    onChange(options.filter((a) => next.has(a.value)).map((a) => a.value));
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Filter by who"
      trigger={
        <Button variant="secondary" size="sm">
          Who
          {value.length > 0 && <Badge tone="accent">{value.length}</Badge>}
        </Button>
      }
    >
      <div className="flex w-64 flex-col gap-2 p-1">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email…"
          aria-label="Search actors"
        />
        <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted">
              {options.length === 0 ? 'No one has acted here yet.' : 'No one matches.'}
            </p>
          ) : (
            filtered.map((a, i) => (
              <div key={a.value} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${idPrefix}-actor-${i}`}
                    label={a.label}
                    checked={selected.has(a.value)}
                    onChange={() => toggle(a.value)}
                  />
                  {a.deleted && <Badge tone="neutral">{DELETED_USER_LABEL}</Badge>}
                </div>
                {a.email && a.email !== a.label && (
                  <span className="pl-6 text-xs text-muted">{a.email}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </Popover>
  );
}
