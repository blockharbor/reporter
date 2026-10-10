import { Button, FilterChip, TagChip, type PickableTag } from '@reporter/ui';
import {
  EVIDENCE_TYPE_LABELS,
  isEmptyQuery,
  type DateRange,
  type EvidenceType,
  type ParsedQuery,
} from '@reporter/shared';
import type { EvidenceOperator } from '../../api/hooks.js';

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
  if (r.from) return formatYmd(r.from);
  if (r.to) return formatYmd(r.to);
  return 'Any date';
}

/**
 * Renders one removable chip per active constraint, in the same canonical order
 * as `stringifyQuery` (tags, operators, types, dates, uuids, finding, starred,
 * comments), plus a
 * Clear-all action. Free-text and sort are not chipped — they live in the search
 * box and the Sort control respectively.
 */
export function ActiveFilterChips({
  parsed,
  tags,
  operators,
  onChange,
}: {
  parsed: ParsedQuery;
  tags: PickableTag[];
  operators: EvidenceOperator[];
  onChange: (next: ParsedQuery) => void;
}) {
  const hasChips =
    parsed.tags.length > 0 ||
    parsed.operators.length > 0 ||
    parsed.types.length > 0 ||
    parsed.dateRanges.length > 0 ||
    parsed.uuids.length > 0 ||
    parsed.withFinding !== undefined ||
    parsed.starred !== undefined ||
    parsed.noComments !== undefined;

  if (!hasChips) {
    return isEmptyQuery(parsed) ? (
      <p className="text-xs text-muted">Showing all evidence.</p>
    ) : null;
  }

  const tagColorByName = new Map(tags.map((t) => [t.name, t.colorName]));
  const opNameBySlug = new Map(
    operators.map((o) => [o.slug, `${o.firstName} ${o.lastName}`.trim() || o.slug]),
  );

  const removeTag = (name: string) =>
    onChange({ ...parsed, tags: parsed.tags.filter((t) => t !== name) });
  const removeOperator = (slug: string) =>
    onChange({ ...parsed, operators: parsed.operators.filter((o) => o !== slug) });
  const removeType = (type: EvidenceType) =>
    onChange({ ...parsed, types: parsed.types.filter((t) => t !== type) });
  const removeRange = (i: number) =>
    onChange({ ...parsed, dateRanges: parsed.dateRanges.filter((_, idx) => idx !== i) });
  const removeUuid = (u: string) =>
    onChange({ ...parsed, uuids: parsed.uuids.filter((x) => x !== u) });
  const clearFinding = () => onChange({ ...parsed, withFinding: undefined });
  const clearStarred = () => onChange({ ...parsed, starred: undefined });
  const clearNoComments = () => onChange({ ...parsed, noComments: undefined });

  const clearAll = () =>
    onChange({
      text: [],
      tags: [],
      operators: [],
      types: [],
      dateRanges: [],
      uuids: [],
      withFinding: undefined,
      starred: undefined,
      noComments: undefined,
      sortAsc: parsed.sortAsc,
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {parsed.tags.map((name) => (
        <TagChip
          key={`tag-${name}`}
          name={name}
          colorName={tagColorByName.get(name) ?? 'slate'}
          onRemove={() => removeTag(name)}
        />
      ))}
      {parsed.operators.map((slug) => (
        <FilterChip
          key={`op-${slug}`}
          label={`Operator: ${opNameBySlug.get(slug) ?? slug}`}
          onRemove={() => removeOperator(slug)}
        />
      ))}
      {parsed.types.map((type) => (
        <FilterChip
          key={`type-${type}`}
          label={`Type: ${EVIDENCE_TYPE_LABELS[type]}`}
          onRemove={() => removeType(type)}
        />
      ))}
      {parsed.dateRanges.map((r, i) => (
        <FilterChip
          key={`range-${i}`}
          label={formatRangeLabel(r)}
          onRemove={() => removeRange(i)}
        />
      ))}
      {parsed.uuids.map((u) => (
        <FilterChip
          key={`uuid-${u}`}
          label={`UUID: ${u.slice(0, 8)}…`}
          onRemove={() => removeUuid(u)}
        />
      ))}
      {parsed.withFinding !== undefined && (
        <FilterChip
          label={parsed.withFinding ? 'With a finding' : 'Without a finding'}
          onRemove={clearFinding}
        />
      )}
      {parsed.starred !== undefined && (
        <FilterChip label={parsed.starred ? 'Starred' : 'Not starred'} onRemove={clearStarred} />
      )}
      {parsed.noComments !== undefined && (
        <FilterChip label="Comments hidden" onRemove={clearNoComments} />
      )}
      <Button variant="ghost" size="sm" onClick={clearAll}>
        Clear all
      </Button>
    </div>
  );
}
