/**
 * The audit backstop: a Prisma client extension that records every write the
 * handlers did not describe themselves.
 *
 * WHY TWO LAYERS. The hand-written intent entries (services/audit.ts, called
 * from the handlers) say what a change MEANT — "reordered the goals", "merged
 * tag A into tag B" — and the backstop says what HAPPENED at the row level for
 * everything else, so a new route, a side-effect write inside an old one, or a
 * script poking at `app.db` can never be an unrecorded change. The two share one
 * write path: the backstop builds `AuditEntryInput`s and hands them to
 * `recordAudit` / `recordUpdate` stamped `source: 'backstop'`, so actor
 * snapshots, redaction, caps, validation and the coalescing fold are applied
 * once, in one place, whichever layer wrote the row.
 *
 * HOW IT SEES A WRITE. `createAuditedDb` wraps the one `PrismaClient` the app
 * constructs with a `query.$allModels.$allOperations` extension. Every model
 * operation passes through `backstop()` below, which decides — in an order that
 * is load-bearing and documented on the function — whether to record it, and
 * then does so by pre-reading the rows the write will touch (through the
 * UNEXTENDED base client, so the backstop's own reads never re-enter it),
 * running the write, diffing before against after through the model's spec in
 * models.ts, and recording. A create is a snapshot from nothing; a delete the
 * reverse, plus the relation counts a database cascade is about to take with it;
 * an update one coalescable entry per changed field. Join rows are recorded on
 * their owner (`link`/`unlink` on the goal or finding; a tag application as a
 * `tags` list change on the evidence or finding) because nobody wants to read
 * "created evidence_tag #4411".
 *
 * WHAT IT CANNOT SEE, and what covers it:
 *
 *  - Writes inside an interactive `$transaction` (and the promises of a batch
 *    `$transaction([...])`). The pre-read would run on another connection with
 *    the wrong before-image, and an entry written outside the transaction would
 *    describe a change a rollback then erases. DECISIONS (2026-10-09) chose the
 *    maintenance rule over Prisma's undocumented transaction internals: every
 *    transaction that touches an audited model is wrapped in `withIntent(models,
 *    fn)` and records its own entries; an unwrapped one is skipped here and
 *    logged as an error naming the model and operation. The only internal this
 *    file reads is the presence of `__internalParams.transaction` on the
 *    callback's params — a boolean tripwire, never a client — and the only
 *    consequence of a Prisma upgrade removing it would be a transactional write
 *    recorded outside its transaction, which the dedicated itest would show.
 *  - Database-level cascades (`onDelete: Cascade`). Invisible to any client
 *    extension; the Engagement delete pre-reads `_count` of every cascading
 *    relation and says "with 212 evidence, 14 findings" on the one entry.
 *  - Nested relation writes inside `args.data` (`tags: { create: [...] }`). Not
 *    separate operations; summarised as counts on the parent's entry, counts
 *    only, because the nested payload of a user create carries a password hash.
 *  - Raw SQL (`$queryRaw` / `$executeRaw`) bypasses the extension entirely, so
 *    nothing issued that way is recorded. Most such statements only read (a
 *    `FOR UPDATE` select, the advisory locks, the audit read API's
 *    `changes::text` search and facet scans); the one that writes is the audit
 *    writer's own coalescing fold (services/audit.ts), an UPDATE of
 *    `audit_entries` that must not be seen here — and is not, because the
 *    backstop skips that table unconditionally (check 3).
 *  - A second `PrismaClient`. Only prisma/seed.ts constructs one, through this
 *    factory. Do not add another.
 *
 * COST. An update or delete costs one SELECT before the write; every recorded
 * entry costs one INSERT, or for an update the lock-and-fold transaction in
 * services/audit.ts. Parent lookups (which engagement a goal belongs to, what a
 * membership's user is called) are memoised per request through the context's
 * cache. Bulk writes (`updateMany`, `deleteMany`, `createMany`) pre-read at most
 * AUDIT_BULK_ROW_CAP + 1 rows and record the first AUDIT_BULK_ROW_CAP as
 * individual entries plus one summary carrying the true total.
 *
 * FAILURE POLICY. The backstop never fails a user's request: a pre-read that
 * throws skips the recording with a warning (no before-image means no honest
 * diff — under-reporting beats inventing), and a failure after the write is
 * logged and swallowed. The write itself is never retried or altered; `query`
 * is called exactly once with the caller's own `args`.
 *
 * THE CAST. `$extends` returns a type that is not assignable to `PrismaClient`
 * (its delegate argument types are re-derived), nor is the `tx` its
 * `$transaction` yields assignable to `Prisma.TransactionClient`. Seventeen
 * service signatures take one or the other. A query-only extension changes no
 * argument or result type and drops only `$on`, which nothing on the server
 * calls, so the extended client is cast back to `PrismaClient` here, once, and
 * `FastifyInstance.db` keeps its type. If this extension ever grows a `result`
 * or `model` component the cast would start lying about types and must go.
 */
