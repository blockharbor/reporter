/**
 * URL ⇄ state for both Audit log tabs (the engagement tab and Admin → Audit
 * log). Pure and React-free: the pages own the state in the URL and call
 * `parseAuditQuery` / `writeAuditQuery`; the hooks key on `auditQueryString`.
 *
 * The idiom is the evidence timeline's data model (server-filtered, server-
 * paginated, `{items,total,page,pageSize}`) wearing the findings URL idiom:
 * discrete readable params, defaults written as ABSENT keys, params this
 * module does not own preserved, junk ignored rather than refused. It is
 * deliberately not the evidence `?q=` mini-language — `ParsedQuery` is a wire
 * format shared with stored `SavedQuery.query` rows and the HMAC client, and an
 * audit filter is a plain faceted search, not an expression.
 *
 * ONE PARAM TABLE FOR BOTH TABS. `eng` and `noEng` are the site-wide tab's
 * engagement facet; the engagement route parses and ignores them, so a deep
 * link copied from the admin page into an engagement URL degrades to "that
 * engagement's log" rather than a 400. The names are, verbatim, the keys
 * `auditListQuerySchema` in @reporter/shared parses — the web app never
 * translates between a URL vocabulary and a wire vocabulary, except for two
 * things the URL keeps human-readable and the wire does not:
 *
 *  - `from`/`to` are `YYYY-MM-DD` in the URL (the shared `DateRange` shape the
 *    evidence bar's DateRangePicker also emits) and inclusive ISO day bounds on
 *    the wire, because `isoDateSchema` wants a full datetime. The bounds are the
 *    UTC ones `helpers/timeline-filter.ts` applies to an evidence `range:`, so
 *    the same date narrows both bars to the same instants.
 *  - `page`/`pageSize` ride only on the wire (`parsePagination` on the server);
 *    the URL carries `page` alone, and only past page 1.
 */
import { parsePageParam } from '../common/Pagination.js';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUDIT_MAX_OFFSET,
  AUDIT_SORT_KEYS,
  AUDIT_VIAS,
  isoDateSchema,
  slugSchema,
  type AuditAction,
  type AuditEntityType,
  type AuditSortDir,
  type AuditSortKey,
  type AuditVia,
  type DateRange,
} from '@reporter/shared';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface AuditFilterState {
  /** Free text, matched server-side against the summary and the entity label. */
  search: string;
  /**
   * Actor facet values as the facets endpoint hands them out — a live user's
   * slug, a deleted user's snapshotted email, or the literal `system`. ORed.
   */
  actors: string[];
  actions: AuditAction[];
  entityTypes: AuditEntityType[];
  /** How the actor reached the server; set by a deep link, cleared by its chip. */
  via: AuditVia | undefined;
  /** One record's history (its uuid or id); set by a deep link, cleared by its chip. */
  entityId: string | undefined;
  /** Inclusive local-date bounds, YYYY-MM-DD, either side open. */
  dateRange: DateRange | undefined;
  /** Site-wide tab only: engagement slugs, live or snapshotted. ORed with `noEngagement`. */
  engagements: string[];
  /** Site-wide tab only: entries that belong to no engagement. */
  noEngagement: boolean;
}

export const EMPTY_AUDIT_FILTER: AuditFilterState = {
  search: '',
  actors: [],
  actions: [],
  entityTypes: [],
  via: undefined,
  entityId: undefined,
  dateRange: undefined,
  engagements: [],
  noEngagement: false,
};

export function isAuditFilterActive(f: AuditFilterState): boolean {
  return (
    f.search.trim() !== '' ||
    f.actors.length > 0 ||
    f.actions.length > 0 ||
    f.entityTypes.length > 0 ||
    f.via !== undefined ||
    f.entityId !== undefined ||
    f.dateRange !== undefined ||
    f.engagements.length > 0 ||
    f.noEngagement
  );
}

export interface AuditSort {
  key: AuditSortKey;
  dir: AuditSortDir;
}

/** Column-header words for the status line; the keys themselves are shared. */
export const AUDIT_SORT_LABELS: Record<AuditSortKey, string> = {
  when: 'When',
  who: 'Who',
  action: 'Action',
};

/** First-click direction per column (EngagementsPage's FIRST_CLICK_DIRECTION idiom). */
export const AUDIT_FIRST_CLICK_DIR: Record<AuditSortKey, AuditSortDir> = {
  when: 'desc',
  who: 'asc',
  action: 'asc',
};

