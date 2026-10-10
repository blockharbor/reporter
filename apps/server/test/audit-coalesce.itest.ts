import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildAuthHeaders } from '@reporter/api-client';
import { AUDIT_COALESCE_WINDOW_MS, EVIDENCE_TYPE_LABELS } from '@reporter/shared';
import { AUDIT_COALESCE_LOCK_NS } from '../src/services/audit.js';
import {
  WEB_HEADERS,
  apiKeyFor,
  buildTestApp,
  loginCookie,
  seedUsers,
  truncateAll,
  truncateAuditLog,
} from './helpers.js';

// The coalescing fold under contention, driven through the real handlers with
// GENUINELY PARALLEL requests (`Promise.all` of `app.inject`), against a real
// Postgres. Every rule pinned here is one the module header of
// services/audit.ts (the COALESCING paragraph and the fold's concurrency story)
// or spec-3 §"Implementation notes" states; each case names the rule it pins.
// Every case truncates the log AFTER its fixtures and sign-ins, so the counts
// below are exactly the rows the exercised requests produced.

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await truncateAll(app);
});

const entries = () => app.db.auditEntry.findMany({ orderBy: { id: 'asc' } });

/** The fixed summary of the one coalescable entry most cases drive (never embeds `to`). */
const EXEC_SUMMARY = 'Edited engagement “Op One”: Executive summary';

interface FieldChange {
  kind: 'field';
  field: string;
  from: unknown;
  to: unknown;
}

/** The one-element `changes` a coalescable entry carries (spec-3 note (b)). */
function change(row: { changes: unknown }): FieldChange {
  const list = row.changes as FieldChange[];
  expect(list).toHaveLength(1);
  return list[0]!;
}

async function setup() {
  const users = await seedUsers(app);
  const eng = await app.db.engagement.create({
    data: {
      slug: 'op1',
      name: 'Op One',
      executiveSummary: 'A',
      roles: {
        create: [
          { userId: users.admin.id, role: 'admin' },
          // The writer holds the ENGAGEMENT admin role: PUT /web/engagements/:slug
          // is admin-gated, and the cases below need two distinct actors who can
          // both save the same field (the site admin bypasses the guard anyway).
          { userId: users.writer.id, role: 'admin' },
          { userId: users.reader.id, role: 'read' },
        ],
      },
    },
  });
  const admin = await loginCookie(app, 'admin@test.local', 'password123');
  const writer = await loginCookie(app, 'writer@test.local', 'password123');
  // The fixtures and the two sign-ins above all wrote entries; start clean.
  await truncateAuditLog(app);
  return { users, eng, admin, writer };
}

function put(url: string, cookie: string, payload: unknown) {
  return app.inject({ method: 'PUT', url, headers: { ...WEB_HEADERS, cookie }, payload });
}
function post(url: string, cookie: string, payload: unknown) {
  return app.inject({ method: 'POST', url, headers: { ...WEB_HEADERS, cookie }, payload });
}
function get(url: string, cookie: string) {
  return app.inject({ method: 'GET', url, headers: { ...WEB_HEADERS, cookie } });
}
const putEng = (cookie: string, payload: unknown, slug = 'op1') =>
  put(`/web/engagements/${slug}`, cookie, payload);
const removeEntry = (cookie: string, uuid: string, reason: string) =>
  post(`/web/admin/audit-log/${uuid}/remove`, cookie, { reason });

/**
 * Hold the fold's own per-key advisory lock in a side transaction, so a save
 * that is already past its row write blocks at exactly the point where "a
 * removal committing between the two" (audit.ts header) can happen. The key
 * format mirrors the private `foldKey` in services/audit.ts; if that format
 * ever changes, `waitForFoldWaiter` below times out loudly rather than letting
 * the case degrade into an unobserved race.
 */
