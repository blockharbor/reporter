/**
 * Audit log — the READ side, plus the one write this module owns (the
 * tamper-evident removal). The writers live in services/audit.ts and
 * audit/extension.ts; nothing here records anything.
 *
 * SCOPE IS MANDATORY. Every query takes an `AuditScope` and `buildAuditWhere`
 * applies it FIRST and unconditionally, so the engagement list can never leak
 * another engagement's rows whatever the querystring says, and the site list —
 * which sees everything, including rows with no engagement and rows whose
 * engagement is gone — is reachable only behind `requireAdmin`. The two
 * site-only filters (`eng`, `noEng`) are accepted and ignored under engagement
 * scope rather than refused: a deep link copied from the admin page into an
 * engagement URL degrades to "that engagement's log", never to a 400 and never
 * to a wider view.
 *
 * COST, stated rather than hidden, because the table is retained forever:
 *
 *  - Exact totals are a second query per page, batched with the page in one
 *    `$transaction([findMany, count])` (the services/evidence.ts idiom — a
 *    batch, not an interactive transaction, so no `withIntent` is needed and the
 *    backstop never sees it: reads are skipped before the transaction check).
 *    Engagement scope hits `(engagement_id, created_at)` for both halves; the
 *    site list with no predicate is `count(*)` over the whole table, which
 *    Postgres does not cache — tens of ms at 10^5 rows, 100 ms+ at 10^6. The
 *    documented upgrade path is a capped count (`count(*) FROM (... LIMIT N)`).
 *  - `q` is an ILIKE heap scan over `summary` and `entity_label`, neither
 *    indexed. Under SITE scope it also scans `changes::text`, because the
 *    removal flow exists to purge a pasted credential and the generated summary
 *    never embeds a value — an admin searching for the leaked token would
 *    otherwise find nothing. Engagement scope deliberately does not search
 *    diffs: an engagement writer searching other people's diffs is a different
 *    thing from an admin purging one. The `changes` half cannot be expressed in
 *    Prisma's typed `where` (its JSON `string_contains` with `mode:
 *    'insensitive'` compiles to `lower(jsonb)`, which Postgres rejects), so it
 *    is a parameterized raw id subselect capped at AUDIT_CHANGES_SEARCH_CAP
 *    newest matches — see `resolveAuditLookups`. pg_trgm GIN indexes on the two
 *    text columns are the upgrade path when the scan is felt; no migration
 *    enables any extension today, so it is not part of v1.
 *  - Deep pagination is clamped: `page` never exceeds
 *    ceil(AUDIT_MAX_OFFSET / pageSize), because `OFFSET 499950` walked twice is
 *    a real cost here. Keyset pagination is the documented upgrade path.
 *
 * THE REMOVAL is the one write. It runs in its own transaction and writes
 * through `tx.auditEntry` directly rather than through the best-effort writer,
 * because a swallowed failure here would be a silent removal — the one thing
 * the feature promises cannot happen. The guard trigger enforces both halves
 * of the transition (the stamp and the blanking); the service only has to
 * state it. No `withIntent` wrap: the backstop skips the AuditEntry model
 * unconditionally (audit/extension.ts, check 3), so there is nothing to
 * suppress and nothing to tally.
 */
import type { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUDIT_ENTRY_ALREADY_REMOVED,
  AUDIT_MAX_OFFSET,
  SYSTEM_ACTOR_LABEL,
  type AuditAction,
  type AuditActorOption,
  type AuditEngagementOption,
  type AuditEntityType,
  type AuditFacets,
  type AuditListQuery,
  type AuditLogPage,
  type AuditSortDir,
  type AuditSortKey,
} from '@reporter/shared';
import { HttpError } from '../auth/guards.js';
import type { Pagination } from '../helpers/pagination.js';
import type { AuthedUser } from '../types.js';
import { serializeAuditEntry, type AuditEntryRow } from './serializers.js';

// ---------------------------------------------------------------------------
// Scope and lookups
// ---------------------------------------------------------------------------

/** Every read carries one of these; there is no unscoped query. */
export type AuditScope = { kind: 'engagement'; engagementId: number } | { kind: 'site' };

