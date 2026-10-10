import { FilterChip } from '@reporter/ui';
import {
  FINDING_KIND_LABELS,
  FIX_EFFORT_LABELS,
  SEVERITY_LABELS,
  iso21434Ref,
  unr155Ref,
  type FindingKind,
  type FixEffort,
  type Severity,
} from '@reporter/shared';
import { UNCATEGORIZED_LABEL } from './filters/CategoryFilter.js';
import type { FindingsFilterState, MappingFilter } from './findings-filter.js';

const mappingLabel = (standard: string, mapping: MappingFilter): string =>
  mapping === 'any' ? `${standard}: mapped` : `${standard}: not mapped`;

/**
 * One removable chip per active findings constraint, in the same order as the
 * controls in the bar. Free text is not chipped — it stays visible in the search
 * box — and neither is the sort, which the Sort control already shows.
 */
export function ActiveFindingFilterChips({
  filter,
  onChange,
}: {
  filter: FindingsFilterState;
  onChange: (next: FindingsFilterState) => void;
}) {
  const removeSeverity = (s: Severity) =>
    onChange({ ...filter, severities: filter.severities.filter((x) => x !== s) });
  const removeKind = (k: FindingKind) =>
    onChange({ ...filter, kinds: filter.kinds.filter((x) => x !== k) });
  const removeCategory = (c: string) =>
    onChange({ ...filter, categories: filter.categories.filter((x) => x !== c) });
  const removeTag = (t: string) =>
    onChange({ ...filter, tags: filter.tags.filter((x) => x !== t) });
  const removeEffort = (e: FixEffort) =>
    onChange({ ...filter, fixEfforts: filter.fixEfforts.filter((x) => x !== e) });
  const removeTarget = (t: string) =>
    onChange({ ...filter, affectedTargets: filter.affectedTargets.filter((x) => x !== t) });
  const removeIsoRef = (id: string) =>
    onChange({ ...filter, iso21434Refs: filter.iso21434Refs.filter((x) => x !== id) });
  const removeUnrRef = (id: string) =>
    onChange({ ...filter, unr155Refs: filter.unr155Refs.filter((x) => x !== id) });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filter.severities.map((s) => (
        <FilterChip
          key={`sev-${s}`}
          label={`Severity: ${SEVERITY_LABELS[s]}`}
          onRemove={() => removeSeverity(s)}
        />
      ))}
      {filter.unrated && (
        <FilterChip
          label="Severity: Unrated"
          onRemove={() => onChange({ ...filter, unrated: false })}
        />
      )}
      {filter.kinds.map((k) => (
        <FilterChip
          key={`kind-${k}`}
          label={`Kind: ${FINDING_KIND_LABELS[k]}`}
          onRemove={() => removeKind(k)}
        />
      ))}
      {filter.categories.map((c) => (
        <FilterChip key={`cat-${c}`} label={`Category: ${c}`} onRemove={() => removeCategory(c)} />
      ))}
      {filter.uncategorized && (
        <FilterChip
          label={`Category: ${UNCATEGORIZED_LABEL}`}
          onRemove={() => onChange({ ...filter, uncategorized: false })}
        />
      )}
      {filter.tags.map((t) => (
        <FilterChip key={`tag-${t}`} label={`Tag: ${t}`} onRemove={() => removeTag(t)} />
      ))}
      {filter.readyToReport !== undefined && (
        <FilterChip
          label={filter.readyToReport ? 'Ready to report' : 'Not ready to report'}
          onRemove={() => onChange({ ...filter, readyToReport: undefined })}
        />
      )}
      {filter.fixEfforts.map((e) => (
        <FilterChip
          key={`effort-${e}`}
          label={`Fix effort: ${FIX_EFFORT_LABELS[e]}`}
          onRemove={() => removeEffort(e)}
        />
      ))}
      {filter.hasEvidence !== undefined && (
        <FilterChip
          label={filter.hasEvidence ? 'Has linked evidence' : 'No linked evidence'}
          onRemove={() => onChange({ ...filter, hasEvidence: undefined })}
        />
      )}
      {filter.hasRecommendations !== undefined && (
        <FilterChip
          label={
            filter.hasRecommendations
              ? 'Has strategic recommendation'
              : 'No strategic recommendation'
          }
          onRemove={() => onChange({ ...filter, hasRecommendations: undefined })}
        />
      )}
      {filter.affectedTargets.map((t) => (
        <FilterChip key={`target-${t}`} label={`Target: ${t}`} onRemove={() => removeTarget(t)} />
      ))}
      {filter.iso21434 !== undefined && (
        <FilterChip
          label={mappingLabel('ISO 21434', filter.iso21434)}
          onRemove={() => onChange({ ...filter, iso21434: undefined })}
        />
      )}
      {filter.iso21434Refs.map((id) => (
        <FilterChip
          key={`iso-${id}`}
          // An unknown (legacy) id has no catalog entry; show the raw id rather
          // than hiding a constraint that is really applied.
          label={`ISO 21434: ${iso21434Ref(id)?.clause ?? id}`}
          onRemove={() => removeIsoRef(id)}
        />
      ))}
      {filter.unr155 !== undefined && (
        <FilterChip
          label={mappingLabel('UN R155', filter.unr155)}
          onRemove={() => onChange({ ...filter, unr155: undefined })}
        />
      )}
      {filter.unr155Refs.map((id) => (
        <FilterChip
          key={`unr-${id}`}
          label={`UN R155: ${unr155Ref(id)?.clause ?? id}`}
          onRemove={() => removeUnrRef(id)}
        />
      ))}
    </div>
  );
}
