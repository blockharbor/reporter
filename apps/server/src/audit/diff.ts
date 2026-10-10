/**
 * The backstop's diff: a row before and after, through a model spec, to the
 * `AuditChange[]` the shared schema accepts. Pure functions, unit-tested beside
 * the code; the extension in extension.ts is the only caller.
 *
 * The rules, all inherited from the diff helpers in services/audit.ts so that a
 * backstop entry and an intent entry about the same edit read the same:
 *
 *  - Scalars compare after normalisation: a Date becomes its ISO string, and
 *    `undefined` and `''` collapse to null, so "cleared" and "never set" are
 *    one state and a row that came back from Prisma matches one assembled from
 *    `args.data`.
 *  - A column in `fields` that is also in REDACTED_FIELDS is detected by its real
 *    value and stored as its opaque stand-in; it is never serialised.
 *  - A column in neither `fields` nor `lists` nor `structured` — every `ignore`
 *    column, and anything the allowlist left out — is not read and cannot
 *    produce a change. An update whose only differences are there yields an
 *    EMPTY diff, and the extension writes nothing for an empty diff. That is
 *    deliberate: a `lastLogin` stamp, an `updatedAt` bump or a blob key
 *    rotation is not an event anyone asked to see.
 *  - A list column is two arrays of `{ label, hash }` refs; item bodies never
 *    land in the log (see models.ts for why the diagram ref is cheap).
 *
 * A create or a delete is the same diff against an empty row, so a create reads
 * "title: null -> Weak TLS" and a delete reads the reverse, with the same
 * redaction and the same list refs. Nested relation writes inside `args.data`
 * (`tags: { create: [...] }`, `identities: { create: {...} }`) are NOT separate
 * Prisma operations and never reach the extension on their own; they are
 * summarised here as counts on the parent's entry — counts only, because the
 * nested payload may carry a credential (the password hash in a user create).
 */
import type { AuditChange } from '@reporter/shared';
import {
  diffEngagement,
  diffFields,
  diffList,
  diffReportConfig,
  type EngagementAuditRow,
} from '../services/audit.js';
import type { AuditRow, RowSpec } from './models.js';

// ---------------------------------------------------------------------------
// diffRow
// ---------------------------------------------------------------------------

/**
 * Dedicated differs for JSON object columns. Keyed by the shape, not the
 * column: `Engagement.reportConfig` and `ReportTemplate.config` hold the same
 * shape, and the differ's `reportConfig.<key>` field names are re-prefixed with
 * the actual column so a template's entry says `config.sections`.
 */
const STRUCTURED_DIFFS: Record<
  RowSpec['structured'][string],
  (before: unknown, after: unknown) => AuditChange[]
> = {
  reportConfig: diffReportConfig,
};

/** Whole-row differs a spec may name instead of the generic column walk. */
const CUSTOM_DIFFS: Record<
  NonNullable<RowSpec['diff']>,
  (b: AuditRow, a: AuditRow) => AuditChange[]
> = {
  // The 30-column save, exactly as the intent path records it, plus the two
  // columns that differ leaves to their own handlers: the slug (never edited
  // through the PUT) and the verbatim proposal import, stored as a blob size.
  engagement: (b, a) => [
    ...diffFields(b, a, ['slug', 'proposalImport']),
    ...diffEngagement(b as unknown as EngagementAuditRow, a as unknown as EngagementAuditRow),
  ],
};

function reprefix(changes: AuditChange[], column: string): AuditChange[] {
  return changes.map((c) =>
    'field' in c ? { ...c, field: c.field.replace(/^reportConfig\./, `${column}.`) } : c,
  );
}

/** The changes between two images of a row, per the spec. Empty when nothing audited moved. */
export function diffRow(before: AuditRow, after: AuditRow, spec: RowSpec): AuditChange[] {
  if (spec.diff) return CUSTOM_DIFFS[spec.diff](before, after);
  return [
    ...diffFields(before, after, spec.fields),
    ...Object.entries(spec.lists).flatMap(([field, ref]) =>
      diffList(before, after, { field, items: (r) => r[field], ref }),
    ),
    ...Object.entries(spec.structured).flatMap(([column, shape]) =>
      reprefix(STRUCTURED_DIFFS[shape](before[column], after[column]), column),
    ),
  ];
}

const EMPTY: AuditRow = {};

