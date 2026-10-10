import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedUsers, truncateAll, truncateAuditLog } from './helpers.js';

// The AuditEntry MODEL and its guard trigger, written straight through Prisma —
// the recorder that normally writes these rows is tested separately. What is
// pinned here is the database's side of the tamper-evidence contract: what a row
// outlives, what may change on it, and what the database refuses no matter who
// asks. Every case that expects a refusal asserts on the trigger's own message,
// so a guard that silently stopped firing fails loudly rather than passing.

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

async function setup() {
  const users = await seedUsers(app);
  const eng = await app.db.engagement.create({ data: { slug: 'op1', name: 'Op One' } });
  // The backstop records the fixture writes above as system rows. This file is
  // about rows written straight through Prisma, so start each case from an
  // empty log — the one sanctioned way to clear it (deleteMany is refused).
  await truncateAuditLog(app);
  return { users, eng };
}

/** A live entry about an evidence item, as the recorder would write it. */
function entry(
  engagementId: number,
  actor: { id: number; firstName: string; lastName: string; email: string },
) {
  return {
    engagementId,
    engagementSlug: 'op1',
    engagementName: 'Op One',
    actorId: actor.id,
    actorName: `${actor.firstName} ${actor.lastName}`,
    actorEmail: actor.email,
    via: 'session',
    action: 'update',
    entityType: 'evidence',
    entityId: 'e0a1b2c3-0000-4000-8000-000000000001',
    entityLabel: 'CAN dump',
    summary: 'Wendy Writer edited evidence “CAN dump”: Description',
    changes: [{ kind: 'field', field: 'description', from: 'before', to: 'after' }],
    coalesceKey: 'description',
    source: 'intent',
  };
}

/** The removal transition, exactly as the admin route performs it. */
const REMOVAL = (remover: { id: number; email: string }) => ({
  deletedAt: new Date(),
  deletedById: remover.id,
  deletedByName: 'Ada Admin',
  deletedByEmail: remover.email,
  deletedReason: 'A credential was pasted into the description.',
  changes: [],
  summary: '',
  entityLabel: '',
});

describe('snapshots outlive what they point at', () => {
  it('keeps the actor name and email after a hard user delete', async () => {
    const { users, eng } = await setup();
    const row = await app.db.auditEntry.create({ data: entry(eng.id, users.writer) });

    await app.db.user.delete({ where: { id: users.writer.id } });

    const after = await app.db.auditEntry.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.actorId).toBeNull();
    expect(after.actorName).toBe('Wendy Writer');
    expect(after.actorEmail).toBe('writer@test.local');
    // The content is untouched by the referential action.
    expect(after.summary).toBe(row.summary);
    expect(after.changes).toEqual(row.changes);
  });

  it('keeps the engagement slug and name after the engagement is deleted', async () => {
    const { users, eng } = await setup();
    const row = await app.db.auditEntry.create({ data: entry(eng.id, users.writer) });

    await app.db.engagement.delete({ where: { id: eng.id } });

    const after = await app.db.auditEntry.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.engagementId).toBeNull();
    expect(after.engagementSlug).toBe('op1');
    expect(after.engagementName).toBe('Op One');
  });
});

