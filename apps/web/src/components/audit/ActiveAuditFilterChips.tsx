import { FilterChip } from '@reporter/ui';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_TYPE_LABELS,
  AUDIT_VIA_LABELS,
  NO_ENGAGEMENT_LABEL,
  SYSTEM_ACTOR_LABEL,
  type AuditAction,
  type AuditEntityType,
  type AuditFacets,
  type DateRange,
} from '@reporter/shared';
import type { AuditFilterState } from './audit-filter.js';

/** A readable short date from a YYYY-MM-DD string, in local time. */
function formatYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatRangeLabel(r: DateRange): string {
  if (r.from && r.to && r.from !== r.to) return `${formatYmd(r.from)} – ${formatYmd(r.to)}`;
  if (r.from && r.to) return formatYmd(r.from);
  if (r.from) return `from ${formatYmd(r.from)}`;
  if (r.to) return `until ${formatYmd(r.to)}`;
  return 'Any date';
}

/** The literal `?actor=` value for rows with no human actor (audit-query.ts). */
const SYSTEM_ACTOR_VALUE = 'system';

/**
 * One removable chip per active audit constraint, in the order of the controls
 * in the bar. Free text is not chipped — it stays visible in the search box —
 * and neither is the sort, which the status line already names. Labels come
 * from the facets when they can (a user's current name, an engagement's name)
 * and fall back to the raw value, so a chip never goes blank for a stale link.
 */
export function ActiveAuditFilterChips({
  filter,
  facets,
  onChange,
}: {
  filter: AuditFilterState;
  facets: AuditFacets | undefined;
  onChange: (next: AuditFilterState) => void;
}) {
  const actorLabel = (value: string): string => {
    if (value === SYSTEM_ACTOR_VALUE) return SYSTEM_ACTOR_LABEL;
    return facets?.actors.find((a) => a.value === value)?.label ?? value;
  };
  const engagementLabel = (slug: string): string =>
    facets?.engagements?.find((e) => e.slug === slug)?.name ?? slug;

  const removeEngagement = (slug: string) =>
    onChange({ ...filter, engagements: filter.engagements.filter((x) => x !== slug) });
  const removeActor = (v: string) =>
    onChange({ ...filter, actors: filter.actors.filter((x) => x !== v) });
  const removeAction = (a: AuditAction) =>
    onChange({ ...filter, actions: filter.actions.filter((x) => x !== a) });
  const removeEntityType = (t: AuditEntityType) =>
    onChange({ ...filter, entityTypes: filter.entityTypes.filter((x) => x !== t) });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filter.engagements.map((slug) => (
        <FilterChip
          key={`eng-${slug}`}
          label={`Engagement: ${engagementLabel(slug)}`}
          title={slug}
          onRemove={() => removeEngagement(slug)}
        />
      ))}
      {filter.noEngagement && (
        <FilterChip
          label={NO_ENGAGEMENT_LABEL}
          onRemove={() => onChange({ ...filter, noEngagement: false })}
        />
      )}
      {filter.actors.map((v) => (
        <FilterChip
          key={`actor-${v}`}
          label={`Who: ${actorLabel(v)}`}
          title={v}
          onRemove={() => removeActor(v)}
        />
      ))}
      {filter.actions.map((a) => (
        <FilterChip
          key={`action-${a}`}
          label={`Action: ${AUDIT_ACTION_LABELS[a]}`}
          onRemove={() => removeAction(a)}
        />
      ))}
      {filter.entityTypes.map((t) => (
        <FilterChip
          key={`entity-${t}`}
          label={`What: ${AUDIT_ENTITY_TYPE_LABELS[t]}`}
          onRemove={() => removeEntityType(t)}
        />
      ))}
      {filter.via !== undefined && (
        <FilterChip
          label={`Via: ${AUDIT_VIA_LABELS[filter.via]}`}
          onRemove={() => onChange({ ...filter, via: undefined })}
        />
      )}
      {filter.entityId !== undefined && (
        <FilterChip
          label={`Record: ${
            filter.entityId.length > 12 ? `${filter.entityId.slice(0, 8)}…` : filter.entityId
          }`}
          title={filter.entityId}
          onRemove={() => onChange({ ...filter, entityId: undefined })}
        />
      )}
      {filter.dateRange !== undefined && (
        <FilterChip
          label={`Date: ${formatRangeLabel(filter.dateRange)}`}
          onRemove={() => onChange({ ...filter, dateRange: undefined })}
        />
      )}
    </div>
  );
}
