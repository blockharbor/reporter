import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { AUDIT_TX_TIMEOUT_MS } from '../src/services/audit.js';
import {
  WEB_HEADERS,
  buildTestApp,
  loginCookie,
  seedUsers,
  truncateAll,
  truncateAuditLog,
} from './helpers.js';

// The two referential actions at the scale a long-lived engagement reaches.
// Deleting an engagement or a user SET NULLs the matching FK on EVERY audit row
// that names it, and each of those updates fires the guard trigger — which is
// why services/audit.ts raised the transaction limits (AUDIT_TX_TIMEOUT_MS) for
// the handlers that do it. Each case seeds 50 000 rows of its own (two seeds,
// so the cases are independent of each other's outcome; one raw INSERT … SELECT
// FROM generate_series costs well under a second) and then proves the delete
// returns 200 well inside the budget, that every row lost only its FK and kept
// its snapshots, and that nothing was deleted.

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

const ROWS = 50_000;
/** Every tenth seeded row is the admin's; the rest are the writer's. */
const ADMIN_ROWS = ROWS / 10;
const WRITER_ROWS = ROWS - ADMIN_ROWS;
/** Half the transaction budget: the delete has to be comfortably inside it, not just under it. */
const BUDGET_MS = AUDIT_TX_TIMEOUT_MS / 2;

async function setup() {
  const users = await seedUsers(app);
  const eng = await app.db.engagement.create({
    data: {
      slug: 'op1',
      name: 'Op One',
      roles: {
        create: [
          { userId: users.admin.id, role: 'admin' },
          { userId: users.writer.id, role: 'write' },
        ],
      },
    },
  });
  const admin = await loginCookie(app, 'admin@test.local', 'password123');
  await truncateAuditLog(app);

  // Rows shaped exactly as the recorder writes a coalescable evidence edit,
  // spread back one second apart so they are not all one timestamp. `uuid` has
  // no database default (Prisma generates it client-side), so it is supplied.
  const inserted = await app.db.$executeRaw(Prisma.sql`
    INSERT INTO audit_entries
      (uuid, engagement_id, engagement_slug, engagement_name,
       actor_id, actor_name, actor_email, via, action, entity_type, entity_id, entity_label,
       summary, changes, coalesce_key, coalesced_count, source, created_at, last_at)
    SELECT gen_random_uuid()::text, ${eng.id}, 'op1', 'Op One',
           CASE WHEN i % 10 = 0 THEN ${users.admin.id} ELSE ${users.writer.id} END,
           CASE WHEN i % 10 = 0 THEN 'Ada Admin' ELSE 'Wendy Writer' END,
           CASE WHEN i % 10 = 0 THEN 'admin@test.local' ELSE 'writer@test.local' END,
           'session', 'update', 'evidence', 'seed-' || i, 'Item ' || i,
           'Edited evidence “Item ' || i || '”: Title',
           jsonb_build_array(jsonb_build_object(
             'kind', 'field', 'field', 'title', 'from', 'Item ' || i, 'to', 'Item ' || i || ' (v2)')),
           'title', 1, 'intent',
           timezone('UTC', now()) - make_interval(secs => i),
           timezone('UTC', now()) - make_interval(secs => i)
      FROM generate_series(1, ${ROWS}) AS i`);
  expect(inserted).toBe(ROWS);
  expect(await app.db.auditEntry.count()).toBe(ROWS);
  return { users, eng, admin };
}

/** A seeded row, to compare before and after the referential action. */
const seedRow = (i: number) =>
  app.db.auditEntry.findFirstOrThrow({ where: { entityId: `seed-${i}` } });