import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIT_BULK_ROW_CAP, type AuditAction, type AuditChange } from '@reporter/shared';
import { getAuditContext, isSuppressed, tallyWrite, type AuditContext } from './context.js';
import {
  afterImage,
  countOf,
  dataRows,
  diffRow,
  overlay,
  snapshotChanges,
  summarizeNested,
} from './diff.js';
import {
  MODEL_SPECS,
  delegateOf,
  refOf,
  type AuditRow,
  type LinkSpec,
  type Lookups,
  type ModelSpec,
  type Owner,
  type OwnerTagsSpec,
  type RowSpec,
  type WriteKind,
} from './models.js';
import {
  auditCtxFromContext,
  diffFields,
  diffList,
  n,
  q,
  recordAudit,
  recordUpdate,
  type AuditCtx,
  type EngagementRef,
} from '../services/audit.js';

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Every Prisma model operation that writes, with the kind of write it is. */
const WRITE_OPERATIONS = {
  create: 'create',
  createMany: 'create',
  createManyAndReturn: 'create',
  update: 'update',
  updateMany: 'update',
  updateManyAndReturn: 'update',
  upsert: 'upsert',
  delete: 'delete',
  deleteMany: 'delete',
} as const satisfies Record<string, WriteKind | 'upsert'>;

type WriteOperation = keyof typeof WRITE_OPERATIONS;

/** The operations whose `where` names one row, pre-read with `findUnique`. */
const SINGLE_ROW: ReadonlySet<WriteOperation> = new Set(['update', 'delete', 'upsert']);
/** The operations whose `where` names many rows, pre-read with `findMany` up to the cap. */
const MANY_ROWS: ReadonlySet<WriteOperation> = new Set([
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]);

/** The arguments a write operation can carry, as far as the backstop reads them. */
interface WriteArgs {
  where?: unknown;
  data?: unknown;
  create?: unknown;
  update?: unknown;
}

/** The two reads the backstop issues, on whichever delegate the write names. */
interface ReadDelegate {
  findUnique(args: object): Promise<AuditRow | null>;
  findMany(args: object): Promise<AuditRow[]>;
}

/** Everything one write carries through the backstop. */
interface Write {
  base: PrismaClient;
  log: FastifyBaseLogger;
  ctx: AuditContext | undefined;
  model: string;
  operation: WriteOperation;
  spec: ModelSpec;
  args: WriteArgs;
  query: (args: unknown) => Promise<unknown>;
}

/** What the pre-read found, before the write ran. */
interface PreRead {
  /** The one row an update/delete/upsert targets; null when absent (or for a create). */
  before: AuditRow | null;
  /** The rows a bulk write targets, at most AUDIT_BULK_ROW_CAP + 1 of them. */
  rows: AuditRow[];
  /** ownerTags only: every distinct owner id the write touches, at most cap + 1. */
  ownerIds: number[];
  /** ownerTags only: the first cap owners with their tag lists before the write. */
  owners: Map<number, (Owner & { tags: string[] }) | null>;
}

const NOTHING: PreRead = { before: null, rows: [], ownerIds: [], owners: new Map() };

// ---------------------------------------------------------------------------
// createAuditedDb
// ---------------------------------------------------------------------------