describe('the table is append-only', () => {
  it('refuses delete and deleteMany', async () => {
    const { users, eng } = await setup();
    const row = await app.db.auditEntry.create({ data: entry(eng.id, users.writer) });

    await expect(app.db.auditEntry.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(app.db.auditEntry.deleteMany({})).rejects.toThrow(/append-only/);
    expect(await app.db.auditEntry.count()).toBe(1);
  });

  it('refuses to rewrite a live row: summary, actor, action, entity, time, source', async () => {
    const { users, eng } = await setup();
    const row = await app.db.auditEntry.create({ data: entry(eng.id, users.writer) });

    // Each of these is a rewrite the removal path would leave a record of and
    // this path would not — which is exactly why the trigger refuses them.
    const rewrites: Record<string, unknown>[] = [
      { summary: 'Nothing happened here' },
      { actorName: 'Someone Else' },
      { actorEmail: 'else@test.local' },
      { action: 'create' },
      { entityType: 'finding' },
      { entityId: 'another-row' },
      { entityLabel: 'Renamed' },
      { createdAt: new Date('2020-01-01T00:00:00Z') },
      { source: 'backstop' },
      { via: 'apikey' },
      { coalesceKey: 'title' },
      { engagementSlug: 'op2' },
    ];
    for (const data of rewrites) {
      await expect(
        app.db.auditEntry.update({ where: { id: row.id }, data }),
        `rewrite of ${Object.keys(data).join(',')} must be refused`,
      ).rejects.toThrow(/never rewritten/);
    }
    // Raw SQL is refused by the same trigger — the guard is not a Prisma feature.
    await expect(
      app.db.$executeRawUnsafe(`UPDATE "audit_entries" SET "summary" = 'x' WHERE "id" = ${row.id}`),
    ).rejects.toThrow(/never rewritten/);

    const after = await app.db.auditEntry.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toEqual(row);
  });

  it('allows the coalescing fold: changes, a growing count, a later lastAt', async () => {
    const { users, eng } = await setup();
    const row = await app.db.auditEntry.create({ data: entry(eng.id, users.writer) });

    const later = new Date(row.lastAt.getTime() + 30_000);
    const folded = await app.db.auditEntry.update({
      where: { id: row.id },
      data: {
        changes: [{ kind: 'field', field: 'description', from: 'before', to: 'final' }],
        coalescedCount: 2,
        lastAt: later,
      },
    });
    expect(folded.coalescedCount).toBe(2);
    expect(folded.lastAt).toEqual(later);
    expect(folded.createdAt).toEqual(row.createdAt);

    // …but never backwards: the count cannot shrink and lastAt cannot retreat.
    await expect(
      app.db.auditEntry.update({ where: { id: row.id }, data: { coalescedCount: 1 } }),
    ).rejects.toThrow(/never rewritten/);
    await expect(
      app.db.auditEntry.update({ where: { id: row.id }, data: { lastAt: row.createdAt } }),
    ).rejects.toThrow(/never rewritten/);
  });
});

describe('removal', () => {
  it('needs a reason and a remover, and must leave no content behind', async () => {
    const { users, eng } = await setup();
    const row = await app.db.auditEntry.create({ data: entry(eng.id, users.writer) });
    const good = REMOVAL(users.admin);

    await expect(
      app.db.auditEntry.update({ where: { id: row.id }, data: { ...good, deletedReason: '   ' } }),
    ).rejects.toThrow(/needs a reason and a remover/);
    await expect(
      app.db.auditEntry.update({ where: { id: row.id }, data: { ...good, deletedByEmail: null } }),
    ).rejects.toThrow(/needs a reason and a remover/);
    await expect(
      app.db.auditEntry.update({
        where: { id: row.id },
        data: { ...good, changes: [{ kind: 'field', field: 'x', from: 1, to: 2 }] },
      }),
    ).rejects.toThrow(/carries no content/);
    await expect(
      app.db.auditEntry.update({ where: { id: row.id }, data: { ...good, summary: 'kept' } }),
    ).rejects.toThrow(/carries no content/);
    // A removal may not also re-word what it removes.
    await expect(
      app.db.auditEntry.update({ where: { id: row.id }, data: { ...good, actorName: 'Nobody' } }),
    ).rejects.toThrow(/may not rewrite/);

    // Still live after every refusal.
    expect(
      (await app.db.auditEntry.findUniqueOrThrow({ where: { id: row.id } })).deletedAt,
    ).toBeNull();

    const removed = await app.db.auditEntry.update({ where: { id: row.id }, data: good });
    expect(removed.deletedAt).not.toBeNull();
    expect(removed.deletedByName).toBe('Ada Admin');
    expect(removed.changes).toEqual([]);
    expect(removed.summary).toBe('');
    expect(removed.entityLabel).toBe('');
    // The skeleton survives: who, what kind of thing, when.
    expect(removed.actorName).toBe('Wendy Writer');
    expect(removed.action).toBe('update');
    expect(removed.entityType).toBe('evidence');
    expect(removed.entityId).toBe(row.entityId);
    expect(removed.createdAt).toEqual(row.createdAt);
  });

  it('freezes a removed row, except for the three foreign keys going to null', async () => {
    const { users, eng } = await setup();
    const row = await app.db.auditEntry.create({ data: entry(eng.id, users.writer) });
    await app.db.auditEntry.update({ where: { id: row.id }, data: REMOVAL(users.admin) });

    // Neither un-removing, re-wording the removal, nor folding is possible now.
    await expect(
      app.db.auditEntry.update({ where: { id: row.id }, data: { deletedAt: null } }),
    ).rejects.toThrow(/frozen/);
    await expect(
      app.db.auditEntry.update({
        where: { id: row.id },
        data: { deletedReason: 'changed my mind' },
      }),
    ).rejects.toThrow(/frozen/);
    await expect(
      app.db.auditEntry.update({ where: { id: row.id }, data: { coalescedCount: 2 } }),
    ).rejects.toThrow(/frozen/);
    await expect(
      app.db.auditEntry.update({ where: { id: row.id }, data: { summary: 'restored' } }),
    ).rejects.toThrow(/frozen/);
    await expect(app.db.auditEntry.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/,
    );

    // The referential actions still work: actor, remover and engagement can all
    // be deleted later, and the snapshots keep the tombstone readable.
    await app.db.user.delete({ where: { id: users.writer.id } });
    await app.db.user.delete({ where: { id: users.admin.id } });
    await app.db.engagement.delete({ where: { id: eng.id } });
    const after = await app.db.auditEntry.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.actorId).toBeNull();
    expect(after.deletedById).toBeNull();
    expect(after.engagementId).toBeNull();
    expect(after.actorName).toBe('Wendy Writer');
    expect(after.deletedByName).toBe('Ada Admin');
    expect(after.engagementSlug).toBe('op1');
    expect(after.deletedAt).not.toBeNull();
  });
});

