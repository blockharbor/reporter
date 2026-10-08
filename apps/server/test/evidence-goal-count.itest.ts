import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WEB_HEADERS, buildTestApp, loginCookie, seedUsers, truncateAll } from './helpers.js';
import { evidenceInclude } from '../src/services/serializers.js';

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

/**
 * One engagement with a two-activity goal tree and three pieces of evidence:
 * `linked` hangs off three goals spread across both activities (so the count is not
 * the size of any single activity), `single` off one, and `bare` off none. A fourth
 * goal (`unused`) exists to prove the count is per-evidence rather than "how many
 * goals this engagement has".
 */
async function setup() {
  const users = await seedUsers(app);
  const eng = await app.db.engagement.create({
    data: {
      slug: 'op1',
      name: 'Op One',
      roles: { create: [{ userId: users.writer.id, role: 'write' }] },
    },
  });

  const target = await app.db.engagementTarget.create({
    data: { engagementId: eng.id, name: 'Fleet API', description: '', position: 0 },
  });
  const rest = await app.db.targetActivity.create({
    data: { targetId: target.id, name: 'REST API', position: 0 },
  });
  const mqtt = await app.db.targetActivity.create({
    data: { targetId: target.id, name: 'MQTT', position: 1 },
  });
  const auth = await app.db.activityGoal.create({
    data: { activityId: rest.id, title: 'Authentication', position: 0 },
  });
  const crypto = await app.db.activityGoal.create({
    data: { activityId: rest.id, title: 'Transport crypto', position: 1 },
  });
  const broker = await app.db.activityGoal.create({
    data: { activityId: mqtt.id, title: 'Broker ACLs', position: 0 },
  });
  const unused = await app.db.activityGoal.create({
    data: { activityId: mqtt.id, title: 'Topic naming', position: 1 },
  });

  const evidence = async (title: string, occurredAt: Date) =>
    app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        title,
        contentType: 'none',
        occurredAt,
      },
    });
  // Distinct capture times: the timeline sorts by `occurredAt` (newest first), so
  // the list assertions below can address rows by position.
  const linked = await evidence('Three goals', new Date('2024-03-03T00:00:00Z'));
  const single = await evidence('One goal', new Date('2024-03-02T00:00:00Z'));
  const bare = await evidence('No goals', new Date('2024-03-01T00:00:00Z'));

  await app.db.goalEvidence.createMany({
    data: [
      { goalId: auth.id, evidenceId: linked.id },
      { goalId: broker.id, evidenceId: linked.id },
      { goalId: crypto.id, evidenceId: linked.id },
      { goalId: crypto.id, evidenceId: single.id },
    ],
  });

  const cookie = await loginCookie(app, 'writer@test.local', 'password123');
  return { users, eng, cookie, goals: { auth, crypto, broker, unused }, linked, single, bare };
}

/** The evidence timeline (list response), newest first. */
async function listEvidence(cookie: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/web/engagements/op1/evidence',
    headers: { ...WEB_HEADERS, cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { items: { uuid: string; title: string; numGoals: number }[] };
}

/** A single piece of evidence (detail response). */
async function getEvidence(cookie: string, uuid: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/web/engagements/op1/evidence/${uuid}`,
    headers: { ...WEB_HEADERS, cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { numGoals: number };
}

describe('evidence numGoals', () => {
  it('is 0 for evidence linked to no goals', async () => {
    const { cookie, bare } = await setup();
    expect((await getEvidence(cookie, bare.uuid)).numGoals).toBe(0);
    const items = await listEvidence(cookie);
    expect(items.items.find((i) => i.uuid === bare.uuid)?.numGoals).toBe(0);
  });

  it('counts every goal the evidence is linked to', async () => {
    const { cookie, linked, single } = await setup();
    expect((await getEvidence(cookie, linked.uuid)).numGoals).toBe(3);
    expect((await getEvidence(cookie, single.uuid)).numGoals).toBe(1);
  });

  // The whole point of the field: a list shows the link without fetching each
  // item's goals, so the list's number has to agree with the detail view's.
  it('matches between the list and the detail response', async () => {
    const { cookie, linked, single, bare } = await setup();
    const { items } = await listEvidence(cookie);
    expect(items.map((i) => [i.title, i.numGoals])).toEqual([
      ['Three goals', 3],
      ['One goal', 1],
      ['No goals', 0],
    ]);
    for (const ev of [linked, single, bare]) {
      const detail = await getEvidence(cookie, ev.uuid);
      expect(detail.numGoals).toBe(items.find((i) => i.uuid === ev.uuid)!.numGoals);
    }
  });

  it('tracks a link being added and removed', async () => {
    const { cookie, goals, bare } = await setup();
    await app.db.goalEvidence.create({ data: { goalId: goals.unused.id, evidenceId: bare.id } });
    expect((await getEvidence(cookie, bare.uuid)).numGoals).toBe(1);
    await app.db.goalEvidence.delete({
      where: { goalId_evidenceId: { goalId: goals.unused.id, evidenceId: bare.id } },
    });
    expect((await getEvidence(cookie, bare.uuid)).numGoals).toBe(0);
  });

  // Reached through `serializeFindingEvidence`, which spreads `serializeEvidence`:
  // one `_count` on the shared include is what gives every surface the number.
  it('rides along on a finding’s attached evidence', async () => {
    const { cookie, eng, linked } = await setup();
    const finding = await app.db.finding.create({
      data: { engagementId: eng.id, title: 'Weak TLS ciphers', severity: 'high', position: 0 },
    });
    await app.db.evidenceFinding.create({
      data: { findingId: finding.id, evidenceId: linked.id },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/web/engagements/op1/findings/${finding.uuid}`,
      headers: { ...WEB_HEADERS, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { evidence: { numGoals: number }[] }).evidence[0]!.numGoals).toBe(3);
  });

  /**
   * The no-N+1 guarantee, asserted where it is actually decided: the goal count is
   * declared on `evidenceInclude`'s `_count`, so Prisma resolves it inside the same
   * `findMany` as the rest of the row — a page of 50 items costs one query, not 51.
   *
   * Be clear about the limit of this test: it reads the include rather than the SQL,
   * so it proves the count is *declared* on the shared include and cannot prove the
   * query plan. What it does catch is the regression that matters — someone moving
   * the count to a per-item `goalEvidence.count()` in a call site or a serializer.
   */
  it('counts goals on the shared include, not per item', () => {
    const include = evidenceInclude(1);
    expect(include._count.select.goals).toBe(true);
    expect(include._count.select.comments).toBe(true);
  });
});
