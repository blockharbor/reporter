/**
 * Audit log — the WRITE side. Every row in `audit_entries` is written through
 * this module: the hand-written intent entries from the handlers, the backstop's
 * automatic entries (the Prisma client extension in audit/extension.ts builds
 * them and calls `recordAudit`/`recordUpdate` with `source: 'backstop'`), and the
 * two coalescing sign-in events. The read side is services/audit-query.ts.
 *
 * WRITE-PATH POLICY
 *
 *  - Outside a transaction a write is best-effort: it is awaited (no audit write
 *    may outlive its request — see audit/context.ts) but a failure is logged and
 *    swallowed, the report-history precedent. A user's save never fails because
 *    the log hiccuped.
 *  - Inside a transaction the write JOINS it: the caller hands in its `tx` with
 *    `inTx(ctx, tx)` and the entry commits or rolls back with the work. There a
 *    failed INSERT fails the mutation, on purpose — a tamper-evident log must not
 *    let a destructive admin flow (engagement delete, user delete) commit without
 *    its record when the two share a unit of work. The coalescing FOLD is the
 *    exception: a failed fold never aborts the caller's transaction (it runs under
 *    a savepoint and falls back to a plain INSERT), because a fold that races a
 *    removal of its own target must not cost the user their edit.
 *  - Every change is validated through `auditChangeSchema` BEFORE the insert and a
 *    change that fails is dropped and logged. The rows can never be deleted, so a
 *    malformed one would otherwise break the list endpoint forever.
 *  - The actor snapshot (`actorName`, `actorEmail`) and `via` are stamped on every
 *    row at write time from the context's actor; the live join never relabels
 *    history. `via: 'system'` with a null actor means "no human request".
 *
 * THE `entityId` INVARIANT. A removal blanks a row's content but keeps its
 * skeleton, and `entityId` is part of the skeleton: whatever is written there is
 * permanent and survives the one flow that exists to purge secrets. So
 * `entityId` holds a NON-SECRET MACHINE IDENTIFIER ONLY — a row's uuid where the
 * model has one, else its id as a string. Never an API access key (key lifecycle
 * entries use `String(apiKey.id)`; `api_key_auth` carries the user's slug and no
 * key identity at all), never an email, never anything a person typed.
 *
 * COALESCING. Autosave fires a PUT ~800 ms after typing pauses, so one paragraph
 * is a dozen saves. `recordUpdate` writes ONE ENTRY PER CHANGED FIELD, and each is
 * folded independently into the latest live entry with the same
 * (actor, entityType, entityId, coalesceKey) within AUDIT_COALESCE_WINDOW_MS of
 * that entry's `lastAt`: `changes[0].from` keeps the original value,
 * `changes[0].to` takes the new one, `coalescedCount` counts the saves and
 * `lastAt` advances. Those three columns are the ONLY ones the guard trigger lets
 * a live row change; the fold's SET list must never grow. Two change-less actions
 * fold through the same path, keyed on a fixed `coalesceKey`: `api_key_auth`
 * (every HMAC request would otherwise be a row) and `sign_in_failed` (an
 * unauthenticated attacker would otherwise write unbounded permanent rows). Every
 * other `recordAudit` entry never folds — role changes, admin toggles, bucket
 * moves and dialog-driven renames must stay discrete.
 *
 * The fold's concurrency story, because it is one raw UPDATE with no unique
 * constraint behind it: a transaction-scoped advisory lock on the key
 * (`pg_advisory_xact_lock`, the idiom report-history.ts uses for version
 * numbers) serializes writers on one key, and lock -> fold -> miss-INSERT run in
 * one transaction so two concurrent cold starts produce one row, not two. Outside
 * a caller's transaction that is a short transaction of our own; inside one it is
 * the caller's, and the keys are locked in sorted order so two multi-field saves
 * cannot deadlock. `deleted_at IS NULL` sits in the UPDATE's own WHERE as well as
 * the subselect, so a removal committing between the two never lands the fold on
 * a frozen tombstone, and a NOT EXISTS clause refuses to fold across a newer
 * entry on the same key by a different actor, so A -> B -> A reads as three
 * entries and never as "A changed x to z".
 *
 * SUMMARY WORDING. A coalescable summary never embeds the `to` value — it would
 * go stale on the next fold — it names the entity by its label at first write
 * plus the field label ("Edited engagement “Acme 2026”: Executive summary").
 * Non-coalescable summaries may say the new value. `q()` wraps labels in the
 * typographic quotes the app already uses; `n()` pluralizes with the glossary's
 * uncountable "evidence".
 */
