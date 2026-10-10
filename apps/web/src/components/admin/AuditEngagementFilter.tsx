import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Input, Popover } from '@reporter/ui';
import {
  DELETED_ENGAGEMENT_LABEL,
  NO_ENGAGEMENT_LABEL,
  type AuditEngagementOption,
} from '@reporter/shared';
import type { AuditFilterState } from '../audit/audit-filter.js';

/** The two facet values this control owns, lifted straight out of the filter state. */
export type AuditEngagementSelection = Pick<AuditFilterState, 'engagements' | 'noEngagement'>;

export interface AuditEngagementFilterProps {
  value: AuditEngagementSelection;
  /**
   * `facets.engagements` from the site-wide facets payload — live engagements
   * under their current names, deleted ones under the name and slug the log
   * snapshotted. Undefined while the facets are loading.
   */
  options: AuditEngagementOption[] | undefined;
  onChange: (next: AuditEngagementSelection) => void;
}

/**
 * The Admin tab's leading facet: which engagement an entry belongs to. Admin-
 * only, because the engagement tab's facets never carry an `engagements` list
 * (a writer must not enumerate the server's engagements through their own
 * tab). Modelled on the step-8 ActorFilter — a searchable Popover of
 * checkboxes — with three fixed groups:
 *
 *  1. **No engagement**, first, as an explicit boolean (`noEngagement`) rather
 *     than a sentinel slug, like the findings bar's `unrated`/`uncategorized`.
 *     It is the facet an admin reaches for to see sign-ins and admin changes,
 *     so it is pinned at the top of the list and never narrowed by the search
 *     (the CategoryFilter shape: the search box still comes first and takes
 *     focus when the popover opens).
 *  2. Live engagements, in the order the facets give them (by name).
 *  3. **Deleted engagements**: the snapshot slugs whose engagement is gone.
 *     Any selected slug the facets know nothing about (a deep link, or a stale
 *     URL after every entry under that slug was removed) is unioned into this
 *     group under its slug, so the deep link never loses its checkbox or chip.
 *
 * Slugs are emitted in option order whatever the click order, so the URL is
 * stable and two admins sharing the same view share the same link.
 */
export function AuditEngagementFilter({ value, options, onChange }: AuditEngagementFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = new Set(value.engagements);

  const { live, gone, ordered } = useMemo(() => {
    const known = options ?? [];
    const live = known.filter((o) => !o.deleted);
    const seen = new Set(known.map((o) => o.slug));
    const extra = value.engagements
      .filter((slug) => !seen.has(slug))
      .map((slug): AuditEngagementOption => ({ slug, name: slug, deleted: true }));
    const gone = [...known.filter((o) => o.deleted), ...extra];
    return { live, gone, ordered: [...live, ...gone] };
  }, [options, value.engagements]);

  const q = search.trim().toLowerCase();
  const matches = (o: AuditEngagementOption) =>
    q === '' || o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q);
  const liveShown = live.filter(matches);
  const goneShown = gone.filter(matches);

  const toggle = (slug: string) => {
    const next = new Set(selected);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    onChange({
      engagements: ordered.filter((o) => next.has(o.slug)).map((o) => o.slug),
      noEngagement: value.noEngagement,
    });
  };

  const count = value.engagements.length + (value.noEngagement ? 1 : 0);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Filter by engagement"
      trigger={
        <Button variant="secondary" size="sm">
          Engagement
          {count > 0 && <Badge tone="accent">{count}</Badge>}
        </Button>
      }
    >
      <div className="flex w-72 flex-col gap-2 p-1">
        {/* Search first, like every searchable facet, so the popover opens on it;
            the pinned row sits at the top of the list and is never narrowed. */}
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or slug…"
          aria-label="Search engagements"
        />
        <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
          <div className="flex flex-col gap-0.5">
            <Checkbox
              id="audit-eng-none"
              label={NO_ENGAGEMENT_LABEL}
              checked={value.noEngagement}
              onChange={() =>
                onChange({ engagements: value.engagements, noEngagement: !value.noEngagement })
              }
            />
            <span className="pl-6 text-xs text-muted">Sign-ins and admin changes</span>
          </div>
          {liveShown.map((o) => (
            <Checkbox
              key={`live-${o.slug}`}
              // Prefixed per group: a deleted engagement's slug can be reissued
              // to a live one, and the two rows must not share an id.
              id={`audit-eng-live-${o.slug}`}
              label={o.name}
              checked={selected.has(o.slug)}
              onChange={() => toggle(o.slug)}
            />
          ))}
          {goneShown.length > 0 && (
            <div
              role="group"
              aria-labelledby="audit-eng-deleted-heading"
              className="mt-1 flex flex-col gap-1.5 border-t border-border pt-2"
            >
              <p
                id="audit-eng-deleted-heading"
                className="text-xs font-medium uppercase tracking-wide text-muted"
              >
                {DELETED_ENGAGEMENT_LABEL}s
              </p>
              {goneShown.map((o) => (
                <div key={`gone-${o.slug}`} className="flex flex-col gap-0.5">
                  <Checkbox
                    id={`audit-eng-gone-${o.slug}`}
                    label={o.name}
                    checked={selected.has(o.slug)}
                    onChange={() => toggle(o.slug)}
                  />
                  {o.slug !== o.name && <span className="pl-6 text-xs text-muted">{o.slug}</span>}
                </div>
              ))}
            </div>
          )}
          {liveShown.length === 0 && goneShown.length === 0 && (
            <p className="px-1 py-2 text-sm text-muted">
              {ordered.length === 0 ? 'No engagement has entries yet.' : 'No engagement matches.'}
            </p>
          )}
        </div>
      </div>
    </Popover>
  );
}
