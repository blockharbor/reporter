/**
 * Findings-page filtering and sorting — the whole thing, as pure functions over
 * the already-fetched `Finding[]`. There is no server-side findings query: the
 * list route returns every finding in the engagement ordered by `position`, so
 * narrowing and ordering happen in the browser and nothing refetches.
 *
 * The state lives in the URL (see `parseFindingsParams` / `writeFindingsParams`)
 * so a filtered view is deep-linkable and survives a reload. This is deliberately
 * *not* the evidence query mini-language (`@reporter/shared`'s `parseQuery`) and
 * deliberately not wired into Saved Queries — findings filters are discrete,
 * readable params only.
 */

import {
  FINDING_KINDS,
  FIX_EFFORTS,
  ISO_21434_WORK_PRODUCTS,
  SEVERITIES,
  SEVERITY_RANK,
  UN_R155_REQUIREMENTS,
  type Finding,
  type FindingKind,
  type FixEffort,
  type Severity,
} from '@reporter/shared';
import type { SortDirection } from '@reporter/ui';

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

/** Three-way standards-mapping constraint: any mapping at all, or none. */
export const MAPPING_FILTERS = ['any', 'none'] as const;
export type MappingFilter = (typeof MAPPING_FILTERS)[number];

/**
 * Every findings facet, normalized. An empty array / `undefined` means "this
 * facet is not constraining anything"; facets combine with AND, values within one
 * facet with OR.
 *
 * Two facets are backed by nullable columns and so carry a separate "missing"
 * flag rather than a sentinel value in the list: `unrated` (severity is null) and
 * `uncategorized` (category is null or blank). A sentinel string would be
 * ambiguous for `categories`, whose values are user-authored free text.
 */
export interface FindingsFilterState {
  /** Free text, matched against title + description + affected target. */
  search: string;
  severities: Severity[];
  /** Include findings with no severity rating yet. */
  unrated: boolean;
  kinds: FindingKind[];
  categories: string[];
  /** Include findings with no category. */
  uncategorized: boolean;
  /** `true` = ready to report only, `false` = not-ready only. */
  readyToReport: boolean | undefined;
  fixEfforts: FixEffort[];
  /** `true` = has linked evidence, `false` = has none. */
  hasEvidence: boolean | undefined;
  affectedTargets: string[];
  /** Whether the finding carries any ISO/SAE 21434 mapping at all. */
  iso21434: MappingFilter | undefined;
  /** Specific ISO/SAE 21434 reference ids; a finding matches if it has any of them. */
  iso21434Refs: string[];
  unr155: MappingFilter | undefined;
  unr155Refs: string[];
}

export const EMPTY_FILTER: FindingsFilterState = {
  search: '',
  severities: [],
  unrated: false,
  kinds: [],
  categories: [],
  uncategorized: false,
  readyToReport: undefined,
  fixEfforts: [],
  hasEvidence: undefined,
  affectedTargets: [],
  iso21434: undefined,
  iso21434Refs: [],
  unr155: undefined,
  unr155Refs: [],
};