/**
 * The literal `?actor=` value for rows with no human actor. A word, not a
 * sentinel number, because it can never collide with a slug (slugs are what a
 * user's name becomes, and nobody is called "system" without a surname) nor
 * with an email (no `@`) nor with a numeric id.
 */
export const SYSTEM_ACTOR_VALUE = 'system';

/**
 * Newest `changes::text` matches the site-scope `q` considers. Well under
 * Postgres's 32 767 bind-parameter limit, which the resulting `id IN (...)`
 * must respect, and far above what a search for a specific leaked string
 * returns. A one-letter `q` on a huge log may miss older diff-only matches;
 * the summary and label halves of the search stay exact regardless.
 */
export const AUDIT_CHANGES_SEARCH_CAP = 5_000;

/**
 * What `buildAuditWhere` needs from the database, resolved up front by
 * `resolveAuditLookups` so the predicate builder itself is pure and unit-
 * testable. Each map is only populated when the query needs it.
 */
export interface AuditWhereLookups {
  /** Live user ids by slug, for the slug form of `?actor=`. */
  userIdBySlug: ReadonlyMap<string, number>;
  /** Live engagement ids by slug, for `?eng=` (site scope only). */
  engagementIdBySlug: ReadonlyMap<string, number>;
  /**
   * Site scope with `q` only: the ids whose `changes` text matched the raw
   * ILIKE. Null when the lookup did not run (engagement scope, or no `q`).
   */
  changesMatchIds: readonly number[] | null;
}

export const EMPTY_LOOKUPS: AuditWhereLookups = {
  userIdBySlug: new Map(),
  engagementIdBySlug: new Map(),
  changesMatchIds: null,
};

/** The three forms a `?actor=` value takes, decided by shape alone. */
function actorForm(value: string): 'system' | 'id' | 'email' | 'slug' {
  if (value === SYSTEM_ACTOR_VALUE) return 'system';
  if (/^\d+$/.test(value)) return 'id';
  if (value.includes('@')) return 'email';
  return 'slug';
}

/**
 * The user's text as LIKE data, not a pattern: `%`, `_` and the escape
 * character itself are backslash-escaped. Postgres's default `ESCAPE` is the
 * backslash, so the result reads literally both in the raw ILIKE below (which
 * also says `ESCAPE '\\'` to be explicit) and in Prisma's `contains`, which
 * wraps the value in `%…%` and emits a bare `ILIKE` with NO escaping of its own
 * — unescaped, `?q=100%` would match "100 today" and `?q=a_b` would match
 * "aXb". `escapeLike` is the one place the rule lives.
 */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** ILIKE pattern for a plain substring. */
function likePattern(q: string): string {
  return `%${escapeLike(q)}%`;
}

/**
 * The database reads the predicate needs: slug -> id for the actors and
 * engagements the query names, and — site scope with `q` only — the raw diff
 * search. Nothing is read that the query does not ask for.
 */
export async function resolveAuditLookups(
  db: PrismaClient,
  scope: AuditScope,
  query: AuditListQuery,
): Promise<AuditWhereLookups> {
  const actorSlugs = (query.actor ?? []).filter((a) => actorForm(a) === 'slug');
  const engSlugs = scope.kind === 'site' ? (query.eng ?? []) : [];
  const searchChanges = scope.kind === 'site' && query.q !== undefined && query.q !== '';

  const [users, engagements, matches] = await Promise.all([
    actorSlugs.length
      ? db.user.findMany({ where: { slug: { in: actorSlugs } }, select: { id: true, slug: true } })
      : [],
    engSlugs.length
      ? db.engagement.findMany({
          where: { slug: { in: engSlugs } },
          select: { id: true, slug: true },
        })
      : [],
    searchChanges
      ? db.$queryRaw<{ id: number }[]>`
          SELECT id FROM audit_entries
           WHERE deleted_at IS NULL
             AND changes::text ILIKE ${likePattern(query.q!)} ESCAPE '\\'
           ORDER BY created_at DESC, id DESC
           LIMIT ${AUDIT_CHANGES_SEARCH_CAP}`
      : null,
  ]);

  return {
    userIdBySlug: new Map(users.map((u) => [u.slug, u.id])),
    engagementIdBySlug: new Map(engagements.map((e) => [e.slug, e.id])),
    changesMatchIds: matches ? matches.map((m) => m.id) : null,
  };
}