async function holdFoldLock(key: string): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  let held!: () => void;
  const acquired = new Promise<void>((r) => {
    held = r;
  });
  const done = app.db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_COALESCE_LOCK_NS}::int4, hashtext(${key}::text))`;
      held();
      await released;
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
  // Surface a transaction that failed before taking the lock instead of hanging.
  await Promise.race([acquired, done]);
  return { release, done };
}

/** Wait until some backend is queued on the fold's advisory-lock namespace. */
async function waitForFoldWaiter(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [row] = await app.db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM pg_locks
       WHERE locktype = 'advisory' AND classid = ${AUDIT_COALESCE_LOCK_NS}::oid AND NOT granted`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    'no request queued on the fold lock within 5 s — does the gate key still match foldKey() in services/audit.ts?',
  );
}

describe('concurrent saves of one field by one actor', () => {
  // Pins the fold's concurrency story (audit.ts header): "lock -> fold ->
  // miss-INSERT run in one transaction so two concurrent cold starts produce one
  // row, not two", and the COALESCING rule: `from` keeps the original value,
  // `to` takes the new one, `coalescedCount` counts the saves, `lastAt` advances.
  it('folds two concurrent cold-start writes on one key into one row with coalescedCount 2', async () => {
    const { users, eng, writer } = await setup();

    const [r1, r2] = await Promise.all([
      putEng(writer, { executiveSummary: 'first draft' }),
      putEng(writer, { executiveSummary: 'second draft' }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const rows = await entries();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      action: 'update',
      entityType: 'engagement',
      entityId: String(eng.id),
      entityLabel: 'Op One',
      actorId: users.writer.id,
      actorName: 'Wendy Writer',
      via: 'session',
      coalesceKey: 'executiveSummary',
      coalescedCount: 2,
      summary: EXEC_SUMMARY,
      source: 'intent',
      deletedAt: null,
      engagementId: eng.id,
    });
    const c = change(row);
    expect(c.field).toBe('executiveSummary');
    // The original stored value, whichever save inserted the row.
    expect(c.from).toBe('A');
    // The winner: the value the last-folded save wrote, which is the column's
    // final value — the fold and the row write are ordered the same way.
    expect(['first draft', 'second draft']).toContain(c.to);
    const final = await app.db.engagement.findUniqueOrThrow({ where: { id: eng.id } });
    expect(c.to).toBe(final.executiveSummary);
    expect(row.lastAt.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
  });

  // Pins "coalescedCount counts the saves" at autosave volume: N distinct
  // concurrent saves of one field are one row with count N, never N rows.
  it('folds a burst of 10 concurrent distinct saves of one field into one row with coalescedCount 10', async () => {
    const { users, eng, writer } = await setup();
    const values = Array.from({ length: 10 }, (_, i) => `draft ${i + 1}`);

    const results = await Promise.all(values.map((v) => putEng(writer, { executiveSummary: v })));
    for (const r of results) expect(r.statusCode).toBe(200);

    const rows = await entries();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      actorId: users.writer.id,
      entityId: String(eng.id),
      coalesceKey: 'executiveSummary',
      coalescedCount: values.length,
      summary: EXEC_SUMMARY,
    });
    const c = change(row);
    expect(c.from).toBe('A');
    expect(values).toContain(c.to);
    const final = await app.db.engagement.findUniqueOrThrow({ where: { id: eng.id } });
    expect(values).toContain(final.executiveSummary);
    expect(row.lastAt.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
  });
});

describe('what does not fold together', () => {
  // Pins "`recordUpdate` writes ONE ENTRY PER CHANGED FIELD" (audit.ts header)
  // and "a no-op save is not an event" (`recordUpdate` doc comment; the
  // engagement PUT's predicted-diff gate).
  it('writes one row per changed field for a multi-field save, and nothing for a save that changes nothing', async () => {
    const { users, eng, writer } = await setup();

    const res = await putEng(writer, {
      clientName: 'Acme',
      location: 'Detroit',
      methodology: 'Black box',
    });
    expect(res.statusCode).toBe(200);

    let rows = await entries();
    expect(rows.map((r) => r.coalesceKey).sort()).toEqual([
      'clientName',
      'location',
      'methodology',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        actorId: users.writer.id,
        entityId: String(eng.id),
        action: 'update',
        coalescedCount: 1,
      });
      const c = change(row);
      expect(c.field).toBe(row.coalesceKey);
      expect(c.from).toBeNull();
    }
    // The misses of one save are one createMany: siblings share a `createdAt`
    // (spec-3: "a multi-field explicit save becomes N sibling rows with the
    // same created_at").
    expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(1);

    // Re-sending the same values changes nothing and records nothing.
    const noop = await putEng(writer, { clientName: 'Acme', location: 'Detroit' });
    expect(noop.statusCode).toBe(200);
    rows = await entries();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.coalescedCount === 1)).toBe(true);
  });

  // Pins the key: (actor, entityType, entityId, coalesceKey). Two actors on one
  // field are two keys, so they neither serialize nor fold.
  it('keeps two actors saving the same field concurrently as two rows', async () => {
    const { users, eng, admin, writer } = await setup();

    const [r1, r2] = await Promise.all([
      putEng(writer, { executiveSummary: 'the writer wrote this' }),
      putEng(admin, { executiveSummary: 'the admin wrote this' }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const rows = await entries();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.actorId))).toEqual(new Set([users.writer.id, users.admin.id]));
    for (const row of rows) {
      expect(row).toMatchObject({
        entityId: String(eng.id),
        coalesceKey: 'executiveSummary',
        coalescedCount: 1,
      });
    }
  });

  // Pins the NOT EXISTS clause (audit.ts header): "refuses to fold across a
  // newer entry on the same key by a different actor, so A -> B -> A reads as
  // three entries and never as 'A changed x to z'".
  it('never folds back across another actor’s newer entry on the same key: writer, admin, writer is three rows', async () => {
    const { users, eng, admin, writer } = await setup();

    expect((await putEng(writer, { executiveSummary: 'y' })).statusCode).toBe(200);
    expect((await putEng(admin, { executiveSummary: 'z' })).statusCode).toBe(200);
    expect((await putEng(writer, { executiveSummary: 'w' })).statusCode).toBe(200);

    let rows = await entries();
    expect(rows.map((r) => [r.actorId, r.coalescedCount])).toEqual([
      [users.writer.id, 1],
      [users.admin.id, 1],
      [users.writer.id, 1],
    ]);
    expect(change(rows[0]!)).toMatchObject({ from: 'A', to: 'y' });
    expect(change(rows[1]!)).toMatchObject({ from: 'y', to: 'z' });
    expect(change(rows[2]!)).toMatchObject({ from: 'z', to: 'w' });
    expect(rows.every((r) => r.entityId === String(eng.id))).toBe(true);

    // The writer's NEXT save folds into their newest own entry — nothing by
    // anyone else is newer than it — and leaves the earlier two alone.
    expect((await putEng(writer, { executiveSummary: 'v' })).statusCode).toBe(200);
    rows = await entries();
    expect(rows.map((r) => r.coalescedCount)).toEqual([1, 1, 2]);
    expect(change(rows[2]!)).toMatchObject({ from: 'z', to: 'v' });
    expect(change(rows[0]!)).toMatchObject({ from: 'A', to: 'y' });
  });

  // Pins the `entityId` half of the key: the same actor, the same field, two
  // entities — two rows, and concurrently, because the keys differ.
  it('keeps the same actor’s concurrent saves of the same field on two entities apart', async () => {
    const { users, eng, writer } = await setup();
    const eng2 = await app.db.engagement.create({
      data: {
        slug: 'op2',
        name: 'Op Two',
        executiveSummary: 'A',
        roles: { create: [{ userId: users.writer.id, role: 'admin' }] },
      },
    });
    await truncateAuditLog(app);

    const [r1, r2] = await Promise.all([
      putEng(writer, { executiveSummary: 'one' }, 'op1'),
      putEng(writer, { executiveSummary: 'two' }, 'op2'),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const rows = await entries();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.entityId))).toEqual(
      new Set([String(eng.id), String(eng2.id)]),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        actorId: users.writer.id,
        coalesceKey: 'executiveSummary',
        coalescedCount: 1,
      });
    }
    const byEntity = Object.fromEntries(rows.map((r) => [r.entityId, change(r).to]));
    expect(byEntity[String(eng.id)]).toBe('one');
    expect(byEntity[String(eng2.id)]).toBe('two');
  });
});