/** Is anything narrowing the list? Drives the chips row, the count and drag-gating. */
export function isFilterActive(f: FindingsFilterState): boolean {
  return (
    f.search.trim() !== '' ||
    f.severities.length > 0 ||
    f.unrated ||
    f.kinds.length > 0 ||
    f.categories.length > 0 ||
    f.uncategorized ||
    f.readyToReport !== undefined ||
    f.fixEfforts.length > 0 ||
    f.hasEvidence !== undefined ||
    f.affectedTargets.length > 0 ||
    f.iso21434 !== undefined ||
    f.iso21434Refs.length > 0 ||
    f.unr155 !== undefined ||
    f.unr155Refs.length > 0
  );
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

export const FINDING_SORT_KEYS = [
  'manual',
  'severity',
  'title',
  'created',
  'updated',
  'evidence',
  'goals',
] as const;
export type FindingSortKey = (typeof FINDING_SORT_KEYS)[number];

export const FINDING_SORT_LABELS: Record<FindingSortKey, string> = {
  manual: 'Manual order',
  severity: 'Severity',
  title: 'Title',
  created: 'Created',
  updated: 'Last updated',
  evidence: 'Linked evidence',
  goals: 'Linked goals',
};

export interface FindingsSort {
  key: FindingSortKey;
  dir: SortDirection;
}

/**
 * Direction a key gets when it is first picked: text ascending (A→Z), everything
 * quantitative descending (worst / most / newest first), manual ascending because
 * that is the stored report order.
 */
export const DEFAULT_SORT_DIR: Record<FindingSortKey, SortDirection> = {
  manual: 'asc',
  severity: 'desc',
  title: 'asc',
  created: 'desc',
  updated: 'desc',
  evidence: 'desc',
  goals: 'desc',
};

export const DEFAULT_SORT: FindingsSort = { key: 'manual', dir: 'asc' };

/**
 * Is the list in the canonical stored order? Only then may findings be dragged:
 * the reorder endpoint takes positions by array index, so reordering a reversed
 * or re-sorted list would write the wrong positions.
 */
export function isManualOrder(sort: FindingsSort): boolean {
  return sort.key === 'manual' && sort.dir === 'asc';
}

// Unrated findings rank below "None" so they land last in a descending (worst
// first) severity sort and first when ascending — one total order, no special
// cases in the comparator.
const UNRATED_RANK = -1;
const severityRank = (f: Finding): number =>
  f.severity ? SEVERITY_RANK[f.severity] : UNRATED_RANK;

const time = (iso: string): number => new Date(iso).getTime();

/** Compare on the chosen key only; ties are broken by the caller. */
function compareOn(key: FindingSortKey, a: Finding, b: Finding): number {
  switch (key) {
    case 'manual':
      return a.position - b.position;
    case 'severity':
      return severityRank(a) - severityRank(b);
    case 'title':
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    case 'created':
      return time(a.createdAt) - time(b.createdAt);
    case 'updated':
      return time(a.updatedAt) - time(b.updatedAt);
    case 'evidence':
      return a.numEvidence - b.numEvidence;
    case 'goals':
      return a.numGoals - b.numGoals;
  }
}

/**
 * Order a copy of `findings`. Every sort falls back to ascending `position`, so
 * ties keep the manual order instead of jittering between renders — and the
 * fallback is *not* flipped by `dir`, which would make equal rows swap places
 * purely because the direction changed.
 */
export function sortFindings(findings: readonly Finding[], sort: FindingsSort): Finding[] {
  const factor = sort.dir === 'asc' ? 1 : -1;
  return [...findings].sort((a, b) => {
    const primary = compareOn(sort.key, a, b);
    return primary !== 0 ? factor * primary : a.position - b.position;
  });
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/** A finding's category, with blank treated as "no category" (nullable column). */
export function categoryOf(f: Finding): string | null {
  const c = f.category?.trim();
  return c ? c : null;
}

/** A finding's affected target, with blank treated as "not set" (the field may be ''). */
export function targetOf(f: Finding): string | null {
  const t = f.affectedTarget.trim();
  return t ? t : null;
}

function matchesMapping(constraint: MappingFilter | undefined, refs: readonly string[]): boolean {
  if (constraint === undefined) return true;
  return constraint === 'any' ? refs.length > 0 : refs.length === 0;
}

export function filterFindings(
  findings: readonly Finding[],
  filter: FindingsFilterState,
): Finding[] {
  // Terms are AND-ed substrings, so "can replay" finds a finding whose title says
  // CAN and whose description says replay. Computed once, not per finding.
  const terms = filter.search.toLowerCase().split(/\s+/).filter(Boolean);
  const severities = new Set<Severity>(filter.severities);
  const kinds = new Set<FindingKind>(filter.kinds);
  const categories = new Set(filter.categories);
  const efforts = new Set<FixEffort>(filter.fixEfforts);
  const targets = new Set(filter.affectedTargets);
  const isoRefs = new Set(filter.iso21434Refs);
  const unrRefs = new Set(filter.unr155Refs);

  return findings.filter((f) => {
    if (terms.length > 0) {
      // Affected target is searched alongside the prose: operators look for the
      // component ("telematics unit") as readily as for words in the title.
      const haystack = `${f.title}\n${f.description}\n${f.affectedTarget}`.toLowerCase();
      if (!terms.every((t) => haystack.includes(t))) return false;
    }

    if (severities.size > 0 || filter.unrated) {
      const ok = f.severity ? severities.has(f.severity) : filter.unrated;
      if (!ok) return false;
    }

    if (kinds.size > 0 && !kinds.has(f.kind)) return false;

    if (categories.size > 0 || filter.uncategorized) {
      const cat = categoryOf(f);
      const ok = cat === null ? filter.uncategorized : categories.has(cat);
      if (!ok) return false;
    }

    if (filter.readyToReport !== undefined && f.readyToReport !== filter.readyToReport) {
      return false;
    }

    if (efforts.size > 0 && !efforts.has(f.fixEffort)) return false;

    if (filter.hasEvidence !== undefined && f.numEvidence > 0 !== filter.hasEvidence) {
      return false;
    }

    if (targets.size > 0) {
      const target = targetOf(f);
      if (target === null || !targets.has(target)) return false;
    }

    if (!matchesMapping(filter.iso21434, f.iso21434Refs)) return false;
    if (isoRefs.size > 0 && !f.iso21434Refs.some((r) => isoRefs.has(r))) return false;
    if (!matchesMapping(filter.unr155, f.unr155Refs)) return false;
    if (unrRefs.size > 0 && !f.unr155Refs.some((r) => unrRefs.has(r))) return false;

    return true;
  });
}

export function filterAndSortFindings(
  findings: readonly Finding[],
  filter: FindingsFilterState,
  sort: FindingsSort,
): Finding[] {
  return sortFindings(filterFindings(findings, filter), sort);
}

// ---------------------------------------------------------------------------
// Derived option lists
// ---------------------------------------------------------------------------

/**
 * The option lists that can only come from the data: affected targets are free
 * text, and the standards catalogs are far too long to render in a filter
 * popover, so only refs actually mapped on the loaded findings are offered.
 */
export interface FindingFacets {
  /** Distinct non-empty affected targets, alphabetical. */
  targets: string[];
  /** ISO/SAE 21434 ref ids present on at least one finding, in catalog order. */
  iso21434Refs: string[];
  /** UN R155 ref ids present on at least one finding, in catalog order. */
  unr155Refs: string[];
}

/** Order ids by their position in a standards catalog; unknown ids trail, sorted. */
function inCatalogOrder(ids: Set<string>, catalog: readonly { id: string }[]): string[] {
  const known = catalog.filter((r) => ids.has(r.id)).map((r) => r.id);
  const knownSet = new Set(known);
  const unknown = [...ids].filter((id) => !knownSet.has(id)).sort();
  return [...known, ...unknown];
}

export function deriveFindingFacets(findings: readonly Finding[]): FindingFacets {
  const targets = new Set<string>();
  const iso = new Set<string>();
  const unr = new Set<string>();
  for (const f of findings) {
    const target = targetOf(f);
    if (target) targets.add(target);
    for (const r of f.iso21434Refs) iso.add(r);
    for (const r of f.unr155Refs) unr.add(r);
  }
  return {
    targets: [...targets].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    iso21434Refs: inCatalogOrder(iso, ISO_21434_WORK_PRODUCTS),
    unr155Refs: inCatalogOrder(unr, UN_R155_REQUIREMENTS),
  };
}

// ---------------------------------------------------------------------------
// URL state
// ---------------------------------------------------------------------------

/**
 * The query params this page owns. Enum facets are comma-joined (their values are
 * controlled vocabularies, so a comma can never appear inside one); the two
 * free-text facets repeat their key instead (`?target=A&target=B`), because a
 * user-authored category or target may legitimately contain a comma.
 */
const PARAM = {
  search: 'q',
  severity: 'severity',
  kind: 'kind',
  category: 'category',
  uncategorized: 'uncategorized',
  ready: 'ready',
  effort: 'effort',
  evidence: 'evidence',
  target: 'target',
  iso21434: 'iso',
  iso21434Refs: 'iso-ref',
  unr155: 'unr155',
  unr155Refs: 'unr155-ref',
  sort: 'sort',
  dir: 'dir',
} as const;

/** Split a comma-joined param into trimmed, non-empty values. */
function splitList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Keep only values the enum actually contains, in canonical enum order — a
 * hand-edited or stale URL can't inject junk, and duplicates collapse.
 */
function pickEnum<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  const wanted = new Set(splitList(raw));
  return allowed.filter((v) => wanted.has(v));
}

function parseYesNo(raw: string | null): boolean | undefined {
  return raw === 'yes' ? true : raw === 'no' ? false : undefined;
}

function parseMapping(raw: string | null): MappingFilter | undefined {
  return MAPPING_FILTERS.find((m) => m === raw);
}

/**
 * Severity is nullable, so its param carries one extra value alongside the enum.
 * `unrated` is not a `Severity`, so it can never collide with a real one.
 */
const UNRATED_PARAM_VALUE = 'unrated';

/** Read filter + sort out of the URL. Unknown or malformed values are ignored. */
export function parseFindingsParams(params: URLSearchParams): {
  filter: FindingsFilterState;
  sort: FindingsSort;
} {
  const severityValues = splitList(params.get(PARAM.severity));
  const sortKey = FINDING_SORT_KEYS.find((k) => k === params.get(PARAM.sort));
  const dirParam = params.get(PARAM.dir);

  return {
    filter: {
      search: params.get(PARAM.search) ?? '',
      severities: pickEnum(params.get(PARAM.severity), SEVERITIES),
      unrated: severityValues.includes(UNRATED_PARAM_VALUE),
      kinds: pickEnum(params.get(PARAM.kind), FINDING_KINDS),
      categories: params.getAll(PARAM.category).filter((c) => c.trim() !== ''),
      uncategorized: params.get(PARAM.uncategorized) === '1',
      readyToReport: parseYesNo(params.get(PARAM.ready)),
      fixEfforts: pickEnum(params.get(PARAM.effort), FIX_EFFORTS),
      hasEvidence: parseYesNo(params.get(PARAM.evidence)),
      affectedTargets: params.getAll(PARAM.target).filter((t) => t.trim() !== ''),
      iso21434: parseMapping(params.get(PARAM.iso21434)),
      iso21434Refs: splitList(params.get(PARAM.iso21434Refs)),
      unr155: parseMapping(params.get(PARAM.unr155)),
      unr155Refs: splitList(params.get(PARAM.unr155Refs)),
    },
    sort: {
      key: sortKey ?? DEFAULT_SORT.key,
      // A direction without a recognized key is meaningless; fall back to the
      // key's own default so `?dir=asc` alone can't claim to sort anything.
      dir:
        dirParam === 'asc' || dirParam === 'desc'
          ? dirParam
          : DEFAULT_SORT_DIR[sortKey ?? DEFAULT_SORT.key],
    },
  };
}

/**
 * Serialize filter + sort back into `current`, preserving any param this page
 * doesn't own. Defaults are written as *absent* keys, so an unfiltered,
 * manually-ordered view has a clean URL.
 */
export function writeFindingsParams(
  current: URLSearchParams,
  filter: FindingsFilterState,
  sort: FindingsSort,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of Object.values(PARAM)) next.delete(key);

  const setList = (key: string, values: readonly string[]) => {
    if (values.length > 0) next.set(key, values.join(','));
  };

  if (filter.search.trim() !== '') next.set(PARAM.search, filter.search);
  setList(PARAM.severity, [...filter.severities, ...(filter.unrated ? [UNRATED_PARAM_VALUE] : [])]);
  setList(PARAM.kind, filter.kinds);
  for (const c of filter.categories) next.append(PARAM.category, c);
  if (filter.uncategorized) next.set(PARAM.uncategorized, '1');
  if (filter.readyToReport !== undefined) {
    next.set(PARAM.ready, filter.readyToReport ? 'yes' : 'no');
  }
  setList(PARAM.effort, filter.fixEfforts);
  if (filter.hasEvidence !== undefined) {
    next.set(PARAM.evidence, filter.hasEvidence ? 'yes' : 'no');
  }
  for (const t of filter.affectedTargets) next.append(PARAM.target, t);
  if (filter.iso21434) next.set(PARAM.iso21434, filter.iso21434);
  setList(PARAM.iso21434Refs, filter.iso21434Refs);
  if (filter.unr155) next.set(PARAM.unr155, filter.unr155);
  setList(PARAM.unr155Refs, filter.unr155Refs);

  // The default sort stays out of the URL entirely.
  if (!(sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir)) {
    next.set(PARAM.sort, sort.key);
    next.set(PARAM.dir, sort.dir);
  }
  return next;
}
