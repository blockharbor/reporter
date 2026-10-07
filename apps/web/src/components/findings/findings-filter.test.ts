import { describe, expect, it } from 'vitest';
import type { Finding } from '@reporter/shared';
import {
  DEFAULT_SORT,
  EMPTY_FILTER,
  deriveFindingFacets,
  filterAndSortFindings,
  filterFindings,
  isFilterActive,
  isManualOrder,
  parseFindingsParams,
  sortFindings,
  writeFindingsParams,
  type FindingsFilterState,
} from './findings-filter.js';

/** A minimal finding; each fixture overrides only the fields its case exercises. */
function finding(partial: Partial<Finding> & { uuid: string }): Finding {
  return {
    engagementSlug: 'eng',
    title: 'A finding',
    description: '',
    kind: 'weakness',
    affectedTarget: '',
    impact: '',
    fixEffort: 'none',
    iso21434Refs: [],
    unr155Refs: [],
    remediation: '',
    category: null,
    severity: null,
    cvssVector: null,
    cvssScore: null,
    readyToReport: false,
    position: 0,
    numEvidence: 0,
    numEvidenceInReport: 0,
    numGoals: 0,
    numRecommendations: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const uuids = (findings: Finding[]) => findings.map((f) => f.uuid);
const filter = (over: Partial<FindingsFilterState> = {}): FindingsFilterState => ({
  ...EMPTY_FILTER,
  ...over,
});

describe('filterFindings', () => {
  const findings = [
    finding({
      uuid: 'a',
      title: 'CAN bus replay',
      description: 'Frames can be replayed on the powertrain bus.',
      affectedTarget: 'Gateway ECU',
      severity: 'high',
      category: 'Network',
      readyToReport: true,
      fixEffort: 'medium',
      numEvidence: 3,
      numRecommendations: 2,
      iso21434Refs: ['iso-15-04'],
    }),
    finding({
      uuid: 'b',
      title: 'Secure boot verified',
      description: 'The bootloader checks signatures.',
      affectedTarget: 'Telematics unit',
      kind: 'strength',
      category: null,
      unr155Refs: ['unr155-7.3.4'],
    }),
    finding({
      uuid: 'c',
      title: 'Debug port exposed',
      description: 'UART header left populated.',
      affectedTarget: 'Gateway ECU',
      severity: 'critical',
      category: 'Hardware',
      fixEffort: 'low',
      numEvidence: 1,
      numGoals: 2,
    }),
  ];

  it('returns everything for the empty filter', () => {
    expect(uuids(filterFindings(findings, EMPTY_FILTER))).toEqual(['a', 'b', 'c']);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it('AND-s free-text terms across title, description and affected target', () => {
    expect(uuids(filterFindings(findings, filter({ search: 'can replay' })))).toEqual(['a']);
    expect(uuids(filterFindings(findings, filter({ search: 'gateway' })))).toEqual(['a', 'c']);
    expect(uuids(filterFindings(findings, filter({ search: 'can nonsense' })))).toEqual([]);
  });

  it('treats Unrated as its own severity option', () => {
    expect(uuids(filterFindings(findings, filter({ severities: ['critical'] })))).toEqual(['c']);
    expect(uuids(filterFindings(findings, filter({ unrated: true })))).toEqual(['b']);
    expect(
      uuids(filterFindings(findings, filter({ severities: ['critical'], unrated: true }))),
    ).toEqual(['b', 'c']);
  });

  it('filters by kind, category, Uncategorized, readiness, effort and evidence', () => {
    expect(uuids(filterFindings(findings, filter({ kinds: ['strength'] })))).toEqual(['b']);
    expect(uuids(filterFindings(findings, filter({ categories: ['Hardware'] })))).toEqual(['c']);
    expect(uuids(filterFindings(findings, filter({ uncategorized: true })))).toEqual(['b']);
    expect(uuids(filterFindings(findings, filter({ readyToReport: true })))).toEqual(['a']);
    expect(uuids(filterFindings(findings, filter({ fixEfforts: ['low', 'medium'] })))).toEqual([
      'a',
      'c',
    ]);
    expect(uuids(filterFindings(findings, filter({ hasEvidence: false })))).toEqual(['b']);
  });

  it('filters on strategic-recommendation presence, and not at all when unset', () => {
    expect(uuids(filterFindings(findings, filter({ hasRecommendations: true })))).toEqual(['a']);
    expect(uuids(filterFindings(findings, filter({ hasRecommendations: false })))).toEqual([
      'b',
      'c',
    ]);
    expect(uuids(filterFindings(findings, filter({ hasRecommendations: undefined })))).toEqual([
      'a',
      'b',
      'c',
    ]);
    // `false` is a real constraint, so it has to register as active.
    expect(isFilterActive(filter({ hasRecommendations: false }))).toBe(true);
    expect(isFilterActive(filter({ hasRecommendations: undefined }))).toBe(false);
  });

  it('combines facets with AND', () => {
    const both = filter({ affectedTargets: ['Gateway ECU'], readyToReport: false });
    expect(uuids(filterFindings(findings, both))).toEqual(['c']);
  });

  it('filters on standards-mapping presence and on specific refs', () => {
    expect(uuids(filterFindings(findings, filter({ iso21434: 'any' })))).toEqual(['a']);
    expect(uuids(filterFindings(findings, filter({ unr155: 'none' })))).toEqual(['a', 'c']);
    expect(uuids(filterFindings(findings, filter({ iso21434Refs: ['iso-15-04'] })))).toEqual(['a']);
    expect(uuids(filterFindings(findings, filter({ unr155Refs: ['iso-15-04'] })))).toEqual([]);
  });
});

describe('sortFindings', () => {
  const findings = [
    finding({
      uuid: 'a',
      title: 'Beta',
      position: 0,
      severity: 'low',
      numEvidence: 5,
      numGoals: 1,
      numRecommendations: 2,
    }),
    finding({
      uuid: 'b',
      title: 'alpha',
      position: 1,
      severity: null,
      numEvidence: 5,
      numGoals: 3,
      numRecommendations: 2,
    }),
    finding({
      uuid: 'c',
      title: 'Gamma',
      position: 2,
      severity: 'critical',
      numEvidence: 1,
      numGoals: 1,
      createdAt: '2026-02-02T00:00:00.000Z',
      updatedAt: '2026-03-03T00:00:00.000Z',
    }),
  ];

  it('defaults to manual order and recognizes it', () => {
    expect(isManualOrder(DEFAULT_SORT)).toBe(true);
    expect(isManualOrder({ key: 'manual', dir: 'desc' })).toBe(false);
    expect(isManualOrder({ key: 'severity', dir: 'asc' })).toBe(false);
    expect(uuids(sortFindings(findings, DEFAULT_SORT))).toEqual(['a', 'b', 'c']);
  });

  it('sorts Unrated last when severity descends, first when it ascends', () => {
    expect(uuids(sortFindings(findings, { key: 'severity', dir: 'desc' }))).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(uuids(sortFindings(findings, { key: 'severity', dir: 'asc' }))).toEqual(['b', 'a', 'c']);
  });

  it('sorts titles case-insensitively', () => {
    expect(uuids(sortFindings(findings, { key: 'title', dir: 'asc' }))).toEqual(['b', 'a', 'c']);
  });

  it('breaks ties on position, in manual order, whichever direction is active', () => {
    // a and b both have 5 evidence; a (position 0) always precedes b (position 1).
    expect(uuids(sortFindings(findings, { key: 'evidence', dir: 'desc' }))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(uuids(sortFindings(findings, { key: 'evidence', dir: 'asc' }))).toEqual(['c', 'a', 'b']);
  });

  it('sorts on created, updated and linked goals', () => {
    expect(uuids(sortFindings(findings, { key: 'created', dir: 'desc' }))).toEqual(['c', 'a', 'b']);
    expect(uuids(sortFindings(findings, { key: 'updated', dir: 'desc' }))).toEqual(['c', 'a', 'b']);
    expect(uuids(sortFindings(findings, { key: 'goals', dir: 'desc' }))).toEqual(['b', 'a', 'c']);
  });

  it('sorts on strategic recommendations, breaking ties on position', () => {
    // a and b both have 2 recommendations; a (position 0) always precedes b.
    expect(uuids(sortFindings(findings, { key: 'recommendations', dir: 'desc' }))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(uuids(sortFindings(findings, { key: 'recommendations', dir: 'asc' }))).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [...findings];
    sortFindings(input, { key: 'title', dir: 'desc' });
    expect(uuids(input)).toEqual(['a', 'b', 'c']);
  });
});

describe('filterAndSortFindings', () => {
  it('filters first, then orders what survived', () => {
    const findings = [
      finding({ uuid: 'a', position: 0, severity: 'low', readyToReport: true }),
      finding({ uuid: 'b', position: 1, severity: 'critical' }),
      finding({ uuid: 'c', position: 2, severity: 'high', readyToReport: true }),
    ];
    const result = filterAndSortFindings(findings, filter({ readyToReport: true }), {
      key: 'severity',
      dir: 'desc',
    });
    expect(uuids(result)).toEqual(['c', 'a']);
  });
});

describe('deriveFindingFacets', () => {
  it('collects distinct targets alphabetically and refs in catalog order', () => {
    const facets = deriveFindingFacets([
      finding({ uuid: 'a', affectedTarget: 'Telematics unit', iso21434Refs: ['iso-15-04'] }),
      finding({ uuid: 'b', affectedTarget: '  ', unr155Refs: ['unr155-7.3.4'] }),
      finding({
        uuid: 'c',
        affectedTarget: 'Gateway ECU',
        iso21434Refs: ['iso-09-cs-goals', 'iso-15-04', 'iso-legacy-id'],
      }),
    ]);
    expect(facets.targets).toEqual(['Gateway ECU', 'Telematics unit']);
    // Catalog order: clause 9 before clause 15; an unknown (legacy) id trails.
    expect(facets.iso21434Refs).toEqual(['iso-09-cs-goals', 'iso-15-04', 'iso-legacy-id']);
    expect(facets.unr155Refs).toEqual(['unr155-7.3.4']);
  });
});

describe('findings URL params', () => {
  it('round-trips a fully populated filter and sort', () => {
    const full = filter({
      search: 'can bus',
      severities: ['high', 'critical'],
      unrated: true,
      kinds: ['weakness'],
      categories: ['Network, wired', 'Hardware'],
      uncategorized: true,
      readyToReport: false,
      fixEfforts: ['low'],
      hasEvidence: true,
      hasRecommendations: true,
      affectedTargets: ['Gateway ECU'],
      iso21434: 'any',
      iso21434Refs: ['iso-15-04'],
      unr155: 'none',
      unr155Refs: ['unr155-7.3.4'],
    });
    const sort = { key: 'updated', dir: 'asc' } as const;
    const parsed = parseFindingsParams(writeFindingsParams(new URLSearchParams(), full, sort));
    expect(parsed.filter).toEqual(full);
    expect(parsed.sort).toEqual(sort);
  });

  it('writes the enum facets as readable comma lists', () => {
    const params = writeFindingsParams(
      new URLSearchParams(),
      filter({ severities: ['high', 'critical'], unrated: true, kinds: ['weakness'] }),
      { key: 'severity', dir: 'desc' },
    );
    // Canonical enum order, not click order, with the nullable option appended.
    expect(params.get('severity')).toBe('high,critical,unrated');
    expect(params.get('kind')).toBe('weakness');
    expect(params.get('sort')).toBe('severity');
    expect(params.get('dir')).toBe('desc');
  });

  it('round-trips the strategic-recommendation facet and sort key', () => {
    const yes = writeFindingsParams(
      new URLSearchParams(),
      filter({ hasRecommendations: true }),
      DEFAULT_SORT,
    );
    expect(yes.get('recs')).toBe('yes');
    expect(parseFindingsParams(yes).filter.hasRecommendations).toBe(true);

    const no = writeFindingsParams(
      new URLSearchParams(),
      filter({ hasRecommendations: false }),
      DEFAULT_SORT,
    );
    expect(no.get('recs')).toBe('no');
    expect(parseFindingsParams(no).filter.hasRecommendations).toBe(false);

    const sorted = writeFindingsParams(new URLSearchParams(), EMPTY_FILTER, {
      key: 'recommendations',
      dir: 'asc',
    });
    expect(sorted.get('sort')).toBe('recommendations');
    expect(parseFindingsParams(sorted).sort).toEqual({ key: 'recommendations', dir: 'asc' });
    // Most-first is this key's natural direction when the URL names no direction.
    expect(parseFindingsParams(new URLSearchParams('sort=recommendations')).sort).toEqual({
      key: 'recommendations',
      dir: 'desc',
    });
    expect(
      parseFindingsParams(new URLSearchParams('recs=sometimes')).filter.hasRecommendations,
    ).toBeUndefined();
  });

  it('leaves defaults out of the URL and keeps params it does not own', () => {
    const params = writeFindingsParams(
      new URLSearchParams('tab=findings'),
      EMPTY_FILTER,
      DEFAULT_SORT,
    );
    expect(params.toString()).toBe('tab=findings');
  });

  it('ignores junk values and a direction with no sort key', () => {
    const { filter: f, sort } = parseFindingsParams(
      new URLSearchParams('severity=high,bogus&kind=nope&ready=maybe&sort=colour&dir=asc'),
    );
    expect(f.severities).toEqual(['high']);
    expect(f.unrated).toBe(false);
    expect(f.kinds).toEqual([]);
    expect(f.readyToReport).toBeUndefined();
    expect(sort).toEqual(DEFAULT_SORT);
  });

  it('repeats the free-text keys so a comma inside a value survives', () => {
    const params = writeFindingsParams(
      new URLSearchParams(),
      filter({ categories: ['Network, wired'], affectedTargets: ['ECU, gateway', 'Head unit'] }),
      DEFAULT_SORT,
    );
    expect(params.getAll('category')).toEqual(['Network, wired']);
    expect(params.getAll('target')).toEqual(['ECU, gateway', 'Head unit']);
    expect(parseFindingsParams(params).filter.affectedTargets).toEqual([
      'ECU, gateway',
      'Head unit',
    ]);
  });
});