// ---------------------------------------------------------------------------
// buildAuditWhere — pure
// ---------------------------------------------------------------------------

/** A predicate no row satisfies; Prisma renders `in: []` as `1=0`. */
const NOTHING: Prisma.AuditEntryWhereInput = { id: { in: [] } };

/**
 * The typed `where` for both list routes. The scope predicate comes first and
 * is never conditional; every filter after it only narrows. Each `?actor=`
 * value becomes its own predicate and the values are ORed: a slug resolves to
 * the live account's id, a number is an id, anything with an `@` matches the
 * snapshotted email case-insensitively (which is how a hard-deleted user stays
 * filterable), and the literal `system` matches rows with no human actor. A
 * slug that resolves to no account matches nothing rather than 400ing — a
 * stale deep link to a since-deleted user shows an empty list, not an error.
 */
export function buildAuditWhere(
  scope: AuditScope,
  query: AuditListQuery,
  lookups: AuditWhereLookups = EMPTY_LOOKUPS,
): Prisma.AuditEntryWhereInput {
  const and: Prisma.AuditEntryWhereInput[] = [];

  // (1) Scope — first, unconditionally.
  if (scope.kind === 'engagement') {
    and.push({ engagementId: scope.engagementId });
  } else if (query.eng?.length || query.noEng) {
    // Site scope's engagement facet. Live engagements match by FK; the slug
    // branch REQUIRES a null FK, which is what makes a reused slug safe: a new
    // engagement that inherited a deleted one's slug never picks up the dead
    // one's rows, and the dead one's rows never attach to the new engagement.
    const or: Prisma.AuditEntryWhereInput[] = [];
    const liveIds = (query.eng ?? [])
      .map((slug) => lookups.engagementIdBySlug.get(slug))
      .filter((id): id is number => id !== undefined);
    if (liveIds.length) or.push({ engagementId: { in: liveIds } });
    if (query.eng?.length) or.push({ engagementId: null, engagementSlug: { in: query.eng } });
    if (query.noEng) or.push({ engagementId: null, engagementSlug: null });
    and.push({ OR: or });
  }

  // (2) Actor — ORed over the repeatable param.
  if (query.actor?.length) {
    and.push({
      OR: query.actor.map((value): Prisma.AuditEntryWhereInput => {
        switch (actorForm(value)) {
          case 'system':
            return { actorId: null, via: 'system' };
          case 'id':
            return { actorId: Number(value) };
          case 'email':
            return { actorEmail: { equals: value, mode: 'insensitive' } };
          case 'slug': {
            const id = lookups.userIdBySlug.get(value);
            return id === undefined ? NOTHING : { actorId: id };
          }
        }
      }),
    });
  }

  // (3) The closed-vocabulary filters.
  if (query.action?.length) and.push({ action: { in: query.action } });
  if (query.entity?.length) and.push({ entityType: { in: query.entity } });
  if (query.via) and.push({ via: query.via });
  if (query.entityId) and.push({ entityId: query.entityId });

  // (4) Date range on createdAt — the first save of a burst, which is what the
  // When column shows and what the `(…, created_at)` indexes order by.
  if (query.from || query.to) {
    and.push({
      createdAt: {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      },
    });
  }

  // (5) Free text. ILIKE over two unindexed text columns (see the module
  // header on cost), plus — site scope only, and only when the lookup ran —
  // the ids whose diff text matched. A removed entry has blank summary and
  // label and `[]` changes, so it is unreachable by `q`, which is the point of
  // removing it.
  if (query.q) {
    // Pre-escaped: see `escapeLike` — Prisma's `contains` does not escape.
    const needle = escapeLike(query.q);
    const or: Prisma.AuditEntryWhereInput[] = [
      { summary: { contains: needle, mode: 'insensitive' } },
      { entityLabel: { contains: needle, mode: 'insensitive' } },
    ];
    if (scope.kind === 'site' && lookups.changesMatchIds && lookups.changesMatchIds.length) {
      or.push({ id: { in: [...lookups.changesMatchIds] } });
    }
    and.push({ OR: or });
  }

  return { AND: and };
}