describe('referential actions over 50 000 audit rows', () => {
  it(
    'DELETE /web/engagements/:slug returns 200 inside the budget, SET NULLs every row, keeps the slug/name snapshots and deletes nothing',
    { timeout: 180_000 },
    async () => {
      const { users, eng, admin } = await setup();
      const before = await seedRow(1);
      expect(before.engagementId).toBe(eng.id);

      const t0 = performance.now();
      const res = await app.inject({
        method: 'DELETE',
        url: '/web/engagements/op1',
        headers: { ...WEB_HEADERS, cookie: admin },
      });
      const ms = Math.round(performance.now() - t0);
      console.log(
        `audit-scale: engagement delete over ${ROWS} audit rows took ${ms} ms (budget ${BUDGET_MS} ms, tx timeout ${AUDIT_TX_TIMEOUT_MS} ms)`,
      );
      expect(res.statusCode).toBe(200);
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(await app.db.engagement.count()).toBe(0);

      // 50 000 seeded rows plus the delete entry itself; nothing deleted.
      expect(await app.db.auditEntry.count()).toBe(ROWS + 1);
      expect(await app.db.auditEntry.count({ where: { entityId: { startsWith: 'seed-' } } })).toBe(
        ROWS,
      );
      // Every row — the delete entry included — lost its FK and nothing else.
      expect(await app.db.auditEntry.count({ where: { engagementId: null } })).toBe(ROWS + 1);
      expect(
        await app.db.auditEntry.count({
          where: { engagementId: null, engagementSlug: 'op1', engagementName: 'Op One' },
        }),
      ).toBe(ROWS + 1);

      const after = await seedRow(1);
      expect(after).toEqual({ ...before, engagementId: null });
      expect(after.actorId).toBe(users.writer.id);

      const del = await app.db.auditEntry.findFirstOrThrow({
        where: { action: 'delete', entityType: 'engagement' },
      });
      expect(del).toMatchObject({
        engagementId: null,
        engagementSlug: 'op1',
        engagementName: 'Op One',
        entityId: String(eng.id),
        entityLabel: 'Op One',
        actorId: users.admin.id,
        actorName: 'Ada Admin',
        via: 'session',
        coalesceKey: null,
      });
      expect(del.summary).toMatch(/^Deleted engagement “Op One” \(op1\)/);
    },
  );

  it(
    'DELETE /web/admin/users/:slug for an actor named on 45 000 rows returns 200 inside the budget, SET NULLs the actor and keeps the name/email snapshots',
    { timeout: 180_000 },
    async () => {
      const { users, eng, admin } = await setup();
      const before = await seedRow(1);
      expect(before.actorId).toBe(users.writer.id);

      const t0 = performance.now();
      const res = await app.inject({
        method: 'DELETE',
        url: `/web/admin/users/${users.writer.slug}`,
        headers: { ...WEB_HEADERS, cookie: admin },
      });
      const ms = Math.round(performance.now() - t0);
      console.log(
        `audit-scale: user delete over ${WRITER_ROWS} audit rows took ${ms} ms (budget ${BUDGET_MS} ms, tx timeout ${AUDIT_TX_TIMEOUT_MS} ms)`,
      );
      expect(res.statusCode).toBe(200);
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(await app.db.user.findUnique({ where: { id: users.writer.id } })).toBeNull();

      // 50 000 seeded rows plus the admin's delete entry; nothing deleted.
      expect(await app.db.auditEntry.count()).toBe(ROWS + 1);
      expect(await app.db.auditEntry.count({ where: { actorId: users.writer.id } })).toBe(0);
      expect(
        await app.db.auditEntry.count({
          where: { actorId: null, actorName: 'Wendy Writer', actorEmail: 'writer@test.local' },
        }),
      ).toBe(WRITER_ROWS);
      // The admin's rows — the seeded tenth and the delete entry — keep their FK.
      expect(await app.db.auditEntry.count({ where: { actorId: users.admin.id } })).toBe(
        ADMIN_ROWS + 1,
      );
      // The engagement is untouched by a user delete, so every row still points at it.
      expect(await app.db.auditEntry.count({ where: { engagementId: eng.id } })).toBe(ROWS);

      const after = await seedRow(1);
      expect(after).toEqual({ ...before, actorId: null });

      const del = await app.db.auditEntry.findFirstOrThrow({
        where: { action: 'delete', entityType: 'user' },
      });
      expect(del).toMatchObject({
        entityId: users.writer.slug,
        entityLabel: 'Wendy Writer',
        actorId: users.admin.id,
        actorName: 'Ada Admin',
        engagementId: null,
        via: 'session',
        coalesceKey: null,
      });
      expect(del.summary).toMatch(/^Deleted user “Wendy Writer” \(writer@test\.local\)/);
    },
  );
});