describe('the test harness', () => {
  it('can truncate the table with removed rows present, and truncateAuditLog clears only the log', async () => {
    const { users, eng } = await setup();
    const row = await app.db.auditEntry.create({ data: entry(eng.id, users.writer) });
    await app.db.auditEntry.update({ where: { id: row.id }, data: REMOVAL(users.admin) });
    await app.db.auditEntry.create({ data: entry(eng.id, users.writer) });

    await truncateAuditLog(app);
    expect(await app.db.auditEntry.count()).toBe(0);
    // The fixture the log was about is still there.
    expect(await app.db.engagement.count()).toBe(1);
    expect(await app.db.user.count()).toBeGreaterThan(0);

    await app.db.auditEntry.create({ data: entry(eng.id, users.writer) });
    await truncateAll(app);
    expect(await app.db.auditEntry.count()).toBe(0);
    expect(await app.db.engagement.count()).toBe(0);
  });
});

describe('the fold lookup', () => {
  it('finds the latest live entry for an actor, entity and field by (createdAt, id)', async () => {
    const { users, eng } = await setup();
    const base = entry(eng.id, users.writer);
    const first = await app.db.auditEntry.create({ data: base });
    const byOther = await app.db.auditEntry.create({
      data: {
        ...base,
        actorId: users.admin.id,
        actorName: 'Ada Admin',
        actorEmail: 'admin@test.local',
      },
    });
    const removed = await app.db.auditEntry.create({ data: base });
    await app.db.auditEntry.update({ where: { id: removed.id }, data: REMOVAL(users.admin) });

    // The recorder's candidate: the writer's newest LIVE entry for this field.
    const candidate = await app.db.auditEntry.findFirst({
      where: {
        actorId: users.writer.id,
        entityType: 'evidence',
        entityId: base.entityId,
        coalesceKey: 'description',
        deletedAt: null,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(candidate?.id).toBe(first.id);
    // …and the newest entry for the same field by ANYONE is the other actor's,
    // which is what stops a fold from reaching back across someone else's edit.
    const newestAny = await app.db.auditEntry.findFirst({
      where: {
        entityType: 'evidence',
        entityId: base.entityId,
        coalesceKey: 'description',
        deletedAt: null,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(newestAny?.id).toBe(byOther.id);
  });
});
