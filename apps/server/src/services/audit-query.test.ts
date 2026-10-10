import { describe, expect, it } from 'vitest';
import { AUDIT_MAX_OFFSET, auditListQuerySchema, type AuditListQuery } from '@reporter/shared';
import { parsePagination } from '../helpers/pagination.js';
import {
  EMPTY_LOOKUPS,
  SYSTEM_ACTOR_VALUE,
  auditOrderBy,
  buildAuditWhere,
  clampAuditPage,
  maxAuditPage,
  type AuditWhereLookups,
} from './audit-query.js';

// The pure half of the read side: the predicate builder, the sort map and the
// page clamp, with no database. What a predicate MEANS against real rows —
// that a slug filter finds the right user, that the deleted-engagement branch
// matches the snapshot — is the route itest's job.

const parse = (input: Record<string, unknown> = {}): AuditListQuery =>
  auditListQuerySchema.parse(input);

const ENG = { kind: 'engagement', engagementId: 42 } as const;
const SITE = { kind: 'site' } as const;

const lookups = (over: Partial<AuditWhereLookups> = {}): AuditWhereLookups => ({
  ...EMPTY_LOOKUPS,
  ...over,
});

/** The AND list of a built predicate, for assertions on position and shape. */
function clauses(where: ReturnType<typeof buildAuditWhere>) {
  return where.AND as Record<string, unknown>[];
}

describe('buildAuditWhere — scope', () => {
  it('puts the engagement predicate first and unconditionally', () => {
    const where = buildAuditWhere(ENG, parse({ actor: 'wendy', action: 'update' }));
    expect(clauses(where)[0]).toEqual({ engagementId: 42 });
  });

  it('is scoped to the engagement even with no other filter', () => {
    expect(buildAuditWhere(ENG, parse())).toEqual({ AND: [{ engagementId: 42 }] });
  });

  it('ignores eng and noEng under engagement scope', () => {
    const where = buildAuditWhere(ENG, parse({ eng: 'other-op', noEng: '1' }));
    expect(where).toEqual({ AND: [{ engagementId: 42 }] });
  });

  it('has no scope predicate at all under site scope with no engagement filter', () => {
    expect(buildAuditWhere(SITE, parse())).toEqual({ AND: [] });
  });

  it('matches a live engagement by FK and a deleted one by snapshot with a null FK', () => {
    const where = buildAuditWhere(
      SITE,
      parse({ eng: ['op1', 'gone'] }),
      lookups({ engagementIdBySlug: new Map([['op1', 7]]) }),
    );
    expect(clauses(where)[0]).toEqual({
      OR: [
        { engagementId: { in: [7] } },
        // Every requested slug, not only the unresolved ones: a deleted
        // engagement's slug may since have been reused by a live one.
        { engagementId: null, engagementSlug: { in: ['op1', 'gone'] } },
      ],
    });
  });

  it('noEng matches rows with neither an FK nor a snapshot, ORed with eng', () => {
    const only = buildAuditWhere(SITE, parse({ noEng: 'true' }));
    expect(clauses(only)[0]).toEqual({ OR: [{ engagementId: null, engagementSlug: null }] });

    const both = buildAuditWhere(SITE, parse({ eng: 'gone', noEng: '1' }));
    expect(clauses(both)[0]).toEqual({
      OR: [
        { engagementId: null, engagementSlug: { in: ['gone'] } },
        { engagementId: null, engagementSlug: null },
      ],
    });
  });

  it('treats noEng=0 as absent', () => {
    expect(buildAuditWhere(SITE, parse({ noEng: '0' }))).toEqual({ AND: [] });
  });
});

describe('buildAuditWhere — actor', () => {
  it('resolves a slug through the lookups to the live id', () => {
    const where = buildAuditWhere(
      SITE,
      parse({ actor: 'wendy-writer' }),
      lookups({ userIdBySlug: new Map([['wendy-writer', 9]]) }),
    );
    expect(clauses(where)).toEqual([{ OR: [{ actorId: 9 }] }]);
  });

  it('matches nothing for a slug no account has, rather than failing', () => {
    const where = buildAuditWhere(SITE, parse({ actor: 'nobody' }));
    expect(clauses(where)).toEqual([{ OR: [{ id: { in: [] } }] }]);
  });

  it('takes a numeric value as an actor id', () => {
    expect(clauses(buildAuditWhere(SITE, parse({ actor: '12' })))).toEqual([
      { OR: [{ actorId: 12 }] },
    ]);
  });

  it('matches an email against the snapshot, case-insensitively', () => {
    expect(clauses(buildAuditWhere(SITE, parse({ actor: 'Gone@Test.local' })))).toEqual([
      { OR: [{ actorEmail: { equals: 'Gone@Test.local', mode: 'insensitive' } }] },
    ]);
  });

  it('maps the literal system to a null actor on the system plane', () => {
    expect(clauses(buildAuditWhere(SITE, parse({ actor: SYSTEM_ACTOR_VALUE })))).toEqual([
      { OR: [{ actorId: null, via: 'system' }] },
    ]);
  });

  it('ORs every value of a repeated or comma-joined actor param', () => {
    const where = buildAuditWhere(
      SITE,
      parse({ actor: ['wendy', '3,gone@test.local', 'system'] }),
      lookups({ userIdBySlug: new Map([['wendy', 1]]) }),
    );
    expect(clauses(where)).toEqual([
      {
        OR: [
          { actorId: 1 },
          { actorId: 3 },
          { actorEmail: { equals: 'gone@test.local', mode: 'insensitive' } },
          { actorId: null, via: 'system' },
        ],
      },
    ]);
  });
});