/** Newest first — the server's own default, so it is written as an absent key. */
export const DEFAULT_AUDIT_SORT: AuditSort = { key: 'when', dir: 'desc' };

export const isDefaultAuditSort = (s: AuditSort): boolean =>
  s.key === DEFAULT_AUDIT_SORT.key && s.dir === DEFAULT_AUDIT_SORT.dir;

export interface AuditLogQuery {
  filter: AuditFilterState;
  sort: AuditSort;
  /** 1-based; the server clamps it to the deepest page it will serve. */
  page: number;
}

export const EMPTY_AUDIT_QUERY: AuditLogQuery = {
  filter: EMPTY_AUDIT_FILTER,
  sort: DEFAULT_AUDIT_SORT,
  page: 1,
};

/**
 * Rows per page on both tabs. Sent explicitly rather than left to the server's
 * default so the pager's arithmetic and the request can never disagree.
 */
export const AUDIT_PAGE_SIZE = 50;

/**
 * Pages the pager may offer: the exact count, capped at the deepest page the
 * server will serve (`AUDIT_MAX_OFFSET`). Beyond the cap the server clamps and
 * reports the page it actually served; the pager never offers one past it.
 */
export function auditTotalPages(total: number, pageSize: number = AUDIT_PAGE_SIZE): number {
  const size = Math.max(1, pageSize);
  const exact = Math.max(1, Math.ceil(total / size));
  const deepest = Math.max(1, Math.ceil(AUDIT_MAX_OFFSET / size));
  return Math.min(exact, deepest);
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * The params the two tabs own — verbatim the server's querystring keys. List
 * params repeat their key (`action=create&action=update`), which is the form
 * the shared schema documents the web app as writing; a comma-joined value is
 * accepted on the way in for a hand-typed URL.
 */
export const AUDIT_PARAM = {
  search: 'q',
  actor: 'actor',
  action: 'action',
  entity: 'entity',
  via: 'via',
  entityId: 'entityId',
  from: 'from',
  to: 'to',
  engagement: 'eng',
  noEngagement: 'noEng',
  sort: 'sort',
  dir: 'dir',
  page: 'page',
} as const;

/** The wire-only key `parsePagination` reads; never written to the URL. */
const PAGE_SIZE_PARAM = 'pageSize';

/** Longest `q` the schema accepts; longer text is cut, not refused. */
const SEARCH_MAX_CHARS = 200;
const ENTITY_ID_MAX_CHARS = 128;

/**
 * Every value of a list param, whether the key repeated or a value was
 * comma-joined: trimmed, non-empty, first occurrence wins. A near-copy of
 * findings-filter.ts's private `splitList`; a ten-line duplicate is cheaper
 * than exporting a helper across feature modules.
 */
function listValues(params: URLSearchParams, key: string): string[] {
  const seen = new Set<string>();
  for (const raw of params.getAll(key)) {
    for (const part of raw.split(',')) {
      const v = part.trim();
      if (v !== '') seen.add(v);
    }
  }
  return [...seen];
}

/**
 * Keep only values the enum actually contains, in canonical enum order — a
 * hand-edited or stale URL cannot inject junk, and duplicates collapse.
 */
function pickEnum<T extends string>(values: string[], allowed: readonly T[]): T[] {
  const wanted = new Set(values);
  return allowed.filter((v) => wanted.has(v));
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date param as `YYYY-MM-DD`. Accepts the URL form, and — so a wire URL
 * pasted into the address bar still works — a full ISO datetime, reduced to
 * its date. Anything else is no bound.
 */
function ymdParam(raw: string | null): string {
  if (!raw) return '';
  if (YMD.test(raw)) return raw;
  if (isoDateSchema.safeParse(raw).success) return raw.slice(0, 10);
  return '';
}

/** Read filter + sort + page out of the URL. Unknown or malformed values are ignored. */
export function parseAuditQuery(params: URLSearchParams): AuditLogQuery {
  const from = ymdParam(params.get(AUDIT_PARAM.from));
  const to = ymdParam(params.get(AUDIT_PARAM.to));
  const sortKey = AUDIT_SORT_KEYS.find((k) => k === params.get(AUDIT_PARAM.sort));
  const dirParam = params.get(AUDIT_PARAM.dir);
  const entityId = params.get(AUDIT_PARAM.entityId)?.trim().slice(0, ENTITY_ID_MAX_CHARS) ?? '';
  const noEng = params.get(AUDIT_PARAM.noEngagement);

  return {
    filter: {
      search: (params.get(AUDIT_PARAM.search) ?? '').slice(0, SEARCH_MAX_CHARS),
      actors: listValues(params, AUDIT_PARAM.actor),
      actions: pickEnum(listValues(params, AUDIT_PARAM.action), AUDIT_ACTIONS),
      entityTypes: pickEnum(listValues(params, AUDIT_PARAM.entity), AUDIT_ENTITY_TYPES),
      via: AUDIT_VIAS.find((v) => v === params.get(AUDIT_PARAM.via)),
      entityId: entityId === '' ? undefined : entityId,
      dateRange: from || to ? { from, to } : undefined,
      // Only well-formed slugs: the schema would 400 the whole list on one bad value.
      engagements: listValues(params, AUDIT_PARAM.engagement).filter(
        (s) => slugSchema.safeParse(s).success,
      ),
      noEngagement: noEng === '1' || noEng === 'true',
    },
    sort: {
      key: sortKey ?? DEFAULT_AUDIT_SORT.key,
      // A direction is honoured only beside a recognised key: `?dir=asc` alone
      // is meaningless and claims nothing, and a key with no (or a junk)
      // direction takes its own first-click direction.
      dir:
        sortKey !== undefined && (dirParam === 'asc' || dirParam === 'desc')
          ? dirParam
          : AUDIT_FIRST_CLICK_DIR[sortKey ?? DEFAULT_AUDIT_SORT.key],
    },
    page: parsePageParam(params.get(AUDIT_PARAM.page)),
  };
}

/**
 * The filter and sort half of a querystring, shared by the URL and the wire.
 * Appends to `next` in place; the caller decides which bag and what else goes
 * in it. `dates` chooses the URL's `YYYY-MM-DD` or the wire's ISO day bounds.
 */
function writeFilterAndSort(
  next: URLSearchParams,
  { filter, sort }: Pick<AuditLogQuery, 'filter' | 'sort'>,
  dates: 'ymd' | 'iso',
): void {
  if (filter.search.trim() !== '') next.set(AUDIT_PARAM.search, filter.search);
  for (const a of filter.actors) next.append(AUDIT_PARAM.actor, a);
  for (const a of filter.actions) next.append(AUDIT_PARAM.action, a);
  for (const e of filter.entityTypes) next.append(AUDIT_PARAM.entity, e);
  if (filter.via) next.set(AUDIT_PARAM.via, filter.via);
  if (filter.entityId) next.set(AUDIT_PARAM.entityId, filter.entityId);
  if (filter.dateRange?.from) {
    const from = filter.dateRange.from;
    next.set(AUDIT_PARAM.from, dates === 'iso' ? `${from}T00:00:00.000Z` : from);
  }
  if (filter.dateRange?.to) {
    const to = filter.dateRange.to;
    next.set(AUDIT_PARAM.to, dates === 'iso' ? `${to}T23:59:59.999Z` : to);
  }
  for (const s of filter.engagements) next.append(AUDIT_PARAM.engagement, s);
  if (filter.noEngagement) next.set(AUDIT_PARAM.noEngagement, '1');
  // The default sort stays out entirely; it is the server's default too.
  if (!isDefaultAuditSort(sort)) {
    next.set(AUDIT_PARAM.sort, sort.key);
    next.set(AUDIT_PARAM.dir, sort.dir);
  }
}

/**
 * Serialize the view back into `current`, preserving any param this module
 * does not own (the Admin page's `tab`, for one). Defaults are written as
 * ABSENT keys, so an unfiltered, newest-first first page has a clean URL.
 */
export function writeAuditQuery(current: URLSearchParams, q: AuditLogQuery): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of Object.values(AUDIT_PARAM)) next.delete(key);
  writeFilterAndSort(next, q, 'ymd');
  if (q.page > 1) next.set(AUDIT_PARAM.page, String(q.page));
  return next;
}

/**
 * The canonical querystring for `useAuditLog` / `useAdminAuditLog` — exactly
 * what `auditListQuerySchema` plus the server's `parsePagination` parse. Built
 * from a blank bag so a foreign URL param never reaches the server, and it is
 * the query key, so two views that differ in any filter, the sort or the page
 * never share a cache entry.
 */
export function auditQueryString(q: AuditLogQuery): string {
  const next = new URLSearchParams();
  writeFilterAndSort(next, q, 'iso');
  if (q.page > 1) next.set(AUDIT_PARAM.page, String(q.page));
  next.set(PAGE_SIZE_PARAM, String(AUDIT_PAGE_SIZE));
  return next.toString();
}