/**
 * Wrap the app's Prisma client with the backstop. `log` is the app logger; the
 * request logger is not reachable from an extension callback, so the entries
 * themselves carry no request id and the error and warning lines here carry
 * the model and operation instead.
 */
export function createAuditedDb(base: PrismaClient, log: FastifyBaseLogger): PrismaClient {
  const extended = base.$extends({
    name: 'audit-backstop',
    query: {
      $allModels: {
        async $allOperations(params) {
          const { model, operation, args, query } = params;
          return backstop(
            base,
            log,
            model,
            operation,
            args as WriteArgs,
            query as (args: unknown) => Promise<unknown>,
            transactionOf(params),
          );
        },
      },
    },
  });
  // See THE CAST in the module header.
  return extended as unknown as PrismaClient;
}

/**
 * The decision, in an order that is load-bearing:
 *
 *  1. No spec for the model -> not audited, pass through. (`UNAUDITED_MODELS`
 *     in models.ts names each one and why.)
 *  2. Not a write, or a write kind the spec opted out of -> pass through.
 *     Reads come first so a read-only batch `$transaction([findMany, count])`
 *     never reaches the transaction check below.
 *  3. The AuditEntry model itself -> always pass through. Structurally covered by
 *     (1), kept explicit so that giving the log a spec one day cannot recurse.
 *  4. Suppressed for this model (`withIntent`) or for every model
 *     (`withImporter` bumps `suppressAll`) -> tally the write into the context so
 *     the scope's end can check that something was recorded, then skip silently.
 *  5. An importer is active -> count the rows into `importer.counts` (keyed by
 *     the Prisma model name) and skip; the importer turns the counts into one
 *     summary entry. An importer scope is also a suppressed scope, so (4) has
 *     already tallied.
 *  6. Inside a transaction (interactive or batch) -> skip AND log an error
 *     naming the model and operation: an unsuppressed transactional write is a
 *     handler that forgot its `withIntent` wrap. See the module header for why
 *     recording it here would be worse than not recording it.
 *  7. Otherwise record: pre-read, write, diff, record.
 */
async function backstop(
  base: PrismaClient,
  log: FastifyBaseLogger,
  model: string,
  operation: string,
  args: WriteArgs,
  query: (args: unknown) => Promise<unknown>,
  transaction: string | null,
): Promise<unknown> {
  const spec = (MODEL_SPECS as Partial<Record<string, ModelSpec>>)[model];
  if (!spec) return query(args); // (1)
  const write = writeOperation(operation, spec);
  if (!write) return query(args); // (2)
  if (model === 'AuditEntry') return query(args); // (3)

  const ctx = getAuditContext();
  const delegate = delegateOf(model);
  if (ctx && isSuppressed(ctx, delegate)) {
    tallyWrite(ctx, delegate); // (4)
    if (!ctx.importer) return query(args);
  }
  if (ctx?.importer) {
    const result = await query(args); // (5)
    ctx.importer.counts[model] = (ctx.importer.counts[model] ?? 0) + countOf(result);
    return result;
  }
  if (transaction) {
    log.error(
      { model, operation, transaction },
      'audit: a write inside a transaction was not recorded — wrap the $transaction in withIntent naming this model',
    ); // (6)
    return query(args);
  }
  return recordWrite({ base, log, ctx, model, operation: write, spec, args, query }); // (7)
}

/** The write operation, or null when `operation` is a read or a kind this spec opted out of. */
function writeOperation(operation: string, spec: ModelSpec): WriteOperation | null {
  if (!(operation in WRITE_OPERATIONS)) return null;
  const op = operation as WriteOperation;
  const kind = WRITE_OPERATIONS[op];
  // An upsert is decided after the pre-read (create or update); every other
  // kind can be refused here.
  if (spec.kind === 'row' && kind !== 'upsert' && !spec.ops.includes(kind)) return null;
  return op;
}

/**
 * The only Prisma internal this file reads: whether the operation runs under a
 * transaction, and of which kind. Prisma 6 passes the request params to every
 * query-extension callback as `__internalParams`; its `transaction` is
 * `{ kind: 'itx', ... }` inside `$transaction(async tx => …)`, `{ kind: 'batch',
 * ... }` for `$transaction([...])`, and absent otherwise. Read defensively: an
 * upgrade that renames it would make this return null, never throw.
 */