describe('a fold whose target is removed', () => {
  const REASON = 'A credential was pasted into the summary.';

  // Pins the header's "`deleted_at IS NULL` sits in the UPDATE's own WHERE as
  // well as the subselect, so a removal committing between the two never lands
  // the fold on a frozen tombstone", and the write-path policy that "a fold
  // that races a removal of its own target must not cost the user their edit".
  // The save is genuinely in flight — past its row write, queued on the fold's
  // own advisory lock — when the admin removes the entry it would have folded
  // into; releasing the lock lets the fold run against the tombstone.
  it('a save whose fold target is removed mid-flight still returns 200 and starts a new live row; the tombstone stays frozen', async () => {
    const { users, eng, admin, writer } = await setup();
    expect((await putEng(writer, { executiveSummary: 'V1' })).statusCode).toBe(200);
    const [first] = await entries();
    expect(first).toMatchObject({ coalescedCount: 1, deletedAt: null });

    const gate = await holdFoldLock(`${users.writer.id}|engagement|${eng.id}|executiveSummary`);
    let second: ReturnType<typeof putEng> | undefined;
    try {
      second = putEng(writer, { executiveSummary: 'V2' });
      await waitForFoldWaiter();
      // The save has written its row and is blocked on the fold.
      const mid = await app.db.engagement.findUniqueOrThrow({ where: { id: eng.id } });
      expect(mid.executiveSummary).toBe('V2');
      expect(await app.db.auditEntry.count()).toBe(1);

      const removed = await removeEntry(admin, first!.uuid, REASON);
      expect(removed.statusCode).toBe(200);
    } finally {
      gate.release();
      await gate.done;
    }
    const res = await second;
    expect(res!.statusCode).toBe(200);

    const rows = await entries();
    expect(rows).toHaveLength(2);
    const [tombstone, fresh] = rows;
    expect(tombstone!.id).toBe(first!.id);
    expect(tombstone).toMatchObject({
      coalescedCount: 1,
      summary: '',
      entityLabel: '',
      changes: [],
      deletedByName: 'Ada Admin',
      deletedByEmail: 'admin@test.local',
      deletedReason: REASON,
    });
    expect(tombstone!.deletedAt).not.toBeNull();
    expect(tombstone!.lastAt).toEqual(first!.lastAt);
    expect(fresh).toMatchObject({
      actorId: users.writer.id,
      entityId: String(eng.id),
      coalesceKey: 'executiveSummary',
      coalescedCount: 1,
      summary: EXEC_SUMMARY,
      deletedAt: null,
    });
    expect(change(fresh!)).toMatchObject({ from: 'V1', to: 'V2' });
  });

  // The sequential form of the same rule: a removed entry is never a fold
  // target (subselect `c.deleted_at IS NULL`), and the save it would have
  // folded into neither fails nor folds — it starts over.
  it('a save after its previous entry was removed starts a new row with no 500, and later saves fold into the new one', async () => {
    const { users, eng, admin, writer } = await setup();
    expect((await putEng(writer, { executiveSummary: 'V1' })).statusCode).toBe(200);
    const [first] = await entries();
    expect((await removeEntry(admin, first!.uuid, REASON)).statusCode).toBe(200);

    expect((await putEng(writer, { executiveSummary: 'V2' })).statusCode).toBe(200);
    let rows = await entries();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: first!.id, coalescedCount: 1, summary: '', changes: [] });
    expect(rows[0]!.deletedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({
      actorId: users.writer.id,
      entityId: String(eng.id),
      coalesceKey: 'executiveSummary',
      coalescedCount: 1,
      deletedAt: null,
    });
    expect(change(rows[1]!)).toMatchObject({ from: 'V1', to: 'V2' });

    expect((await putEng(writer, { executiveSummary: 'V3' })).statusCode).toBe(200);
    rows = await entries();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.coalescedCount).toBe(1);
    expect(rows[1]!.coalescedCount).toBe(2);
    expect(change(rows[1]!)).toMatchObject({ from: 'V1', to: 'V3' });
  });
});

