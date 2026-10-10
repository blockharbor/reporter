import { describe, expect, it } from 'vitest';
import { auditListQuerySchema } from '@reporter/shared';
import {
  AUDIT_FIRST_CLICK_DIR,
  AUDIT_PAGE_SIZE,
  DEFAULT_AUDIT_SORT,
  EMPTY_AUDIT_FILTER,
  auditQueryString,
  auditTotalPages,
  isAuditFilterActive,
  parseAuditQuery,
  writeAuditQuery,
  type AuditFilterState,
  type AuditLogQuery,
} from './audit-filter.js';
import { parsePageParam } from '../common/Pagination.js';

const filter = (over: Partial<AuditFilterState> = {}): AuditFilterState => ({
  ...EMPTY_AUDIT_FILTER,
  ...over,
});

const query = (over: Partial<AuditLogQuery> = {}): AuditLogQuery => ({
  filter: EMPTY_AUDIT_FILTER,
  sort: DEFAULT_AUDIT_SORT,
  page: 1,
  ...over,
});

/**
 * A querystring as Fastify's default parser hands it to a route: one string per
 * key, or an array when the key repeated. This is the object the server feeds
 * to `auditListQuerySchema.parse(req.query)`.
 */
function asServerQuery(qs: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(qs)) {
    const prev = out[key];
    if (prev === undefined) out[key] = value;
    else out[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  return out;
}

describe('parseAuditQuery / writeAuditQuery', () => {
  it('round-trips a fully populated filter, a non-default sort and page 3', () => {
    const full = filter({
      search: 'exec summary',
      actors: ['ada', 'grace@example.com', 'system'],
      actions: ['create', 'update'],
      entityTypes: ['finding', 'tag'],
      via: 'apikey',
      entityId: '0b2f1e3a-1111-4222-8333-444455556666',
      dateRange: { from: '2026-01-01', to: '2026-01-31' },
      engagements: ['acme-2026', 'old-eng'],
      noEngagement: true,
    });
    const q = query({ filter: full, sort: { key: 'who', dir: 'desc' }, page: 3 });
    const parsed = parseAuditQuery(writeAuditQuery(new URLSearchParams(), q));
    expect(parsed).toEqual(q);
  });

  it('writes defaults as absent keys and keeps params it does not own', () => {
    const params = writeAuditQuery(new URLSearchParams('tab=audit-log'), query());
    expect(params.toString()).toBe('tab=audit-log');
  });

  it('writes the URL dates as YYYY-MM-DD and repeats every list key', () => {
    const params = writeAuditQuery(
      new URLSearchParams(),
      query({
        filter: filter({
          actions: ['create', 'delete'],
          entityTypes: ['evidence'],
          dateRange: { from: '2026-02-01', to: '' },
        }),
      }),
    );
    expect(params.getAll('action')).toEqual(['create', 'delete']);
    expect(params.getAll('entity')).toEqual(['evidence']);
    expect(params.get('from')).toBe('2026-02-01');
    expect(params.has('to')).toBe(false);
  });

  it('ignores junk enum values, an unknown sort key and a malformed date', () => {
    const { filter: f, sort } = parseAuditQuery(
      new URLSearchParams(
        'action=create,bogus&entity=nope&via=carrier-pigeon&sort=colour&dir=asc&from=2026-1-1&eng=Not%20A%20Slug',
      ),
    );
    expect(f.actions).toEqual(['create']);
    expect(f.entityTypes).toEqual([]);
    expect(f.via).toBeUndefined();
    expect(f.dateRange).toBeUndefined();
    expect(f.engagements).toEqual([]);
    expect(sort).toEqual(DEFAULT_AUDIT_SORT);
  });

  it('accepts a comma-joined list on the way in, in canonical enum order', () => {
    const { filter: f } = parseAuditQuery(new URLSearchParams('action=update,create'));
    expect(f.actions).toEqual(['create', 'update']);
  });

  it('reduces a wire ISO date pasted into the URL to its day', () => {
    const { filter: f } = parseAuditQuery(
      new URLSearchParams('from=2026-03-01T00:00:00.000Z&to=2026-03-02T23:59:59.999Z'),
    );
    expect(f.dateRange).toEqual({ from: '2026-03-01', to: '2026-03-02' });
  });

  it('falls back to the first-click direction when dir is missing or unpaired', () => {
    expect(parseAuditQuery(new URLSearchParams('sort=who')).sort).toEqual({
      key: 'who',
      dir: AUDIT_FIRST_CLICK_DIR.who,
    });
    expect(parseAuditQuery(new URLSearchParams('sort=action&dir=sideways')).sort).toEqual({
      key: 'action',
      dir: 'asc',
    });
    // A direction with no recognised key cannot claim to sort anything.
    expect(parseAuditQuery(new URLSearchParams('dir=asc')).sort).toEqual(DEFAULT_AUDIT_SORT);
  });

  it('repeats the actor key so a value survives intact', () => {
    const params = writeAuditQuery(
      new URLSearchParams(),
      query({ filter: filter({ actors: ['ada', 'b@x.io'] }) }),
    );
    expect(params.getAll('actor')).toEqual(['ada', 'b@x.io']);
    expect(parseAuditQuery(new URLSearchParams('actor=ada&actor=b@x.io')).filter.actors).toEqual([
      'ada',
      'b@x.io',
    ]);
  });

  it('reads noEng as a flag and writes it as 1', () => {
    expect(parseAuditQuery(new URLSearchParams('noEng=true')).filter.noEngagement).toBe(true);
    expect(parseAuditQuery(new URLSearchParams('noEng=0')).filter.noEngagement).toBe(false);
    const params = writeAuditQuery(
      new URLSearchParams(),
      query({ filter: filter({ noEngagement: true }) }),
    );
    expect(params.get('noEng')).toBe('1');
  });

  it('writes page 1 as absent and page 2 as page=2', () => {
    expect(writeAuditQuery(new URLSearchParams(), query({ page: 1 })).has('page')).toBe(false);
    expect(writeAuditQuery(new URLSearchParams(), query({ page: 2 })).get('page')).toBe('2');
  });
});

describe('parsePageParam', () => {
  it('reads a 1-based integer and treats everything else as page 1', () => {
    expect(parsePageParam(null)).toBe(1);
    expect(parsePageParam('2')).toBe(2);
    expect(parsePageParam('0')).toBe(1);
    expect(parsePageParam('-3')).toBe(1);
    expect(parsePageParam('abc')).toBe(1);
    expect(parsePageParam('1.5')).toBe(1);
    expect(parsePageParam('')).toBe(1);
  });
});

describe('auditQueryString', () => {
  it('never carries a foreign param and always names the page size', () => {
    const qs = auditQueryString(parseAuditQuery(new URLSearchParams('tab=audit-log&row=3')));
    expect(qs).toBe(`pageSize=${AUDIT_PAGE_SIZE}`);
  });

  it('is exactly what auditListQuerySchema parses, with the dates as ISO day bounds', () => {
    const qs = auditQueryString(
      query({
        filter: filter({
          search: 'token',
          actors: ['ada', 'system'],
          actions: ['update', 'delete'],
          entityTypes: ['evidence_comment'],
          via: 'session',
          entityId: '42',
          dateRange: { from: '2026-01-01', to: '2026-01-31' },
          engagements: ['acme-2026'],
          noEngagement: true,
        }),
        sort: { key: 'action', dir: 'desc' },
        page: 3,
      }),
    );
    const parsed = auditListQuerySchema.parse(asServerQuery(qs));
    expect(parsed).toEqual({
      q: 'token',
      actor: ['ada', 'system'],
      action: ['update', 'delete'],
      entity: ['evidence_comment'],
      via: 'session',
      entityId: '42',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T23:59:59.999Z',
      eng: ['acme-2026'],
      noEng: true,
      sort: 'action',
      dir: 'desc',
    });
    // page/pageSize are the server's `parsePagination` keys, outside the schema.
    const raw = new URLSearchParams(qs);
    expect(raw.get('page')).toBe('3');
    expect(raw.get('pageSize')).toBe(String(AUDIT_PAGE_SIZE));
  });

  it('omits the default sort so the server applies its own identical default', () => {
    const parsed = auditListQuerySchema.parse(asServerQuery(auditQueryString(query())));
    expect(parsed.sort).toBe('when');
    expect(parsed.dir).toBe('desc');
  });
});

describe('isAuditFilterActive', () => {
  it('is false for the empty filter and true for any single facet', () => {
    expect(isAuditFilterActive(EMPTY_AUDIT_FILTER)).toBe(false);
    expect(isAuditFilterActive(filter({ search: '  ' }))).toBe(false);
    expect(isAuditFilterActive(filter({ entityId: 'x' }))).toBe(true);
    expect(isAuditFilterActive(filter({ noEngagement: true }))).toBe(true);
  });
});

describe('auditTotalPages', () => {
  it('rounds up, never drops below one page, and stops at the deepest page served', () => {
    expect(auditTotalPages(0)).toBe(1);
    expect(auditTotalPages(50)).toBe(1);
    expect(auditTotalPages(51)).toBe(2);
    // AUDIT_MAX_OFFSET / 50 = 1000 pages, however long the log is.
    expect(auditTotalPages(10_000_000)).toBe(1000);
  });
});