// ---------------------------------------------------------------------------
// Ordering and paging
// ---------------------------------------------------------------------------

/**
 * `when` -> createdAt, `who` -> actorName, `action` -> action. Every sort is
 * stable across page boundaries: `when` breaks ties on `id` in the same
 * direction (a coalesced burst shares one `createdAt` with nothing, but two
 * entries from one save can), and `who`/`action` always end in
 * `(createdAt desc, id desc)` so the rows under one name read newest-first.
 * Each key has a matching `(column, created_at DESC)` index. Nulls (the
 * System rows under `who`) follow Postgres's default — last ascending, first
 * descending — which is also the index order, so the sort stays an index walk.
 */
export function auditOrderBy(
  sort: AuditSortKey,
  dir: AuditSortDir,
): Prisma.AuditEntryOrderByWithRelationInput[] {
  const newestFirst: Prisma.AuditEntryOrderByWithRelationInput[] = [
    { createdAt: 'desc' },
    { id: 'desc' },
  ];
  switch (sort) {
    case 'who':
      return [{ actorName: dir }, ...newestFirst];
    case 'action':
      return [{ action: dir }, ...newestFirst];
    case 'when':
      return [{ createdAt: dir }, { id: dir }];
  }
}

/**
 * The deepest page either route will serve for a given page size. `page` is
 * clamped rather than refused so a stale `?page=` after rows were coalesced or
 * the page size changed still lands on a valid page; the response reports the
 * page actually served, and the UI's pager never offers one past it.
 */
export function maxAuditPage(pageSize: number): number {
  return Math.max(1, Math.ceil(AUDIT_MAX_OFFSET / pageSize));
}

export function clampAuditPage(p: Pagination): Pagination {
  const page = Math.min(p.page, maxAuditPage(p.pageSize));
  return { ...p, page, skip: (page - 1) * p.pageSize };
}

// ---------------------------------------------------------------------------
// listAuditEntries
// ---------------------------------------------------------------------------

/** The relations the serializer needs: live slugs and the actor's current name. */
export const auditEntryInclude = {
  actor: { select: { slug: true, firstName: true, lastName: true } },
  deletedBy: { select: { slug: true } },
} satisfies Prisma.AuditEntryInclude;

export async function listAuditEntries(
  db: PrismaClient,
  scope: AuditScope,
  query: AuditListQuery,
  pagination: Pagination,
): Promise<AuditLogPage> {
  const lookups = await resolveAuditLookups(db, scope, query);
  const where = buildAuditWhere(scope, query, lookups);
  const page = clampAuditPage(pagination);
  // Page + exact total in one batch: one connection, sequential, read-only.
  const [rows, total] = await db.$transaction([
    db.auditEntry.findMany({
      where,
      include: auditEntryInclude,
      orderBy: auditOrderBy(query.sort, query.dir),
      skip: page.skip,
      take: page.take,
    }),
    db.auditEntry.count({ where }),
  ]);
  return {
    items: rows.map((row) => serializeAuditEntry(row)),
    total,
    page: page.page,
    pageSize: page.pageSize,
  };
}

// ---------------------------------------------------------------------------
// auditFacets
// ---------------------------------------------------------------------------

/** The migration whose apply time is the day the log began. */
const AUDIT_LOG_MIGRATION = '20261010120000_audit_log';

/**
 * Memoised for the life of the process: the value is a constant of the
 * database, the facets are fetched once per view, and `_prisma_migrations` is
 * not a table the app should keep polling. Only a successful read is cached —
 * a transient failure returns null for this call and tries again next time.
 */
let logStartsAtMemo: Promise<Date | null> | null = null;

/**
 * When this database's log began: `finished_at` of the audit-log migration.
 * Null on a database the migration never stamped (a `db push` database has no
 * row, and may have no `_prisma_migrations` table at all), in which case the
 * UI omits its "nothing before this date can be shown" note.
 */
