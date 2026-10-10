/**
 * The audit request context: who is driving the Prisma writes currently in
 * flight, and what the audit layer has been told about them.
 *
 * One `AsyncLocalStorage` store per request. `app.ts` seeds it from a root
 * `onRequest` hook in callback form (`auditContext.run(newAuditContext(req.id),
 * done)`), which is what makes every later hook, the handler and every promise
 * they spawn see the same store. The auth guards cannot wrap the rest of the
 * lifecycle in a `run` of their own, so they MUTATE the live store through
 * `bindAuditActor` the moment the principal is known. Outside a request —
 * bootstrap, the seed, tests writing through `app.db` directly — there is no
 * store at all, and the audit layer treats that as `via: 'system'` with no
 * actor; `runAsSystem` exists for code that wants an explicit store anyway (the
 * seed, so `withImporter` has something to count into).
 *
 * LIFETIME. The store lives for the request's async scope and no longer. That
 * is a rule for the writers, not just a property of ALS: no audit write may
 * outlive its request, because a write that completes after the response has
 * gone cannot be attributed with confidence (the store may already be gone, the
 * actor may have been unbound) and cannot fail the request it belongs to. Every
 * recorder awaits its insert. The one fire-and-forget write in the codebase —
 * the `lastAuth` stamp in `requireApiAuth` (auth/guards.ts) — is explicitly
 * unaudited for exactly this reason, and must stay that way.
 *
 * What lives here, and who touches it:
 *
 *  - `actor` / `via` — set by the guards; read by every recorder to snapshot the
 *    actor's name and email onto the row.
 *  - `suppress` / `suppressAll` — the backstop (the Prisma client extension) stays
 *    silent for a model when it is in `suppress` or when `suppressAll > 0`.
 *    `withIntent(models, fn)` in services/audit.ts adds its named models for the
 *    duration of `fn`; `withImporter` bumps `suppressAll` for everything. Per
 *    model, deliberately: a blanket counter would also silence a side-effect write
 *    the hand-written entry never mentions (the goal auto-advance inside the link
 *    handlers is the standing example), and that write must still be recorded.
 *  - `writes` / `recorded` — two tallies, both keyed by model. The backstop counts
 *    every write it SKIPPED because of suppression into `writes`; the recorders
 *    count every entry they wrote into `recorded`, against every model currently
 *    suppressed (an entry written inside a scope claims the scope's models). At
 *    the end of a `withIntent` scope the two are compared, and a listed model that
 *    was written with nothing recorded is logged — and in tests, thrown — because
 *    that is precisely the "handler forgot its entry" bug the maintenance rule
 *    exists to catch.
 *  - `importer` — set by `withImporter`: the backstop records nothing while it is
 *    set and counts rows per model into `importer.counts`, which the importer
 *    turns into its one summary entry.
 *  - `cache` — a per-request memo for the backstop's parent lookups, keyed
 *    `${model}:${id}`, so a bulk write under one parent resolves it once.
 *  - `log` — optional. The hook may pass `req.log`; `withIntent` falls back to
 *    the console when it is absent, which only happens outside a request.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditVia } from '@reporter/shared';
import type { AuthedUser } from '../types.js';

/**
 * A Prisma model as the audit layer names it: the delegate name (`tag`,
 * `evidenceTag`, `userEngagementRole`), derived from Prisma's own `ModelName` so
 * a typo in a `withIntent` list is a compile error, and a renamed model breaks
 * every list that named it rather than silently un-suppressing it. The
 * extension sees the PascalCase form and lower-cases its first letter to match.
 */
export type AuditModel = Uncapitalize<Prisma.ModelName>;

/** The bulk paths that replace per-row entries with one summary entry. */
export type AuditImporterTag = 'engagement-import' | 'findings-import' | 'proposal-import' | 'seed';

export interface AuditImporter {
  tag: AuditImporterTag;
  /** Rows written per model while the importer was active, counted by the backstop. */
  counts: Record<string, number>;
}