/** A create is the diff from nothing; a delete the diff to nothing. */
export function snapshotChanges(
  row: AuditRow,
  spec: RowSpec,
  kind: 'create' | 'delete',
): AuditChange[] {
  return kind === 'create' ? diffRow(EMPTY, row, spec) : diffRow(row, EMPTY, spec);
}

// ---------------------------------------------------------------------------
// After-images
// ---------------------------------------------------------------------------

/**
 * Prisma's atomic/relational operators inside `data`. A value that is a plain
 * object with exactly one of these keys is an operation, not a JSON value.
 */
const ATOMIC_OPS = new Set([
  'set',
  'increment',
  'decrement',
  'multiply',
  'divide',
  'push',
  'unset',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * The value a column ends up holding after `data[column]` is applied to
 * `before[column]`, for the `updateMany` path where Prisma returns only a count.
 * Plain values are taken as-is; `{ set }` unwraps; the arithmetic operators are
 * applied when the current value is a number; anything else keeps the before
 * value, which under-reports rather than invents.
 */
function applied(before: unknown, value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !ATOMIC_OPS.has(keys[0]!)) return value;
  const op = keys[0]!;
  const arg = value[op];
  if (op === 'set') return arg;
  if (typeof before !== 'number' || typeof arg !== 'number') return before;
  switch (op) {
    case 'increment':
      return before + arg;
    case 'decrement':
      return before - arg;
    case 'multiply':
      return before * arg;
    case 'divide':
      return arg === 0 ? before : before / arg;
    default:
      return before;
  }
}

/**
 * `before` with every one of `columns` that `data` names applied over it — a
 * row spec's `select`, or a link row's key and content columns. A column `data`
 * does not mention keeps its before value, which is also how a create starts:
 * `afterImage({}, args.data, columns)` is the row as far as the payload says.
 */
export function afterImage(before: AuditRow, data: unknown, columns: readonly string[]): AuditRow {
  const after: AuditRow = { ...before };
  if (!isPlainObject(data)) return after;
  for (const column of columns) {
    if (column in data) after[column] = applied(before[column], data[column]);
  }
  return after;
}

/**
 * `before` overlaid with a returned row (an `update`/`create` result), when
 * the caller's own `select` may have trimmed it: only the named columns are
 * taken, and only when present. The returned row wins over the payload, since
 * it carries the defaults and the database-generated values the payload lacks.
 */
export function overlay(before: AuditRow, result: unknown, columns: readonly string[]): AuditRow {
  const after: AuditRow = { ...before };
  if (!isPlainObject(result)) return after;
  for (const column of columns) {
    if (column in result) after[column] = result[column];
  }
  return after;
}

// ---------------------------------------------------------------------------
// Nested writes
// ---------------------------------------------------------------------------

/** Relation operators Prisma accepts inside `data`, with the word the summary uses. */
const NESTED_OPS: Record<string, string> = {
  create: 'created',
  createMany: 'created',
  connectOrCreate: 'connected',
  connect: 'connected',
  set: 'set',
  disconnect: 'disconnected',
  update: 'updated',
  updateMany: 'updated',
  upsert: 'upserted',
  delete: 'deleted',
  deleteMany: 'deleted',
};

/** `tags` -> "Tags", `evidencePrefs` -> "Evidence prefs". */
function relationLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function itemCount(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (isPlainObject(v) && 'data' in v && Array.isArray(v.data)) return v.data.length;
  return 1;
}

/**
 * One `count` change per relation operator found at the top level of
 * `args.data`: `{ tags: { create: [a, b, c] }, roles: { create: {...} } }` ->
 * "Tags created: 3", "Roles created: 1". Payload contents are never read.
 */
export function summarizeNested(data: unknown): AuditChange[] {
  if (!isPlainObject(data)) return [];
  const out: AuditChange[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!isPlainObject(value)) continue;
    const ops = Object.keys(value).filter((k) => k in NESTED_OPS);
    if (ops.length === 0 || ops.length !== Object.keys(value).length) continue;
    for (const op of ops) {
      out.push({
        kind: 'count',
        label: `${relationLabel(key)} ${NESTED_OPS[op]}`,
        count: itemCount(value[op]),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** Rows a write touched, from its result: `{ count }`, a returned array, or one. */
export function countOf(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (isPlainObject(result) && typeof result.count === 'number') return result.count;
  return 1;
}

/** `args.data` of a create*: one row, or several. */
export function dataRows(data: unknown): AuditRow[] {
  if (Array.isArray(data)) return data.filter(isPlainObject);
  return isPlainObject(data) ? [data] : [];
}