describe('the window', () => {
  /** A live row exactly as the recorder writes it, with the timestamps the case needs. */
  function seeded(
    users: Awaited<ReturnType<typeof seedUsers>>,
    eng: { id: number },
    at: { createdAt: Date; lastAt: Date; coalescedCount?: number },
  ) {
    return app.db.auditEntry.create({
      data: {
        engagementId: eng.id,
        engagementSlug: 'op1',
        engagementName: 'Op One',
        actorId: users.writer.id,
        actorName: 'Wendy Writer',
        actorEmail: 'writer@test.local',
        via: 'session',
        action: 'update',
        entityType: 'engagement',
        entityId: String(eng.id),
        entityLabel: 'Op One',
        summary: EXEC_SUMMARY,
        changes: [{ kind: 'field', field: 'executiveSummary', from: 'A', to: 'Old' }],
        coalesceKey: 'executiveSummary',
        coalescedCount: at.coalescedCount ?? 1,
        source: 'intent',
        createdAt: at.createdAt,
        lastAt: at.lastAt,
      },
    });
  }

  // Pins spec-3 note (c): "A burst that ends where it began (typed, then
  // reverted) stays as one entry with from === to and coalesced_count >= 2".
  // The fold matches on the key alone and never compares values, so B -> A is
  // a second save of the same field and folds like any other.
  it('a burst that ends where it began folds to one row with from === to and coalescedCount 2', async () => {
    const { users, eng, writer } = await setup();

    expect((await putEng(writer, { executiveSummary: 'B' })).statusCode).toBe(200);
    expect((await putEng(writer, { executiveSummary: 'A' })).statusCode).toBe(200);

    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: users.writer.id,
      entityId: String(eng.id),
      coalesceKey: 'executiveSummary',
      coalescedCount: 2,
      summary: EXEC_SUMMARY,
    });
    expect(change(rows[0]!)).toEqual({
      kind: 'field',
      field: 'executiveSummary',
      from: 'A',
      to: 'A',
    });
  });

  // Pins "within AUDIT_COALESCE_WINDOW_MS of that entry's `lastAt`" (audit.ts
  // header; `c.last_at >= cutoff` in foldSql). A live row cannot be back-dated
  // — the guard refuses `last_at` moving earlier and `created_at` moving at all
  // — so the stale entry is INSERTED with old timestamps (the trigger guards
  // UPDATE and DELETE only), which is what the recorder would have left behind.
  it('starts a new row once the previous entry’s lastAt is older than the window (and a live row cannot be back-dated)', async () => {
    const { users, eng, writer } = await setup();
    const past = new Date(Date.now() - AUDIT_COALESCE_WINDOW_MS - 60_000);
    const stale = await seeded(users, eng, { createdAt: past, lastAt: past });

    await expect(
      app.db.auditEntry.updateMany({
        where: { id: stale.id },
        data: { lastAt: new Date(past.getTime() - 1000) },
      }),
    ).rejects.toThrow(/never rewritten/);

    expect((await putEng(writer, { executiveSummary: 'New' })).statusCode).toBe(200);

    const rows = await entries();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: stale.id, coalescedCount: 1, lastAt: past });
    expect(change(rows[0]!)).toMatchObject({ from: 'A', to: 'Old' });
    expect(rows[1]).toMatchObject({
      actorId: users.writer.id,
      entityId: String(eng.id),
      coalesceKey: 'executiveSummary',
      coalescedCount: 1,
      summary: EXEC_SUMMARY,
    });
    expect(change(rows[1]!)).toMatchObject({ from: 'A', to: 'New' });
    expect(rows[1]!.createdAt.getTime()).toBeGreaterThan(past.getTime());
  });

  // Pins which timestamp the window is judged on: `last_at`, not `created_at`.
  // An entry opened three windows ago but folded into thirty seconds ago is
  // still open, so a typing session can run longer than one window as long as
  // no pause inside it does.
  it('judges the window on lastAt, not createdAt: an old entry folded recently still accepts a fold', async () => {
    const { users, eng, writer } = await setup();
    const opened = new Date(Date.now() - 3 * AUDIT_COALESCE_WINDOW_MS);
    const lastFold = new Date(Date.now() - 30_000);
    const open = await seeded(users, eng, {
      createdAt: opened,
      lastAt: lastFold,
      coalescedCount: 4,
    });

    expect((await putEng(writer, { executiveSummary: 'New' })).statusCode).toBe(200);

    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: open.id, coalescedCount: 5, createdAt: opened });
    expect(rows[0]!.lastAt.getTime()).toBeGreaterThan(lastFold.getTime());
    expect(change(rows[0]!)).toMatchObject({ from: 'A', to: 'New' });
  });
});