export interface AuditContext {
  /** Fastify `req.id`; null for non-request work (bootstrap, seed, tests). */
  requestId: string | null;
  /** Set by requireAuth / requireApiAuth; null until then and for the pre-auth sign-in routes. */
  actor: AuthedUser | null;
  /** The actor's own plane, or `system` when there is no actor. */
  via: AuditVia;
  /** Models the backstop stays silent for right now (`withIntent`). */
  suppress: Set<AuditModel>;
  /** When > 0 the backstop stays silent for every model (`withImporter`). */
  suppressAll: number;
  /** Suppressed writes the backstop skipped, per model. */
  writes: Map<AuditModel, number>;
  /** Entries the recorders wrote, per model they were claiming at the time. */
  recorded: Map<AuditModel, number>;
  importer: AuditImporter | null;
  cache: Map<string, unknown>;
  log: FastifyBaseLogger | null;
}

export const auditContext = new AsyncLocalStorage<AuditContext>();

/** The live store, or undefined outside a request (and outside `runAsSystem`). */
export function getAuditContext(): AuditContext | undefined {
  return auditContext.getStore();
}

export function newAuditContext(
  requestId: string | null,
  log: FastifyBaseLogger | null = null,
): AuditContext {
  return {
    requestId,
    actor: null,
    via: 'system',
    suppress: new Set(),
    suppressAll: 0,
    writes: new Map(),
    recorded: new Map(),
    importer: null,
    cache: new Map(),
    log,
  };
}

/**
 * Called by the auth guards — and by the pre-guard sign-in handlers as soon as
 * they know the user — so every later write in the request is attributed.
 * Mutates the live store: a guard runs inside the hook's `run` and cannot open
 * a nested one around the handler. A no-op with no store.
 */
export function bindAuditActor(actor: AuthedUser): void {
  const ctx = auditContext.getStore();
  if (!ctx) return;
  ctx.actor = actor;
  ctx.via = actor.via;
}

/**
 * Bulk importers: the backstop records nothing inside `fn` and instead counts
 * rows per model into `counts`, which the caller turns into ONE summary entry.
 * Runs `fn` on a spread COPY of the parent store with `suppressAll` bumped and
 * the importer tag set, rather than mutating the live store, so a `fn` that is
 * abandoned mid-way (a thrown error, a timed-out transaction) can neither leave
 * the parent suppressed nor leak a stale importer tag into the rest of the
 * request. The copy shares the parent's tallies and cache by reference, which
 * is what lets an enclosing `withIntent` still account for the scope.
 */
export function withImporter<T>(
  tag: AuditImporterTag,
  fn: (counts: Record<string, number>) => Promise<T>,
): Promise<T> {
  const parent = auditContext.getStore() ?? newAuditContext(null);
  const importer: AuditImporter = { tag, counts: {} };
  return auditContext.run({ ...parent, suppressAll: parent.suppressAll + 1, importer }, () =>
    fn(importer.counts),
  );
}

/**
 * An explicit system store for non-request code (the seed). Plain absence of a
 * store is also treated as system by every recorder; this exists so that
 * `withIntent`/`withImporter` inside `fn` have a store to work on.
 */
export function runAsSystem<T>(
  fn: () => Promise<T>,
  log: FastifyBaseLogger | null = null,
): Promise<T> {
  return auditContext.run(newAuditContext(null, log), fn);
}

/** Whether the backstop should stay silent for `model` under `ctx`. */
export function isSuppressed(ctx: AuditContext, model: AuditModel): boolean {
  return ctx.suppressAll > 0 || ctx.suppress.has(model);
}

/** The backstop's side of the tally: a write it skipped because of suppression. */
export function tallyWrite(ctx: AuditContext, model: AuditModel): void {
  ctx.writes.set(model, (ctx.writes.get(model) ?? 0) + 1);
}