export function auditLogStartsAt(db: PrismaClient): Promise<Date | null> {
  if (logStartsAtMemo) return logStartsAtMemo;
  const read = db.$queryRaw<
    { finished_at: Date | null }[]
  >`SELECT finished_at FROM _prisma_migrations WHERE migration_name = ${AUDIT_LOG_MIGRATION} LIMIT 1`.then(
    (rows) => rows[0]?.finished_at ?? null,
    () => null,
  );
  // Cache the promise so concurrent first calls share one read; drop it if
  // the read failed so the next call retries.
  logStartsAtMemo = read;
  void read.then((value) => {
    if (value === null) logStartsAtMemo = null;
  });
  return read;
}

/** Test seam: forget the memoised value (a suite that migrates between cases). */
export function resetAuditLogStartsAt(): void {
  logStartsAtMemo = null;
}

const byLabel = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });

/**
 * The option lists a filter bar draws from, for the SCOPE (not the current
 * filters — facets are cached client-side and fetched once per view).
 *
 * Actors are folded by account, not by snapshot: a renamed user has several
 * `actorName` snapshots under one `actorId` and must be one option, labelled
 * by the live name (that is who the admin knows them as now; the rows
 * themselves keep showing the snapshot). The filter value is the live slug
 * when the account exists, else — the account is hard-deleted and the FK went
 * null — the snapshotted email, folded case-insensitively. Rows with no actor
 * at all become the single `system` option.
 *
 * `engagements` is returned ONLY under site scope: an engagement writer must
 * not be able to enumerate every engagement on the server, live or deleted,
 * through their own tab's facets. Live engagements come from the table with
 * their current names; deleted ones survive only as snapshots, read with
 * `DISTINCT ON (engagement_slug)` through the slug index so the cost is bounded
 * by the number of engagements ever deleted, not by log volume. A deleted
 * slug that a live engagement has since reused is not listed twice — the one
 * `?eng=` matches both through the OR-clause anyway.
 */
export async function auditFacets(db: PrismaClient, scope: AuditScope): Promise<AuditFacets> {
  const where: Prisma.AuditEntryWhereInput =
    scope.kind === 'engagement' ? { engagementId: scope.engagementId } : {};

  const [actorRows, actionRows, typeRows, logStartsAt] = await Promise.all([
    db.auditEntry.groupBy({ by: ['actorId', 'actorName', 'actorEmail'], where }),
    db.auditEntry.groupBy({ by: ['action'], where }),
    db.auditEntry.groupBy({ by: ['entityType'], where }),
    auditLogStartsAt(db),
  ]);

  const liveIds = [
    ...new Set(actorRows.map((r) => r.actorId).filter((id): id is number => id !== null)),
  ];
  const live = new Map(
    (
      await db.user.findMany({
        where: { id: { in: liveIds } },
        select: { id: true, slug: true, firstName: true, lastName: true, email: true },
      })
    ).map((u) => [u.id, u]),
  );

  const folded = new Map<string, AuditActorOption>();
  let system = false;
  for (const r of actorRows) {
    const user = r.actorId !== null ? live.get(r.actorId) : undefined;
    if (user) {
      if (!folded.has(user.slug)) {
        folded.set(user.slug, {
          value: user.slug,
          label: `${user.firstName} ${user.lastName}`.trim() || user.email,
          email: user.email,
          deleted: false,
        });
      }
      continue;
    }
    if (r.actorEmail === null && r.actorName === null) {
      system = true;
      continue;
    }
    // A deleted account (or, defensively, an FK with no row behind it): the
    // snapshot is all there is.
    const email = (r.actorEmail ?? '').toLowerCase();
    const key = email || `name:${r.actorName ?? ''}`;
    if (!folded.has(key)) {
      folded.set(key, {
        value: email || (r.actorName ?? ''),
        label: r.actorName ?? email,
        email: email || null,
        deleted: true,
      });
    }
  }
  const actors = [...folded.values()].sort(byLabel);
  if (system) {
    actors.push({
      value: SYSTEM_ACTOR_VALUE,
      label: SYSTEM_ACTOR_LABEL,
      email: null,
      deleted: false,
    });
  }

  // Present values in the vocabulary's own order, so the facet reads the way
  // the enum is documented; a value outside the enum (none this server writes)
  // is simply not offered.
  const present = new Set(actionRows.map((r) => r.action));
  const actions = AUDIT_ACTIONS.filter((a): a is AuditAction => present.has(a));
  const presentTypes = new Set(typeRows.map((r) => r.entityType));
  const entityTypes = AUDIT_ENTITY_TYPES.filter((t): t is AuditEntityType => presentTypes.has(t));

  const facets: AuditFacets = {
    actors,
    actions,
    entityTypes,
    logStartsAt: logStartsAt?.toISOString() ?? null,
  };
  if (scope.kind === 'site') facets.engagements = await engagementOptions(db);
  return facets;
}