describe('the change-less coalescable actions', () => {
  // Pins DECISIONS (2026-10-09): "Evidence content views: recorded as action
  // `download`, coalesced per (actor, evidence) within the coalescing window
  // with a count. Thumbnails are never recorded."
  it('folds evidence content views per item per actor on key `download`; thumbnails never record', async () => {
    const { users, eng, admin, writer } = await setup();
    await app.blobs.put('coalesce/ev1', Buffer.from('can dump bytes'));
    await app.blobs.put('coalesce/ev1-thumb', Buffer.from('thumb bytes'));
    await app.blobs.put('coalesce/ev2', Buffer.from('shell log bytes'));
    const base = { engagementId: eng.id, operatorId: users.writer.id, occurredAt: new Date() };
    const ev1 = await app.db.evidence.create({
      data: {
        ...base,
        contentType: 'codeblock',
        title: 'CAN dump',
        fullBlobKey: 'coalesce/ev1',
        thumbBlobKey: 'coalesce/ev1-thumb',
      },
    });
    const ev2 = await app.db.evidence.create({
      data: { ...base, contentType: 'codeblock', title: 'Shell log', fullBlobKey: 'coalesce/ev2' },
    });
    await truncateAuditLog(app);
    const content = (ev: { uuid: string }, cookie: string) =>
      get(`/web/engagements/op1/evidence/${ev.uuid}/content`, cookie);

    const [a, b] = await Promise.all([content(ev1, writer), content(ev1, writer)]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.body).toBe('can dump bytes');

    let rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'download',
      entityType: 'evidence',
      entityId: ev1.uuid,
      entityLabel: 'CAN dump',
      coalesceKey: 'download',
      coalescedCount: 2,
      changes: [],
      summary: `Downloaded evidence “CAN dump” (${EVIDENCE_TYPE_LABELS.codeblock})`,
      actorId: users.writer.id,
      via: 'session',
      engagementId: eng.id,
      engagementSlug: 'op1',
    });

    // A different item is a different key; so is a different viewer.
    expect((await content(ev2, writer)).statusCode).toBe(200);
    expect((await content(ev1, admin)).statusCode).toBe(200);
    rows = await entries();
    expect(rows.map((r) => [r.entityId, r.actorId, r.coalescedCount])).toEqual([
      [ev1.uuid, users.writer.id, 2],
      [ev2.uuid, users.writer.id, 1],
      [ev1.uuid, users.admin.id, 1],
    ]);

    // Thumbnails render in every timeline row and never record.
    const thumb = await get(`/web/engagements/op1/evidence/${ev1.uuid}/thumbnail`, writer);
    expect(thumb.statusCode).toBe(200);
    expect(await entries()).toHaveLength(3);
    expect((await entries()).map((r) => r.coalescedCount)).toEqual([2, 1, 1]);
  });

  // Pins DECISIONS: "Only a wrong password against a known, live account is
  // recorded (coalesced)" — on the fixed key `auth-fail` (audit.ts header), so
  // an attacker cannot write unbounded permanent rows — and the header's "every
  // other `recordAudit` entry never folds" for the sign-in that follows.
  it('folds wrong-password attempts against a known live account on `auth-fail`; unknown and disabled accounts write nothing; sign-ins never fold', async () => {
    const { users } = await setup();
    await app.db.user.update({ where: { id: users.reader.id }, data: { disabled: true } });
    await truncateAuditLog(app);
    const login = (email: string, password: string) =>
      app.inject({
        method: 'POST',
        url: '/web/login',
        headers: WEB_HEADERS,
        payload: { email, password },
      });

    const bad = await Promise.all([
      login('writer@test.local', 'wrong-1'),
      login('writer@test.local', 'wrong-2'),
      login('writer@test.local', 'wrong-3'),
    ]);
    expect(bad.map((r) => r.statusCode)).toEqual([401, 401, 401]);

    let rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'sign_in_failed',
      entityType: 'user',
      entityId: users.writer.slug,
      entityLabel: 'Wendy Writer',
      coalesceKey: 'auth-fail',
      coalescedCount: 3,
      changes: [],
      summary: 'Failed sign-in: wrong password',
      actorId: users.writer.id,
      actorEmail: 'writer@test.local',
      via: 'session',
      engagementId: null,
    });

    // An unknown email, a disabled account with a wrong password, and a
    // disabled account with the RIGHT password: the same uniform 401, no row.
    expect((await login('nobody@test.local', 'wrong')).statusCode).toBe(401);
    expect((await login('reader@test.local', 'wrong')).statusCode).toBe(401);
    expect((await login('reader@test.local', 'password123')).statusCode).toBe(401);
    rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.coalescedCount).toBe(3);
    expect(JSON.stringify(rows)).not.toContain('nobody@test.local');

    // Two successful sign-ins are two discrete rows: `recordAudit` never folds.
    expect((await login('writer@test.local', 'password123')).statusCode).toBe(200);
    expect((await login('writer@test.local', 'password123')).statusCode).toBe(200);
    rows = await entries();
    expect(rows.map((r) => [r.action, r.coalesceKey, r.coalescedCount])).toEqual([
      ['sign_in_failed', 'auth-fail', 3],
      ['sign_in', null, 1],
      ['sign_in', null, 1],
    ]);
  });

  // Pins the other fixed-key action (audit.ts header: "`api_key_auth` (every
  // HMAC request would otherwise be a row)"), under the load a polling capture
  // client produces: concurrent signed requests, one row, one count.
  it('folds concurrent HMAC requests by one user into one `api_key_auth` row on key `auth`', async () => {
    const { users } = await setup();
    const key = await apiKeyFor(app, users.writer.id);
    await truncateAuditLog(app);
    const signed = () => {
      const headers = buildAuthHeaders(
        'GET',
        '/api/checkconnection',
        Buffer.alloc(0),
        key.accessKey,
        key.secretKey,
      );
      return app.inject({ method: 'GET', url: '/api/checkconnection', headers });
    };

    const results = await Promise.all(Array.from({ length: 5 }, signed));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);

    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'api_key_auth',
      entityType: 'user',
      entityId: users.writer.slug,
      coalesceKey: 'auth',
      coalescedCount: 5,
      changes: [],
      via: 'apikey',
      actorId: users.writer.id,
      engagementId: null,
    });
    expect(JSON.stringify(rows)).not.toContain(key.accessKey);
  });
});