function transactionOf(params: object): string | null {
  const internal = (params as { __internalParams?: { transaction?: { kind?: unknown } } })
    .__internalParams;
  const tx = internal?.transaction;
  if (!tx || typeof tx !== 'object') return null;
  return typeof tx.kind === 'string' ? tx.kind : 'unknown';
}

// ---------------------------------------------------------------------------
// recordWrite — step 7
// ---------------------------------------------------------------------------

async function recordWrite(w: Write): Promise<unknown> {
  const l = lookupsFor(w.base, w.ctx);
  let pre: PreRead;
  try {
    pre = await preRead(w, l);
  } catch (err) {
    w.log.warn(
      { err, model: w.model, operation: w.operation },
      'audit: pre-read failed; this write will not be recorded',
    );
    return w.query(w.args);
  }

  const result = await w.query(w.args);

  try {
    const actx = auditCtxFromContext(w.base, w.log);
    switch (w.spec.kind) {
      case 'row':
        await recordRow(w, w.spec, l, actx, pre, result);
        break;
      case 'link':
        await recordLink(w, w.spec, l, actx, pre, result);
        break;
      case 'ownerTags':
        await recordOwnerTags(w, w.spec, l, actx, pre, result);
        break;
    }
  } catch (err) {
    w.log.error(
      { err, model: w.model, operation: w.operation },
      'audit: the backstop failed to record a write; the request continues',
    );
  }
  return result;
}

/**
 * The resolvers' view of the database: the unextended client and a memo that
 * lives in the request's context cache (or, outside a request, for this one
 * write), so a bulk write under one parent resolves the parent once.
 */
function lookupsFor(base: PrismaClient, ctx: AuditContext | undefined): Lookups {
  const cache = ctx?.cache ?? new Map<string, unknown>();
  return {
    db: base,
    async memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
      if (cache.has(key)) return cache.get(key) as T;
      const value = await fn();
      cache.set(key, value);
      return value;
    },
  };
}

function delegateFor(base: PrismaClient, model: string): ReadDelegate {
  return (base as unknown as Record<string, ReadDelegate>)[delegateOf(model)]!;
}

/** The pre-read SELECT: the spec's columns, plus the cascade counts on a delete. */
function selectFor(spec: RowSpec, forDelete: boolean): Record<string, unknown> {
  const select: Record<string, unknown> = Object.fromEntries(spec.select.map((c) => [c, true]));
  if (forDelete && spec.cascadeCounts) {
    select._count = {
      select: Object.fromEntries(Object.keys(spec.cascadeCounts).map((k) => [k, true])),
    };
  }
  return select;
}

async function preRead(w: Write, l: Lookups): Promise<PreRead> {
  const { spec, operation, args } = w;
  const d = delegateFor(w.base, w.model);

  if (spec.kind === 'ownerTags') {
    const ownerIds = await ownerIdsOf(w, d);
    const owners = new Map<number, (Owner & { tags: string[] }) | null>();
    for (const id of ownerIds.slice(0, AUDIT_BULK_ROW_CAP)) owners.set(id, await spec.owner(id, l));
    return { ...NOTHING, ownerIds, owners };
  }

  const forDelete = operation === 'delete' || operation === 'deleteMany';
  const select = spec.kind === 'row' ? { select: selectFor(spec, forDelete) } : {};
  if (SINGLE_ROW.has(operation)) {
    return { ...NOTHING, before: await d.findUnique({ where: args.where, ...select }) };
  }
  if (MANY_ROWS.has(operation)) {
    const rows = await d.findMany({ where: args.where, take: AUDIT_BULK_ROW_CAP + 1, ...select });
    return { ...NOTHING, rows };
  }
  return NOTHING;
}