describe('buildAuditWhere — the other filters', () => {
  it('narrows on action, entity, via and entityId', () => {
    const where = buildAuditWhere(
      ENG,
      parse({
        action: 'create,update',
        entity: ['finding', 'evidence'],
        via: 'apikey',
        entityId: 'abc',
      }),
    );
    expect(clauses(where)).toEqual([
      { engagementId: 42 },
      { action: { in: ['create', 'update'] } },
      { entityType: { in: ['finding', 'evidence'] } },
      { via: 'apikey' },
      { entityId: 'abc' },
    ]);
  });

  it('bounds createdAt inclusively on from and to', () => {
    const where = buildAuditWhere(
      SITE,
      parse({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-09T23:59:59.000Z' }),
    );
    expect(clauses(where)).toEqual([
      {
        createdAt: {
          gte: new Date('2026-10-01T00:00:00.000Z'),
          lte: new Date('2026-10-09T23:59:59.000Z'),
        },
      },
    ]);
    const open = buildAuditWhere(SITE, parse({ from: '2026-10-01T00:00:00.000Z' }));
    expect(clauses(open)).toEqual([{ createdAt: { gte: new Date('2026-10-01T00:00:00.000Z') } }]);
  });

  it('rejects a from/to that is not an ISO datetime', () => {
    expect(() => parse({ from: '2026-10-01' })).toThrow();
  });
});

describe('buildAuditWhere — free text', () => {
  it('searches summary and label only under engagement scope, whatever the lookups say', () => {
    const where = buildAuditWhere(
      ENG,
      parse({ q: 'token' }),
      lookups({ changesMatchIds: [1, 2, 3] }),
    );
    expect(clauses(where)[1]).toEqual({
      OR: [
        { summary: { contains: 'token', mode: 'insensitive' } },
        { entityLabel: { contains: 'token', mode: 'insensitive' } },
      ],
    });
  });

  it('adds the diff-text matches under site scope', () => {
    const where = buildAuditWhere(
      SITE,
      parse({ q: 'token' }),
      lookups({ changesMatchIds: [1, 2, 3] }),
    );
    expect(clauses(where)).toEqual([
      {
        OR: [
          { summary: { contains: 'token', mode: 'insensitive' } },
          { entityLabel: { contains: 'token', mode: 'insensitive' } },
          { id: { in: [1, 2, 3] } },
        ],
      },
    ]);
  });

  it('adds no id clause when the diff search matched nothing or did not run', () => {
    const none = buildAuditWhere(SITE, parse({ q: 'token' }), lookups({ changesMatchIds: [] }));
    expect((clauses(none)[0]!.OR as unknown[]).length).toBe(2);
    const notRun = buildAuditWhere(SITE, parse({ q: 'token' }));
    expect((clauses(notRun)[0]!.OR as unknown[]).length).toBe(2);
  });

  it('treats an empty q as no filter', () => {
    expect(buildAuditWhere(SITE, parse({ q: '   ' }))).toEqual({ AND: [] });
  });

  it('escapes %, _ and the backslash so the text is matched literally', () => {
    // Prisma's `contains` emits a bare ILIKE with the value wrapped in %…% and
    // nothing escaped; Postgres's default escape is the backslash, so the
    // pre-escaped needle is what makes `?q=100%` mean "100%" and not "100…".
    const where = buildAuditWhere(ENG, parse({ q: '100%_x\\y' }));
    expect(clauses(where)[1]).toEqual({
      OR: [
        { summary: { contains: '100\\%\\_x\\\\y', mode: 'insensitive' } },
        { entityLabel: { contains: '100\\%\\_x\\\\y', mode: 'insensitive' } },
      ],
    });
  });
});

describe('auditOrderBy', () => {
  it('sorts when by createdAt with id as the tiebreak in the same direction', () => {
    expect(auditOrderBy('when', 'desc')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(auditOrderBy('when', 'asc')).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });

  it('sorts who by actorName and action by action, always ending newest-first', () => {
    expect(auditOrderBy('who', 'asc')).toEqual([
      { actorName: 'asc' },
      { createdAt: 'desc' },
      { id: 'desc' },
    ]);
    expect(auditOrderBy('action', 'desc')).toEqual([
      { action: 'desc' },
      { createdAt: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('defaults to when desc from the query schema', () => {
    const q = parse();
    expect(auditOrderBy(q.sort, q.dir)).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});

describe('page clamp', () => {
  it('never walks past AUDIT_MAX_OFFSET', () => {
    expect(maxAuditPage(50)).toBe(AUDIT_MAX_OFFSET / 50);
    expect(maxAuditPage(250)).toBe(AUDIT_MAX_OFFSET / 250);
    expect(maxAuditPage(7)).toBe(Math.ceil(AUDIT_MAX_OFFSET / 7));
  });

  it('clamps a too-deep page and recomputes skip; leaves a sane page alone', () => {
    const deep = clampAuditPage(parsePagination({ page: '99999', pageSize: '50' }));
    expect(deep).toEqual({ page: 1000, pageSize: 50, skip: 49950, take: 50 });
    expect(deep.skip).toBeLessThan(AUDIT_MAX_OFFSET);

    const fine = parsePagination({ page: '3', pageSize: '20' });
    expect(clampAuditPage(fine)).toEqual(fine);
  });
});