async function engagementOptions(db: PrismaClient): Promise<AuditEngagementOption[]> {
  const [liveRows, goneRows] = await Promise.all([
    db.engagement.findMany({ select: { slug: true, name: true }, orderBy: { name: 'asc' } }),
    db.$queryRaw<{ engagement_slug: string; engagement_name: string | null }[]>`
      SELECT DISTINCT ON (engagement_slug) engagement_slug, engagement_name
        FROM audit_entries
       WHERE engagement_id IS NULL AND engagement_slug IS NOT NULL
       ORDER BY engagement_slug, created_at DESC`,
  ]);
  const liveSlugs = new Set(liveRows.map((e) => e.slug));
  const gone = goneRows
    .filter((g) => !liveSlugs.has(g.engagement_slug))
    .map((g): AuditEngagementOption => ({
      slug: g.engagement_slug,
      name: g.engagement_name ?? g.engagement_slug,
      deleted: true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return [...liveRows.map((e) => ({ slug: e.slug, name: e.name, deleted: false })), ...gone];
}

// ---------------------------------------------------------------------------
// removeAuditEntry — the one write
// ---------------------------------------------------------------------------

/**
 * Tamper-evident removal. Nothing leaves the table: the row is stamped with
 * who removed it, when and why, and its content (`summary`, `entityLabel`,
 * `changes`) is blanked in the same UPDATE — the guard trigger refuses the
 * transition without the stamp or with content left behind, and freezes the
 * row afterwards, so there is no second entry and no undo. Action, entity
 * type, entity id, actor snapshot and timestamps are kept, which is what lets
 * the tombstone still sort and filter into its place in the list.
 *
 * The remover's name and email are snapshotted like any actor's, so the
 * tombstone reads the same after the admin's own account is gone.
 *
 * 404 for an unknown uuid; 409 AUDIT_ENTRY_ALREADY_REMOVED for a row that is
 * already a tombstone — decided from the UPDATE's own `deletedAt: null` guard,
 * not only from the pre-read, so two admins removing the same entry at once
 * get one success and one 409 instead of a trigger error turned 500.
 */
export async function removeAuditEntry(
  db: PrismaClient,
  uuid: string,
  remover: AuthedUser,
  reason: string,
): Promise<AuditEntryRow> {
  return db.$transaction(async (tx) => {
    const target = await tx.auditEntry.findUnique({
      where: { uuid },
      select: { id: true, deletedAt: true },
    });
    if (!target) throw new HttpError(404, 'Audit entry not found');
    if (target.deletedAt) throw new HttpError(409, AUDIT_ENTRY_ALREADY_REMOVED);

    const stamped = await tx.auditEntry.updateMany({
      where: { id: target.id, deletedAt: null },
      data: {
        deletedAt: new Date(),
        deletedById: remover.id,
        deletedByName: `${remover.firstName} ${remover.lastName}`.trim() || remover.email,
        deletedByEmail: remover.email,
        deletedReason: reason,
        summary: '',
        entityLabel: '',
        changes: [],
      },
    });
    if (stamped.count === 0) throw new HttpError(409, AUDIT_ENTRY_ALREADY_REMOVED);

    return tx.auditEntry.findUniqueOrThrow({
      where: { id: target.id },
      include: auditEntryInclude,
    });
  });
}