/** The distinct owner ids a tag-row write touches: from the payload for creates, from the rows otherwise. */
async function ownerIdsOf(w: Write, d: ReadDelegate): Promise<number[]> {
  const spec = w.spec as OwnerTagsSpec;
  const { operation, args } = w;
  const key = spec.ownerKey;
  let rows: AuditRow[];
  if (operation === 'create') rows = dataRows(args.data);
  else if (operation === 'createMany' || operation === 'createManyAndReturn')
    rows = dataRows(args.data);
  else if (operation === 'upsert') {
    const before = await d.findUnique({ where: args.where, select: { [key]: true } });
    rows = before ? [before] : dataRows(args.create);
  } else if (SINGLE_ROW.has(operation)) {
    const before = await d.findUnique({ where: args.where, select: { [key]: true } });
    rows = before ? [before] : [];
  } else {
    rows = await d.findMany({
      where: args.where,
      select: { [key]: true },
      take: AUDIT_BULK_ROW_CAP + 1,
    });
  }
  const ids = new Set<number>();
  for (const row of rows) {
    const id = num(row[key]);
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Row specs
// ---------------------------------------------------------------------------

async function recordRow(
  w: Write,
  spec: RowSpec,
  l: Lookups,
  actx: AuditCtx,
  pre: PreRead,
  result: unknown,
): Promise<void> {
  const { operation, args } = w;
  const cols = spec.select;
  switch (operation) {
    case 'create':
      return rowCreated(
        spec,
        l,
        actx,
        overlay(afterImage({}, args.data, cols), result, cols),
        args.data,
      );
    case 'upsert': {
      if (pre.before) {
        if (!spec.ops.includes('update')) return;
        const after = overlay(afterImage(pre.before, args.update, cols), result, cols);
        return rowUpdated(spec, l, actx, pre.before, after, args.update);
      }
      if (!spec.ops.includes('create')) return;
      return rowCreated(
        spec,
        l,
        actx,
        overlay(afterImage({}, args.create, cols), result, cols),
        args.create,
      );
    }
    case 'update': {
      if (!pre.before) return;
      const after = overlay(afterImage(pre.before, args.data, cols), result, cols);
      return rowUpdated(spec, l, actx, pre.before, after, args.data);
    }
    case 'delete':
      if (!pre.before) return;
      return rowDeleted(spec, l, actx, pre.before);
    case 'createMany':
    case 'createManyAndReturn': {
      const rows =
        operation === 'createManyAndReturn' && Array.isArray(result)
          ? (result as AuditRow[])
          : dataRows(args.data);
      for (const row of rows.slice(0, AUDIT_BULK_ROW_CAP))
        await rowCreated(spec, l, actx, row, null);
      if (rows.length > AUDIT_BULK_ROW_CAP) {
        await overflow(actx, 'create', spec, Math.max(rows.length, countOf(result)), rows, l);
      }
      return;
    }
    case 'updateMany':
    case 'updateManyAndReturn': {
      for (const row of pre.rows.slice(0, AUDIT_BULK_ROW_CAP)) {
        await rowUpdated(spec, l, actx, row, afterImage(row, args.data, cols), null);
      }
      if (pre.rows.length > AUDIT_BULK_ROW_CAP) {
        await overflow(actx, 'update', spec, countOf(result), pre.rows, l);
      }
      return;
    }
    case 'deleteMany': {
      for (const row of pre.rows.slice(0, AUDIT_BULK_ROW_CAP)) await rowDeleted(spec, l, actx, row);
      if (pre.rows.length > AUDIT_BULK_ROW_CAP) {
        await overflow(actx, 'delete', spec, countOf(result), pre.rows, l);
      }
      return;
    }
  }
}

/** The public id for an update entry, which must be non-null: the spec's, else the key columns joined. */
function entityIdOf(spec: RowSpec, after: AuditRow, before: AuditRow): string {
  return (
    spec.entityId(after) ??
    spec.entityId(before) ??
    spec.idFields.map((f) => String(before[f] ?? after[f] ?? '')).join(':')
  );
}

/** `(Tags created: 6, Roles created: 1)` from the nested counts, or nothing. */
function nestedSuffix(nested: AuditChange[]): string {
  const parts = nested.flatMap((c) => (c.kind === 'count' ? [`${c.label}: ${c.count}`] : []));
  return parts.length ? ` (${parts.join(', ')})` : '';
}

async function rowCreated(
  spec: RowSpec,
  l: Lookups,
  actx: AuditCtx,
  row: AuditRow,
  data: unknown,
): Promise<void> {
  const { label, engagement } = await spec.describe(row, l);
  const nested = summarizeNested(data);
  await recordAudit(actx, {
    action: 'create',
    entityType: spec.entityType,
    entity: { id: spec.entityId(row), label },
    summary: `Created ${spec.noun} ${q(label)}${nestedSuffix(nested)}`,
    changes: [...snapshotChanges(row, spec, 'create'), ...nested],
    engagement,
    source: 'backstop',
  });
}

/**
 * One coalescable entry per changed field through `recordUpdate`; a nested
 * relation write in the same payload (rare outside creates) is a separate,
 * never-folding entry of counts, since the fold only knows field and list
 * changes. Nothing at all when only ignored columns moved.
 */
async function rowUpdated(
  spec: RowSpec,
  l: Lookups,
  actx: AuditCtx,
  before: AuditRow,
  after: AuditRow,
  data: unknown,
): Promise<void> {
  const changes = diffRow(before, after, spec);
  const nested = summarizeNested(data);
  if (changes.length === 0 && nested.length === 0) return;
  const { label, engagement } = await spec.describe(after, l);
  const entity = { id: entityIdOf(spec, after, before), label };
  if (changes.length > 0) {
    await recordUpdate(actx, {
      entityType: spec.entityType,
      entity,
      noun: spec.noun,
      changes,
      engagement,
      source: 'backstop',
    });
  }
  if (nested.length > 0) {
    await recordAudit(actx, {
      action: 'update',
      entityType: spec.entityType,
      entity,
      summary: `Updated ${spec.noun} ${q(label)}${nestedSuffix(nested)}`,
      changes: nested,
      engagement,
      source: 'backstop',
    });
  }
}

async function rowDeleted(
  spec: RowSpec,
  l: Lookups,
  actx: AuditCtx,
  before: AuditRow,
): Promise<void> {
  const { label, engagement } = await spec.describe(before, l);
  const cascade = cascadeChanges(spec, before);
  const taken = cascade.map((c) => n(c.count, c.noun, plural(c.noun)));
  await recordAudit(actx, {
    action: 'delete',
    entityType: spec.entityType,
    entity: { id: spec.entityId(before), label },
    summary: `Deleted ${spec.noun} ${q(label)}${taken.length ? ` with ${taken.join(', ')}` : ''}`,
    changes: [
      ...snapshotChanges(before, spec, 'delete'),
      ...cascade.map((c): AuditChange => ({
        kind: 'count',
        label: capitalize(plural(c.noun)),
        count: c.count,
      })),
    ],
    // The entry about an engagement's own deletion is written after the row is
    // gone: the snapshot still names it, but there is nothing left to point at.
    engagement:
      spec.entityType === 'engagement' && engagement ? { ...engagement, id: null } : engagement,
    source: 'backstop',
  });
}

/** The non-empty cascading relations pre-read as `_count` on a delete. */
function cascadeChanges(spec: RowSpec, before: AuditRow): Array<{ noun: string; count: number }> {
  if (!spec.cascadeCounts) return [];
  const counts = before._count;
  if (counts === null || typeof counts !== 'object') return [];
  const out: Array<{ noun: string; count: number }> = [];
  for (const [relation, noun] of Object.entries(spec.cascadeCounts)) {
    const count = (counts as Record<string, unknown>)[relation];
    if (typeof count === 'number' && count > 0) out.push({ noun, count });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Link specs — recorded on the owner
// ---------------------------------------------------------------------------

async function recordLink(
  w: Write,
  spec: LinkSpec,
  l: Lookups,
  actx: AuditCtx,
  pre: PreRead,
  result: unknown,
): Promise<void> {
  const { operation, args } = w;
  const cols = [spec.ownerKey, spec.targetKey, ...(spec.row?.fields ?? [])];
  switch (operation) {
    case 'create':
      return linked(spec, l, actx, 'link', dataRows(args.data));
    case 'createMany':
    case 'createManyAndReturn': {
      const rows =
        operation === 'createManyAndReturn' && Array.isArray(result)
          ? (result as AuditRow[])
          : dataRows(args.data);
      await linked(spec, l, actx, 'link', rows.slice(0, AUDIT_BULK_ROW_CAP));
      if (rows.length > AUDIT_BULK_ROW_CAP) {
        await linkOverflow(spec, l, actx, 'link', Math.max(rows.length, countOf(result)), rows);
      }
      return;
    }
    case 'upsert':
      if (pre.before) {
        return linkRowUpdated(
          spec,
          l,
          actx,
          pre.before,
          overlay(afterImage(pre.before, args.update, cols), result, cols),
        );
      }
      return linked(spec, l, actx, 'link', dataRows(args.create));
    case 'update':
      if (!pre.before) return;
      return linkRowUpdated(
        spec,
        l,
        actx,
        pre.before,
        overlay(afterImage(pre.before, args.data, cols), result, cols),
      );
    case 'updateMany':
    case 'updateManyAndReturn':
      for (const row of pre.rows.slice(0, AUDIT_BULK_ROW_CAP)) {
        await linkRowUpdated(spec, l, actx, row, afterImage(row, args.data, cols));
      }
      if (pre.rows.length > AUDIT_BULK_ROW_CAP) {
        await linkOverflow(spec, l, actx, 'update', countOf(result), pre.rows);
      }
      return;
    case 'delete':
      if (!pre.before) return;
      return linked(spec, l, actx, 'unlink', [pre.before]);
    case 'deleteMany':
      await linked(spec, l, actx, 'unlink', pre.rows.slice(0, AUDIT_BULK_ROW_CAP));
      if (pre.rows.length > AUDIT_BULK_ROW_CAP) {
        await linkOverflow(spec, l, actx, 'unlink', countOf(result), pre.rows);
      }
      return;
  }
}

/** Link rows grouped by owner: one `link`/`unlink` entry per owner, naming every target. */
async function linked(
  spec: LinkSpec,
  l: Lookups,
  actx: AuditCtx,
  action: 'link' | 'unlink',
  rows: AuditRow[],
): Promise<void> {
  const groups = new Map<number, AuditRow[]>();
  for (const row of rows) {
    const ownerId = num(row[spec.ownerKey]);
    if (ownerId === null) continue;
    const group = groups.get(ownerId) ?? [];
    group.push(row);
    groups.set(ownerId, group);
  }
  for (const [ownerId, group] of groups) {
    const owner = await spec.owner(ownerId, l);
    if (!owner) continue;
    const labels: string[] = [];
    for (const row of group) {
      const targetId = num(row[spec.targetKey]);
      const target = targetId === null ? null : await spec.target(targetId, l);
      if (target) labels.push(target.label.slice(0, 255));
    }
    if (labels.length === 0) continue;
    const verb = action === 'link' ? 'Linked' : 'Unlinked';
    const preposition = action === 'link' ? 'to' : 'from';
    const what =
      labels.length === 1
        ? `${spec.targetNoun} ${q(labels[0]!)}`
        : n(labels.length, spec.targetNoun, plural(spec.targetNoun));
    await recordAudit(actx, {
      action,
      entityType: owner.entityType,
      entity: { id: owner.id, label: owner.label },
      summary: `${verb} ${what} ${preposition} ${owner.noun} ${q(owner.label)}`,
      changes: [{ kind: 'items', label: spec.targetLabel, items: labels }],
      engagement: owner.engagement,
      source: 'backstop',
    });
  }
}

/** EvidenceFinding only: an edit of the link row's own content (caption, bucket, position). */
async function linkRowUpdated(
  spec: LinkSpec,
  l: Lookups,
  actx: AuditCtx,
  before: AuditRow,
  after: AuditRow,
): Promise<void> {
  if (!spec.row) return;
  const changes = diffFields(before, after, spec.row.fields);
  if (changes.length === 0) return;
  const ownerId = num(before[spec.ownerKey]);
  const targetId = num(before[spec.targetKey]);
  const owner = ownerId === null ? null : await spec.owner(ownerId, l);
  const target = targetId === null ? null : await spec.target(targetId, l);
  if (!owner || !target) return;
  await recordUpdate(actx, {
    entityType: spec.row.entityType,
    entity: { id: spec.row.entityId(owner, target), label: spec.row.label(owner, target) },
    noun: spec.row.noun,
    changes,
    engagement: owner.engagement,
    source: 'backstop',
  });
}

async function linkOverflow(
  spec: LinkSpec,
  l: Lookups,
  actx: AuditCtx,
  action: 'link' | 'unlink' | 'update',
  total: number,
  rows: AuditRow[],
): Promise<void> {
  const firstOwner = num(rows[0]?.[spec.ownerKey]);
  const owner = firstOwner === null ? null : await spec.owner(firstOwner, l);
  const noun = spec.row && action === 'update' ? spec.row.noun : `${spec.targetNoun} link`;
  await summaryEntry(actx, {
    action,
    entityType:
      spec.row && action === 'update' ? spec.row.entityType : (owner?.entityType ?? 'goal'),
    noun,
    total,
    engagement: owner?.engagement ?? null,
  });
}

// ---------------------------------------------------------------------------
// Owner-tags specs — a `tags` list change on the owner
// ---------------------------------------------------------------------------

const tagRef = refOf((item) => String(item ?? ''));

async function recordOwnerTags(
  w: Write,
  spec: OwnerTagsSpec,
  l: Lookups,
  actx: AuditCtx,
  pre: PreRead,
  result: unknown,
): Promise<void> {
  let engagement: EngagementRef | null = null;
  for (const [id, before] of pre.owners) {
    const after = await spec.owner(id, l);
    if (!after) continue;
    engagement = after.engagement;
    const changes = diffList(
      { tags: before?.tags ?? [] },
      { tags: after.tags },
      { field: 'tags', items: (r) => r.tags, ref: tagRef },
    );
    if (changes.length === 0) continue;
    await recordUpdate(actx, {
      entityType: after.entityType,
      entity: { id: after.id, label: after.label },
      noun: after.noun,
      changes,
      engagement: after.engagement,
      source: 'backstop',
    });
  }
  if (pre.ownerIds.length > AUDIT_BULK_ROW_CAP) {
    await summaryEntry(actx, {
      action: 'update',
      entityType: spec.entityType,
      noun: `${spec.noun} tag link`,
      total: countOf(result),
      engagement,
    });
  }
}

// ---------------------------------------------------------------------------
// Bulk overflow
// ---------------------------------------------------------------------------

const VERBS: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  link: 'Linked',
  unlink: 'Unlinked',
};

/** Row specs: the one summary a bulk write past the cap leaves, with the true total. */
async function overflow(
  actx: AuditCtx,
  action: WriteKind,
  spec: RowSpec,
  total: number,
  rows: AuditRow[],
  l: Lookups,
): Promise<void> {
  const first = rows[0];
  const engagement = first ? (await spec.describe(first, l)).engagement : null;
  await summaryEntry(actx, {
    action,
    entityType: spec.entityType,
    noun: spec.noun,
    total,
    engagement,
  });
}

async function summaryEntry(
  actx: AuditCtx,
  s: {
    action: AuditAction;
    entityType: RowSpec['entityType'];
    noun: string;
    total: number;
    engagement: EngagementRef | null;
  },
): Promise<void> {
  const verb = VERBS[s.action] ?? capitalize(s.action);
  const what = n(s.total, s.noun, plural(s.noun));
  await recordAudit(actx, {
    action: s.action,
    entityType: s.entityType,
    entity: { id: null, label: what },
    summary: `${verb} ${what} in one operation; the first ${AUDIT_BULK_ROW_CAP} are recorded individually`,
    changes: [
      {
        kind: 'count',
        label: `${capitalize(plural(s.noun))} ${verb.toLowerCase()}`,
        count: s.total,
      },
    ],
    engagement: s.engagement,
    source: 'backstop',
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Glossary plurals: evidence is uncountable, `-y` nouns take `-ies`, the rest take `s`. */
export function plural(noun: string): string {
  if (noun.endsWith('evidence') || noun.endsWith('branding')) return noun;
  if (noun.endsWith('y')) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}