import { Prisma } from '@prisma/client';
import type { Engagement, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import {
  AUDIT_COALESCE_WINDOW_MS,
  AUDIT_ENTRY_MAX_BYTES,
  AUDIT_FIELD_LABELS,
  AUDIT_VALUE_MAX_CHARS,
  MAX_AUDIT_CHANGES,
  auditChangeSchema,
  reportConfigSchema,
  type AuditAction,
  type AuditChange,
  type AuditEntityType,
  type AuditListItemRef,
  type AuditSource,
  type AuditVia,
  type ReportConfig,
} from '@reporter/shared';
import { auditContext, newAuditContext, type AuditModel } from '../audit/context.js';
import { redactedValue, refOf, threatDiagramRefOf, type RefOf } from '../audit/models.js';
import type { AuthedUser } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Interactive-transaction limits for every transaction the audit log opens or
 * extends. Prisma's defaults (5 s timeout, 2 s maxWait) are sized for a handful
 * of statements; an engagement delete or a user delete now SET NULLs every audit
 * row that names them, each firing the guard trigger, and a long-lived
 * engagement has tens of thousands. Mirrors engagement-import.ts, which raised
 * its own limits for the same reason.
 */
export const AUDIT_TX_TIMEOUT_MS = 120_000;
export const AUDIT_TX_MAX_WAIT_MS = 15_000;

/**
 * Namespace for the per-key advisory lock the fold takes. Arbitrary, but
 * distinct from report-history.ts's REPORT_VERSION_LOCK_NS so the two can never
 * collide on a key hash.
 */
export const AUDIT_COALESCE_LOCK_NS = 726_491;

/**
 * Write-time caps on the two prose columns, matching `exportedAuditEntrySchema`
 * so a row this server wrote always round-trips through an export.
 */
const SUMMARY_MAX_CHARS = 2048;
const LABEL_MAX_CHARS = 1024;

/** `q()` keeps a quoted label readable in a one-line summary. */
const QUOTED_LABEL_MAX_CHARS = 120;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface EngagementRef {
  /**
   * Null for an entry about an engagement that no longer exists — the delete
   * entry itself, written after the row is gone. The slug and name snapshots
   * are still stamped, so the admin log reads "deleted engagement acme-2026";
   * only the FK is left unset, because there is nothing left to point at.
   */
  id: number | null;
  slug: string;
  name: string;
}

export interface AuditCtx {
  /** Null means no human actor: the row is stamped `via: 'system'`. */
  actor: AuthedUser | null;
  via: AuditVia;
  /** Stamped on the row (id + slug/name snapshot); null for site-wide events. */
  engagement: EngagementRef | null;
  /** Where to write. A TransactionClient joins the handler's transaction. */
  db: PrismaClient | Prisma.TransactionClient;
  inTransaction: boolean;
  log: FastifyBaseLogger;
}

/**
 * The context for a handler. The actor is the request's authed user; the
 * pre-guard sign-in routes bind one through `bindAuditActor` first and this
 * picks it up from the store. With neither, the row is a system row.
 */
export function auditCtx(req: FastifyRequest, engagement: EngagementRef | null = null): AuditCtx {
  const actor = req.authedUser ?? auditContext.getStore()?.actor ?? null;
  return {
    actor,
    via: actor?.via ?? 'system',
    engagement,
    db: req.server.db,
    inTransaction: false,
    log: req.log,
  };
}

/**
 * The context for code with no request in hand — the backstop extension, the
 * seed — built from the ALS store when there is one. Outside a request that is
 * a system context with no actor.
 */
export function auditCtxFromContext(
  db: PrismaClient,
  log: FastifyBaseLogger,
  engagement: EngagementRef | null = null,
): AuditCtx {
  const store = auditContext.getStore();
  const actor = store?.actor ?? null;
  return {
    actor,
    via: actor?.via ?? store?.via ?? 'system',
    engagement,
    db,
    inTransaction: false,
    log,
  };
}

/** Same actor and engagement, but every write goes through `tx`. */
export function inTx(ctx: AuditCtx, tx: Prisma.TransactionClient): AuditCtx {
  return { ...ctx, db: tx, inTransaction: true };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AuditEntityRef {
  /**
   * uuid where the model has one, else String(id); `member` -> String(userId);
   * `finding_evidence` -> `${findingUuid}:${evidenceUuid}`; `api_key` ->
   * String(apiKey.id). Null for an event about no particular row. See the
   * module header for what may never go here.
   */
  id: string | null;
  /** Title/name at write time, so a deleted row still has a human handle. */
  label: string;
}

export interface AuditEntryInput {
  action: AuditAction;
  entityType: AuditEntityType;
  entity: AuditEntityRef;
  summary: string;
  changes?: AuditChange[];
  /** Overrides `ctx.engagement` (e.g. an import, whose ctx predates the row). */
  engagement?: EngagementRef | null;
  /** `intent` unless the backstop (`backstop`) or the importer (`import`) says otherwise. */
  source?: AuditSource;
}

/** An entry that folds: a non-null entity and the key it folds on. */
export interface CoalescableEntryInput extends AuditEntryInput {
  entity: { id: string; label: string };
  /** The field for an update; a fixed word (`auth`, `auth-fail`) for the change-less actions. */
  coalesceKey: string;
}

export interface UpdateInput {
  entityType: AuditEntityType;
  entity: { id: string; label: string };
  /** Glossary noun for the summary: 'engagement' | 'finding' | 'evidence' | … */
  noun: string;
  /** Output of the diff helpers. Only `field` and `list` changes fold; others are dropped. */
  changes: AuditChange[];
  engagement?: EngagementRef | null;
  source?: AuditSource;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type AuditRow = Prisma.AuditEntryCreateManyInput;

interface PreparedEntry {
  row: AuditRow;
  /** The validated changes the row carries, kept typed for the fold's `jsonb_set`. */
  changes: AuditChange[];
  /** The advisory-lock key; empty for a never-coalescing entry. */
  key: string;
}

function displayName(actor: AuthedUser): string {
  return `${actor.firstName} ${actor.lastName}`.trim();
}

function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Cap, then validate. Capping first turns an oversize value into an opaque
 * marker that validates; validating a change that then fails is dropped and
 * logged rather than written, per the module header.
 */
function prepareChanges(log: FastifyBaseLogger, changes: AuditChange[]): AuditChange[] {
  const out: AuditChange[] = [];
  for (const change of capChanges(changes, log)) {
    const parsed = auditChangeSchema.safeParse(change);
    if (parsed.success) out.push(parsed.data);
    else
      log.error(
        { issues: parsed.error.issues, kind: change.kind },
        'audit: dropped a malformed change',
      );
  }
  return out;
}

function foldKey(ctx: AuditCtx, entityType: string, entityId: string, coalesceKey: string): string {
  return `${ctx.actor?.id ?? 'system'}|${entityType}|${entityId}|${coalesceKey}`;
}

function prepare(ctx: AuditCtx, input: AuditEntryInput, coalesceKey: string | null): PreparedEntry {
  const eng = input.engagement === undefined ? ctx.engagement : input.engagement;
  const changes = prepareChanges(ctx.log, input.changes ?? []);
  const row: AuditRow = {
    engagementId: eng?.id ?? null,
    engagementSlug: eng?.slug ?? null,
    engagementName: eng?.name ?? null,
    actorId: ctx.actor?.id ?? null,
    actorName: ctx.actor ? displayName(ctx.actor) : null,
    actorEmail: ctx.actor?.email ?? null,
    via: ctx.via,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entity.id,
    entityLabel: trunc(input.entity.label, LABEL_MAX_CHARS),
    summary: trunc(input.summary, SUMMARY_MAX_CHARS),
    changes: changes as unknown as Prisma.InputJsonValue,
    coalesceKey,
    source: input.source ?? 'intent',
  };
  const key =
    coalesceKey !== null && input.entity.id !== null
      ? foldKey(ctx, input.entityType, input.entity.id, coalesceKey)
      : '';
  return { row, changes, key };
}

/**
 * The recorders' side of the `withIntent` tally: an entry written inside a scope
 * claims every model the scope is suppressing. See audit/context.ts.
 */
function markRecorded(count = 1): void {
  const store = auditContext.getStore();
  if (!store) return;
  for (const model of store.suppress) {
    store.recorded.set(model, (store.recorded.get(model) ?? 0) + count);
  }
}

// ---------------------------------------------------------------------------
// recordAudit — the plain insert
// ---------------------------------------------------------------------------

/**
 * Plain insert. NEVER coalesces. Best-effort outside a transaction; atomic with
 * the caller's work inside one.
 */
export async function recordAudit(ctx: AuditCtx, input: AuditEntryInput): Promise<void> {
  const { row } = prepare(ctx, input, null);
  if (ctx.inTransaction) {
    await ctx.db.auditEntry.create({ data: row });
    markRecorded();
    return;
  }
  try {
    await ctx.db.auditEntry.create({ data: row });
    markRecorded();
  } catch (err) {
    ctx.log.error(
      { err, action: input.action, entityType: input.entityType },
      'audit: failed to record entry',
    );
  }
}

// ---------------------------------------------------------------------------
// recordUpdate / coalesceOrInsert — the fold
// ---------------------------------------------------------------------------

/**
 * The pure half of `recordUpdate`: one coalescable entry per `field`/`list`
 * change, keyed on the field, with the fixed summary the fold never rewrites.
 * Any other kind is left out (and `recordUpdate` logs it) rather than thrown,
 * because a mis-shaped change list is a programming error that must not fail
 * the user's save.
 */
export function planUpdateEntries(input: UpdateInput): CoalescableEntryInput[] {
  const out: CoalescableEntryInput[] = [];
  for (const change of input.changes) {
    if (change.kind !== 'field' && change.kind !== 'list') continue;
    out.push({
      action: 'update',
      entityType: input.entityType,
      entity: input.entity,
      summary: `Edited ${input.noun} ${q(input.entity.label)}: ${fieldLabel(input.entityType, change.field)}`,
      changes: [change],
      coalesceKey: change.field,
      engagement: input.engagement,
      source: input.source,
    });
  }
  return out;
}

/**
 * One entry PER CHANGED FIELD, each folded independently; the misses are
 * batched into one `createMany`, so a 20-field save is a lock-and-fold per
 * field plus one insert, not forty round trips. Writes nothing for an empty
 * change list — a no-op save is not an event.
 */
export async function recordUpdate(ctx: AuditCtx, input: UpdateInput): Promise<void> {
  const entries = planUpdateEntries(input);
  if (entries.length !== input.changes.length) {
    ctx.log.warn(
      { entityType: input.entityType, kinds: input.changes.map((c) => c.kind) },
      'audit: recordUpdate ignored changes that are not field/list',
    );
  }
  if (entries.length === 0) return;
  await writeCoalescable(ctx, entries);
}

/**
 * The shared fold for a single entry: used by the two change-less coalescable
 * actions, and by `recordUpdate` through `writeCoalescable`. Folds into the
 * live entry on the same key within the window, else inserts.
 */
export async function coalesceOrInsert(ctx: AuditCtx, entry: CoalescableEntryInput): Promise<void> {
  await writeCoalescable(ctx, [entry]);
}

async function writeCoalescable(ctx: AuditCtx, entries: CoalescableEntryInput[]): Promise<void> {
  const prepared = entries
    .map((e) => prepare(ctx, e, e.coalesceKey))
    // Lock keys in one global order so two multi-field saves on the same entity
    // cannot each hold a lock the other is waiting on.
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const misses: AuditRow[] = [];
    for (const entry of prepared) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_COALESCE_LOCK_NS}::int4, hashtext(${entry.key}::text))`;
      const folded = await tryFold(ctx, tx, entry);
      if (!folded) misses.push(entry.row);
    }
    if (misses.length === 1) await tx.auditEntry.create({ data: misses[0]! });
    else if (misses.length > 1) await tx.auditEntry.createMany({ data: misses });
  };

  if (ctx.inTransaction) {
    await run(ctx.db as Prisma.TransactionClient);
    markRecorded(prepared.length);
    return;
  }
  try {
    await (ctx.db as PrismaClient).$transaction(run, {
      maxWait: AUDIT_TX_MAX_WAIT_MS,
      timeout: AUDIT_TX_TIMEOUT_MS,
    });
    markRecorded(prepared.length);
  } catch (err) {
    ctx.log.error(
      { err, entityType: entries[0]?.entityType, keys: prepared.map((p) => p.row.coalesceKey) },
      'audit: failed to record update',
    );
  }
}

/**
 * The fold itself, with the bounded retry. Runs under a savepoint: a refused
 * UPDATE (the guard trigger, a clock that moved `last_at` backwards) would
 * otherwise poison the enclosing Postgres transaction and take the fallback
 * INSERT — and the caller's own work — down with it. Two attempts, then the
 * caller inserts.
 */
async function tryFold(
  ctx: AuditCtx,
  tx: Prisma.TransactionClient,
  entry: PreparedEntry,
  attempt = 1,
): Promise<boolean> {
  await tx.$executeRawUnsafe('SAVEPOINT audit_fold');
  try {
    const affected = await tx.$executeRaw(foldSql(entry, new Date()));
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT audit_fold');
    return affected === 1;
  } catch (err) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT audit_fold').catch(() => {});
    ctx.log.warn({ err, attempt, key: entry.key }, 'audit: coalescing fold failed');
    if (attempt < 2) return tryFold(ctx, tx, entry, attempt + 1);
    return false;
  }
}

/**
 * The one raw UPDATE. Column and table names are literal here and nowhere else
 * on the write path; a rename in schema.prisma fails this loudly in the
 * coalescing itest (zero rows folded), not silently. The SET list is exactly
 * the three columns the guard allows a live row to change.
 *
 * Timestamps are passed from JS and converted to naive UTC explicitly: the
 * columns are `TIMESTAMP(3)` that Prisma reads and writes as UTC, and `now()`
 * cast to a naive timestamp would follow the session time zone instead.
 */
function foldSql(entry: PreparedEntry, now: Date): Prisma.Sql {
  const cutoff = new Date(now.getTime() - AUDIT_COALESCE_WINDOW_MS);
  const first = entry.changes[0];
  const setChanges =
    first && 'to' in first
      ? Prisma.sql`changes = jsonb_set(e.changes, '{0,to}', ${JSON.stringify(first.to)}::jsonb),`
      : Prisma.empty;
  const { actorId, entityType, entityId, coalesceKey } = entry.row;
  return Prisma.sql`
    UPDATE audit_entries AS e
       SET ${setChanges}
           coalesced_count = e.coalesced_count + 1,
           last_at = (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
     WHERE e.deleted_at IS NULL
       AND e.id = (
         SELECT c.id
           FROM audit_entries AS c
          WHERE c.actor_id IS NOT DISTINCT FROM ${actorId ?? null}::int4
            AND c.entity_type = ${entityType}
            AND c.entity_id = ${entityId ?? null}
            AND c.coalesce_key = ${coalesceKey ?? null}
            AND c.deleted_at IS NULL
            AND c.last_at >= (${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC')
            AND NOT EXISTS (
              SELECT 1
                FROM audit_entries AS s
               WHERE s.entity_type = c.entity_type
                 AND s.entity_id = c.entity_id
                 AND s.coalesce_key = c.coalesce_key
                 AND s.actor_id IS DISTINCT FROM c.actor_id
                 AND s.id > c.id)
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT 1)`;
}

// ---------------------------------------------------------------------------
// withIntent — scoped suppression of the backstop
// ---------------------------------------------------------------------------

/**
 * "This handler writes its own entries for these models." The backstop stays
 * silent for the named models — and only those — for everything awaited inside
 * `fn`, which is how a reorder, a tag merge or a user delete yields one entry
 * instead of 1+N. Per model, not a blanket counter: a side-effect write to a
 * model that is NOT listed still reaches the backstop and is recorded.
 *
 * At scope end the tallies are compared, and a listed model that was written
 * with nothing recorded is logged — thrown under NODE_ENV=test, so the itest
 * suite fails on the handler that forgot its entry. Only on success: a scope
 * that threw has rolled its writes back, and recording nothing was right.
 *
 * Nests: a model already suppressed by an outer scope is left to that scope.
 * With no store (a direct call outside any request) it runs `fn` under a fresh
 * system store so the suppression still applies.
 */
export async function withIntent<T>(
  models: readonly AuditModel[],
  fn: () => Promise<T>,
): Promise<T> {
  const live = auditContext.getStore();
  if (!live) return auditContext.run(newAuditContext(null), () => withIntent(models, fn));

  const added = models.filter((m) => !live.suppress.has(m));
  for (const m of added) live.suppress.add(m);
  const writesBefore = new Map(models.map((m) => [m, live.writes.get(m) ?? 0] as const));
  const recordedBefore = new Map(models.map((m) => [m, live.recorded.get(m) ?? 0] as const));

  let result: T;
  try {
    result = await fn();
  } finally {
    for (const m of added) live.suppress.delete(m);
  }

  const unaccounted = models.filter(
    (m) =>
      (live.writes.get(m) ?? 0) > (writesBefore.get(m) ?? 0) &&
      (live.recorded.get(m) ?? 0) === (recordedBefore.get(m) ?? 0),
  );
  if (unaccounted.length > 0) {
    const msg = `audit: withIntent scope wrote ${unaccounted.join(', ')} but recorded nothing`;
    if (process.env.NODE_ENV === 'test') throw new Error(msg);
    (live.log ?? console).error({ requestId: live.requestId, models: unaccounted }, msg);
  }
  return result;
}

// ---------------------------------------------------------------------------
// capChanges — the per-entry ceilings
// ---------------------------------------------------------------------------

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** A value longer than AUDIT_VALUE_MAX_CHARS becomes an `oversize` marker. */
function capValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > AUDIT_VALUE_MAX_CHARS
      ? { $opaque: 'oversize', chars: value.length }
      : value;
  }
  if (value !== null && typeof value === 'object') {
    const chars = JSON.stringify(value)?.length ?? 0;
    return chars > AUDIT_VALUE_MAX_CHARS ? { $opaque: 'oversize', chars } : value;
  }
  return value;
}

function changeName(change: AuditChange): string {
  return 'field' in change ? change.field : change.label;
}

/**
 * Enforce the three caps from @reporter/shared, in order: at most
 * MAX_AUDIT_CHANGES changes (the rest are dropped); no `field` value longer
 * than AUDIT_VALUE_MAX_CHARS (it becomes `{ $opaque: 'oversize', chars }`);
 * and a serialized total under AUDIT_ENTRY_MAX_BYTES, reached by eliding the
 * largest changes first (`{ kind: 'elided', field }`), so a 30-field save
 * keeps its small changes and loses only the one that would not fit.
 */
export function capChanges(changes: AuditChange[], log?: FastifyBaseLogger): AuditChange[] {
  const out: AuditChange[] = (
    changes.length > MAX_AUDIT_CHANGES ? changes.slice(0, MAX_AUDIT_CHANGES) : changes.slice()
  ).map((c) => (c.kind === 'field' ? { ...c, from: capValue(c.from), to: capValue(c.to) } : c));
  if (changes.length > MAX_AUDIT_CHANGES) {
    log?.warn({ dropped: changes.length - MAX_AUDIT_CHANGES }, 'audit: change list truncated');
  }

  let total = byteLength(out);
  if (total <= AUDIT_ENTRY_MAX_BYTES) return out;

  const sizes = out.map((c, i) => ({ i, size: byteLength(c) }));
  sizes.sort((a, b) => b.size - a.size);
  for (const { i, size } of sizes) {
    if (total <= AUDIT_ENTRY_MAX_BYTES) break;
    const current = out[i]!;
    if (current.kind === 'elided') continue;
    const elided: AuditChange = { kind: 'elided', field: changeName(current) };
    out[i] = elided;
    total -= size - byteLength(elided);
  }
  log?.warn({ bytes: byteLength(out) }, 'audit: changes elided to fit the entry ceiling');
  return out;
}

// ---------------------------------------------------------------------------
// Wording helpers
// ---------------------------------------------------------------------------

/** Typographic quotes, as the app's own messages use; truncated with an ellipsis. */
export function q(label: string): string {
  return `“${trunc(label.trim(), QUOTED_LABEL_MAX_CHARS)}”`;
}

/** `1 finding` / `2 findings` / `3 evidence` — evidence is uncountable in the glossary. */
export function n(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** `executiveSummary` -> "Executive summary"; a dotted path labels by its leaf. */
function humanize(field: string): string {
  const leaf = field.split('.').pop() ?? field;
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The shared label for a diffed column, falling back to a de-camel-cased name. */
export function fieldLabel(entityType: AuditEntityType, field: string): string {
  return AUDIT_FIELD_LABELS[entityType]?.[field] ?? humanize(field);
}

/**
 * The handle an entry calls an evidence item by when it has no title — the
 * same fallback audit/models.ts uses for the backstop's evidence rows, so one
 * item's history reads under one name whichever layer wrote the entry.
 */
export function evidenceLabel(ev: { title: string; contentType: string }): string {
  return ev.title || `${ev.contentType} evidence`;
}

/**
 * An `order` change holds every label twice (before and after), so a long
 * reorder is kept small by clipping each one; `q()` clips at 120 for the same
 * reason, and a list reads fine shorter than that.
 */
export const ORDER_LABEL_MAX_CHARS = 80;
export function orderLabel(title: string): string {
  return title.length > ORDER_LABEL_MAX_CHARS
    ? `${title.slice(0, ORDER_LABEL_MAX_CHARS - 1)}…`
    : title;
}

/**
 * Whether a submitted order is the order already stored — a reorder that moves
 * nothing, which is no write and no entry. Compared by id, never by label: two
 * rows may share a title and still swap places.
 */
export function sameOrder<T>(current: readonly T[], submitted: readonly T[]): boolean {
  return current.length === submitted.length && current.every((id, i) => id === submitted[i]);
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

export interface FieldSpec<T> {
  field: string;
  value: (row: T) => unknown;
}

export interface ListSpec<T> {
  field: string;
  items: (row: T) => unknown;
  ref: RefOf;
}

/**
 * The comparable form of a column value: Dates as ISO strings, and `undefined`
 * and `''` collapsed to null so "cleared" and "never set" read the same.
 */
function normalize(value: unknown): unknown {
  if (value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Scalar diff over named columns (or accessor specs). Equal values are omitted;
 * a redacted column is detected by its real value but stored as its opaque
 * stand-in, so the log says the logo changed and never what it is.
 */
export function diffFields<T>(
  before: T,
  after: T,
  fields: ReadonlyArray<(keyof T & string) | FieldSpec<T>>,
): AuditChange[] {
  const out: AuditChange[] = [];
  for (const spec of fields) {
    const field = typeof spec === 'string' ? spec : spec.field;
    const read =
      typeof spec === 'string' ? (row: T) => (row as Record<string, unknown>)[spec] : spec.value;
    const from = normalize(read(before));
    const to = normalize(read(after));
    if (same(from, to)) continue;
    out.push({
      kind: 'field',
      field,
      from: redactedValue(field, from) ?? from,
      to: redactedValue(field, to) ?? to,
    });
  }
  return out;
}

/** A list column as refs. Anything that is not an array reads as empty. */
export function listRefs(items: unknown, ref: RefOf): AuditListItemRef[] {
  return Array.isArray(items) ? items.map((item, i) => ref(item, i)) : [];
}

/**
 * List diff: both sides as `{ label, hash }` refs, omitted when identical. The
 * UI derives added/removed/edited by comparing label + hash; the log never holds
 * an item body.
 */
export function diffList<T>(before: T, after: T, spec: ListSpec<T>): AuditChange[] {
  const from = listRefs(spec.items(before), spec.ref);
  const to = listRefs(spec.items(after), spec.ref);
  return same(from, to) ? [] : [{ kind: 'list', field: spec.field, from, to }];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const stringRef: RefOf = refOf((item) => String(item ?? ''));

// ---- Engagement -----------------------------------------------------------

const ENGAGEMENT_SCALARS = [
  'name',
  'status',
  'startedAt',
  'projectedEndAt',
  'actualEndAt',
  'clientName',
  'assessmentType',
  'testApproach',
  'location',
  'scope',
  'executiveSummary',
  'methodology',
  'objectivesNarrative',
  'threatModelNarrative',
  'watermarkEnabled',
  'watermarkText',
  'watermarkColor',
  'watermarkOpacity',
  'watermarkLayer',
] as const satisfies readonly (keyof Engagement)[];

const ENGAGEMENT_LISTS = [
  'scopeTargets',
  'scopeExclusions',
  'strategicRecommendations',
  'threatModelDiagrams',
  'executionNarrative',
  'providerContacts',
  'clientContacts',
  'softwareTested',
  'thirdPartySoftware',
] as const satisfies readonly (keyof Engagement)[];

/**
 * The columns `diffEngagement` reads: a structural subset of the Prisma row so a
 * test can build one without every column. `proposalImport` is deliberately
 * absent — it is a redacted blob, and the proposal import records its own entry.
 */
export type EngagementAuditRow = Pick<
  Engagement,
  (typeof ENGAGEMENT_SCALARS)[number] | (typeof ENGAGEMENT_LISTS)[number] | 'reportConfig'
>;

const contactRef: RefOf = refOf((c, i) => str(c?.name) || str(c?.email) || `Contact ${i + 1}`);
const softwareRef: RefOf = refOf((s) => `${str(s?.name)} ${str(s?.version)}`.trim());

/**
 * Per-column refs: the label each item shows under, and — for the one
 * binary-bearing column — the cheap hash. Keyed by the same list the row type
 * is derived from, so a column cannot be in one and not the other.
 */
const ENGAGEMENT_LIST_REFS: Record<(typeof ENGAGEMENT_LISTS)[number], RefOf> = {
  scopeTargets: refOf((t) => str(t?.name)),
  scopeExclusions: stringRef,
  strategicRecommendations: refOf((x) => str(x?.title)),
  threatModelDiagrams: threatDiagramRefOf,
  executionNarrative: refOf((s) => str(s?.title)),
  providerContacts: contactRef,
  clientContacts: contactRef,
  softwareTested: softwareRef,
  thirdPartySoftware: softwareRef,
};

const ENGAGEMENT_LIST_SPECS: ReadonlyArray<ListSpec<EngagementAuditRow>> = ENGAGEMENT_LISTS.map(
  (field) => ({ field, items: (r) => r[field], ref: ENGAGEMENT_LIST_REFS[field] }),
);

/**
 * The 30-column engagement save: 19 scalars, 9 JSON lists as refs, and the
 * report configuration by leaf. The derived `actualEndAt` stamp shows as its
 * own field change — it is a real change.
 */
export function diffEngagement(
  before: EngagementAuditRow,
  after: EngagementAuditRow,
): AuditChange[] {
  return [
    ...diffFields(before, after, ENGAGEMENT_SCALARS),
    ...ENGAGEMENT_LIST_SPECS.flatMap((spec) => diffList(before, after, spec)),
    ...diffReportConfig(before.reportConfig, after.reportConfig),
  ];
}

// ---- Report config --------------------------------------------------------

const REPORT_CONFIG_SCALARS = [
  'includeAllFindings',
  'includeEvidenceTimeline',
  'evidenceGroup',
  'numberExecutionSubsections',
  'showEvidenceTimestamps',
  'showEvidenceOperators',
  'findingGroup',
  'showFindingLinkedGoals',
  'showStrengthDetailCards',
] as const satisfies readonly (keyof ReportConfig)[];

/**
 * An unconfigured engagement stores `{}`, which `reportConfigSchema` expands to
 * the canonical default. Both sides are canonicalized so the first time someone
 * opens the Reports tab and saves, the log does not read as "every section
 * added". A stored value that fails to parse (nothing the server writes does)
 * reads as the default rather than aborting the diff.
 */
function canonicalReportConfig(value: unknown): ReportConfig {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const parsed = reportConfigSchema.safeParse(input);
  return parsed.success ? parsed.data : reportConfigSchema.parse({});
}

export function diffReportConfig(before: unknown, after: unknown): AuditChange[] {
  const a = canonicalReportConfig(before);
  const b = canonicalReportConfig(after);
  return [
    ...diffFields(
      a,
      b,
      REPORT_CONFIG_SCALARS.map((key) => ({
        field: `reportConfig.${key}`,
        value: (r: ReportConfig) => r[key],
      })),
    ),
    ...diffList(a, b, {
      field: 'reportConfig.sections',
      items: (r) => r.sections,
      ref: refOf((s) => `${str(s?.key)}${s?.enabled === false ? ' (off)' : ''}`),
    }),
    ...diffList(a, b, {
      field: 'reportConfig.customSections',
      items: (r) => r.customSections,
      ref: refOf((s) => str(s?.title)),
    }),
    ...diffList(a, b, {
      field: 'reportConfig.readinessNa',
      items: (r) => r.readinessNa,
      ref: stringRef,
    }),
  ];
}

// ---- Finding --------------------------------------------------------------

/** The finding row with `category` and `tags: { include: { tag } }` included. */
export interface FindingAuditRow {
  title: string;
  description: string;
  kind: string;
  affectedTarget: string;
  impact: string;
  fixEffort: string;
  remediation: string;
  readyToReport: boolean;
  severity: string | null;
  cvssVector: string | null;
  iso21434Refs: unknown;
  unr155Refs: unknown;
  category: { category: string } | null;
  tags: ReadonlyArray<{ tag: { name: string } }>;
}

const FINDING_SCALARS = [
  'title',
  'description',
  'kind',
  'affectedTarget',
  'impact',
  'fixEffort',
  'remediation',
  'readyToReport',
  'severity',
  'cvssVector',
] as const satisfies readonly (keyof FindingAuditRow)[];

/**
 * `cvssScore` is deliberately skipped: it is derived from `cvssVector` and
 * would double every CVSS edit. The category reads through its relation so the
 * log says "Cryptography", not an id; tags are a list of names.
 */
export function diffFinding(before: FindingAuditRow, after: FindingAuditRow): AuditChange[] {
  return [
    ...diffFields(before, after, [
      ...FINDING_SCALARS,
      { field: 'category', value: (r) => r.category?.category ?? null },
    ]),
    ...diffList(before, after, {
      field: 'iso21434Refs',
      items: (r) => r.iso21434Refs,
      ref: stringRef,
    }),
    ...diffList(before, after, { field: 'unr155Refs', items: (r) => r.unr155Refs, ref: stringRef }),
    ...diffList(before, after, {
      field: 'tags',
      items: (r) => r.tags.map((t) => t.tag.name),
      ref: stringRef,
    }),
  ];
}

// ---- Evidence -------------------------------------------------------------

/** The evidence row with `parent: { select: { uuid } }` and tags included. */
export interface EvidenceAuditRow {
  title: string;
  description: string;
  occurredAt: Date;
  contentType: string;
  contentSubtype: string | null;
  excludeFromReport: boolean;
  sha256: string | null;
  sizeBytes: number | null;
  parent: { uuid: string } | null;
  tags: ReadonlyArray<{ tag: { name: string } }>;
}

const EVIDENCE_SCALARS = [
  'title',
  'description',
  'occurredAt',
  'contentType',
  'contentSubtype',
  'excludeFromReport',
] as const satisfies readonly (keyof EvidenceAuditRow)[];

/**
 * `parent` diffs as the parent's uuid (the comment link), `content` as the
 * blob's `{ sha256, sizeBytes }` — never the text — and `lastEditedById` is not
 * diffed because it IS the actor.
 */
export function diffEvidence(before: EvidenceAuditRow, after: EvidenceAuditRow): AuditChange[] {
  return [
    ...diffFields(before, after, [
      ...EVIDENCE_SCALARS,
      { field: 'parent', value: (r) => r.parent?.uuid ?? null },
      {
        field: 'content',
        value: (r) =>
          r.sha256 == null && r.sizeBytes == null
            ? null
            : { sha256: r.sha256 ?? null, sizeBytes: r.sizeBytes ?? null },
      },
    ]),
    ...diffList(before, after, {
      field: 'tags',
      items: (r) => r.tags.map((t) => t.tag.name),
      ref: stringRef,
    }),
  ];
}
