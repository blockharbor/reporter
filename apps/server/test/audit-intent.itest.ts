import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AuditEntry } from '@prisma/client';
import { buildAuthHeaders, buildMultipart } from '@reporter/api-client';
import { EVIDENCE_TYPE_LABELS, FINDINGS_EXPORT_VERSION } from '@reporter/shared';
import {
  WEB_HEADERS,
  apiKeyFor,
  buildTestApp,
  loginCookie,
  seedUsers,
  truncateAll,
  truncateAuditLog,
} from './helpers.js';

// The hand-written intent entries, handler by handler: EXACT row counts. Every
// case builds its fixtures, truncates the log, sends ONE request through
// `app.inject`, reads the WHOLE table in id order and asserts the exact list of
// `[action, entityType, source]`. An extra backstop row for a side-effect write
// the handler should have claimed is a failure; a missing hand-written row is a
// failure; and `source` is asserted on every row, because telling the two
// layers apart is what this suite is for. What the backstop does on its own
// (audit-backstop.itest), how entries fold (audit-coalesce.itest) and the read
// API (audit-routes.itest) are covered elsewhere and not repeated here.

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
/** The whole table as `[action, entityType, source]`, in id order. */
const shape = (rows: AuditEntry[]) => rows.map((r) => [r.action, r.entityType, r.source]);
/** The coalesce keys of a multi-field save, order-independent (they land in one createMany). */
const keys = (rows: AuditEntry[]) => rows.map((r) => r.coalesceKey).sort();
const changesFor = (rows: AuditEntry[], key: string) =>
  rows.find((r) => r.coalesceKey === key)!.changes;
const dump = (rows: AuditEntry[]) => JSON.stringify(rows);

/** 200 chars of distinctive base64 — the body of a threat-model diagram that must never be stored. */
const DIAGRAM_MARKER = 'UExBTlRFRERJQUdSQU0x'.repeat(10);

function get(url: string, cookie: string) {
  return app.inject({ method: 'GET', url, headers: { ...WEB_HEADERS, cookie } });
}
function post(url: string, cookie: string, payload?: unknown) {
  return app.inject({ method: 'POST', url, headers: { ...WEB_HEADERS, cookie }, payload });
}
function put(url: string, cookie: string, payload: unknown) {
  return app.inject({ method: 'PUT', url, headers: { ...WEB_HEADERS, cookie }, payload });
}
function patch(url: string, cookie: string, payload: unknown) {
  return app.inject({ method: 'PATCH', url, headers: { ...WEB_HEADERS, cookie }, payload });
}
function del(url: string, cookie: string) {
  return app.inject({ method: 'DELETE', url, headers: { ...WEB_HEADERS, cookie } });
}
function signed(
  method: 'GET' | 'POST',
  url: string,
  key: { accessKey: string; secretKey: string },
  body?: unknown,
) {
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const headers = buildAuthHeaders(method, url, raw, key.accessKey, key.secretKey);
  return app.inject({
    method,
    url,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : raw,
  });
}

/**
 * One engagement with the three seeded users (admin is its admin, writer writes,
 * reader is NOT a member — the membership cases add them), one tag, one piece of
 * evidence with real blob bytes (so the content and thumbnail routes serve), one
 * finding and one target → activity → goal. Both cookies are issued and the log
 * is truncated LAST, so every case starts from zero rows.
 */
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
      tags: { create: [{ name: 'recon', colorName: 'blue', position: 0 }] },
    },
    include: { tags: true },
  });
  const tag = eng.tags[0]!;
  const bytes = Buffer.from('candump can0\n  can0  7DF   [8]  02 01 0C 00 00 00 00 00\n', 'utf8');
  await app.blobs.put('intent/can-dump', bytes);
  await app.blobs.put('intent/can-dump-thumb', Buffer.from('thumb bytes'));
  const ev = await app.db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: users.writer.id,
      contentType: 'codeblock',
      title: 'CAN dump',
      occurredAt: new Date(),
      fullBlobKey: 'intent/can-dump',
      thumbBlobKey: 'intent/can-dump-thumb',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    },
  });
  const finding = await app.db.finding.create({
    data: { engagementId: eng.id, title: 'F1', position: 0 },
  });
  const target = await app.db.engagementTarget.create({
    data: {
      engagementId: eng.id,
      name: 'ECU',
      position: 0,
      activities: {
        create: {
          name: 'CAN',
          position: 0,
          goals: { create: { title: 'Enumerate ECUs', position: 0 } },
        },
      },
    },
    include: { activities: { include: { goals: true } } },
  });
  const activity = target.activities[0]!;
  const goal = activity.goals[0]!;
  const admin = await loginCookie(app, 'admin@test.local', 'password123');
  const writer = await loginCookie(app, 'writer@test.local', 'password123');
  await truncateAuditLog(app);
  return { users, eng, tag, ev, finding, target, activity, goal, admin, writer };
}

/** A second, untitled-type piece of evidence for the link and reorder cases. */
function secondEvidence(engagementId: number, operatorId: number, title = 'Shell log') {
  return app.db.evidence.create({
    data: { engagementId, operatorId, contentType: 'none', title, occurredAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Engagements
// ---------------------------------------------------------------------------

describe('engagements', () => {
  it('POST /engagements writes one create entry and nothing for the nested role and tag rows', async () => {
    const { users, admin } = await setup();
    const res = await post('/web/engagements', admin, { slug: 'new-eng', name: 'New Engagement' });
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['create', 'engagement', 'intent']]);
    expect(rows[0]).toMatchObject({
      engagementSlug: 'new-eng',
      entityLabel: 'New Engagement',
      actorId: users.admin.id,
      via: 'session',
      summary: 'Created engagement “New Engagement” (new-eng)',
      changes: [{ kind: 'count', label: 'Default tags copied', count: 0 }],
    });
  });

  it('PUT /engagements/:slug with two changed fields writes one update entry per field', async () => {
    const { eng, admin } = await setup();
    const res = await put('/web/engagements/op1', admin, {
      name: 'Op One Renamed',
      clientName: 'ACME',
    });
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([
      ['update', 'engagement', 'intent'],
      ['update', 'engagement', 'intent'],
    ]);
    expect(keys(rows)).toEqual(['clientName', 'name']);
    for (const r of rows) {
      expect(r).toMatchObject({
        entityId: String(eng.id),
        entityLabel: 'Op One',
        engagementId: eng.id,
        coalescedCount: 1,
      });
      expect(r.summary).toMatch(/^Edited engagement “Op One”: /);
    }
    expect(changesFor(rows, 'name')).toEqual([
      { kind: 'field', field: 'name', from: 'Op One', to: 'Op One Renamed' },
    ]);
    expect(changesFor(rows, 'clientName')).toEqual([
      { kind: 'field', field: 'clientName', from: null, to: 'ACME' },
    ]);
  });

  it('PUT /engagements/:slug with a threat-model diagram records the list change and stores none of the image', async () => {
    const { eng, admin } = await setup();
    const imageDataUri = `data:image/png;base64,${DIAGRAM_MARKER}`;
    const res = await put('/web/engagements/op1', admin, {
      threatModelDiagrams: [{ imageDataUri, caption: 'Trust boundaries' }],
    });
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['update', 'engagement', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(eng.id),
      coalesceKey: 'threatModelDiagrams',
    });
    const change = (
      rows[0]!.changes as Array<{
        kind: string;
        field: string;
        from: unknown[];
        to: Array<{ label: string; hash: string }>;
      }>
    )[0]!;
    expect(change).toMatchObject({ kind: 'list', field: 'threatModelDiagrams', from: [] });
    expect(change.to).toHaveLength(1);
    expect(change.to[0]!.label).toBe('Trust boundaries');
    expect(change.to[0]!.hash).toMatch(/^[0-9a-f]{16}$/);

    // The named assertion: the image is nowhere in the table. Not the body, not
    // its last 64 chars (those are hashed by `threatDiagramRefOf`, never
    // stored), not even the data: prefix.
    const all = dump(rows);
    expect(all).not.toContain(DIAGRAM_MARKER);
    expect(all).not.toContain(imageDataUri.slice(-64));
    expect(all).not.toContain('base64,');
  });

  it('PUT /engagements/:slug that changes nothing writes nothing', async () => {
    const { admin } = await setup();
    const res = await put('/web/engagements/op1', admin, { name: 'Op One' });
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('DELETE /engagements/:slug writes one delete entry with a null FK and the snapshots', async () => {
    const { users, eng, admin } = await setup();
    const res = await del('/web/engagements/op1', admin);
    expect(res.statusCode).toBe(200);
    expect(await app.db.engagement.count()).toBe(0);

    const rows = await entries();
    expect(shape(rows)).toEqual([['delete', 'engagement', 'intent']]);
    expect(rows[0]).toMatchObject({
      engagementId: null,
      engagementSlug: 'op1',
      engagementName: 'Op One',
      entityId: String(eng.id),
      entityLabel: 'Op One',
      actorId: users.admin.id,
      summary: 'Deleted engagement “Op One” (op1): 1 evidence, 1 finding, 0 reports',
      changes: [
        { kind: 'count', label: 'Evidence', count: 1 },
        { kind: 'count', label: 'Findings', count: 1 },
        { kind: 'count', label: 'Reports', count: 0 },
      ],
    });
  });

  it('POST /engagements/:slug/users adding a member writes one create member entry', async () => {
    const { users, eng, admin } = await setup();
    const res = await post('/web/engagements/op1/users', admin, {
      email: 'reader@test.local',
      role: 'read',
    });
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['create', 'member', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(users.reader.id),
      entityLabel: 'Ravi Reader',
      engagementId: eng.id,
      actorId: users.admin.id,
      summary: 'Added Ravi Reader (reader@test.local) to the engagement as read',
      changes: [{ kind: 'field', field: 'role', from: null, to: 'read' }],
    });
  });

  it('POST /engagements/:slug/users with the same role again writes nothing', async () => {
    const { admin } = await setup();
    const member = { email: 'reader@test.local', role: 'read' };
    expect((await post('/web/engagements/op1/users', admin, member)).statusCode).toBe(200);
    await truncateAuditLog(app);

    expect((await post('/web/engagements/op1/users', admin, member)).statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('POST /engagements/:slug/users changing a role writes one update member entry', async () => {
    const { users, admin } = await setup();
    expect(
      (
        await post('/web/engagements/op1/users', admin, {
          email: 'reader@test.local',
          role: 'read',
        })
      ).statusCode,
    ).toBe(200);
    await truncateAuditLog(app);

    const res = await post('/web/engagements/op1/users', admin, {
      email: 'reader@test.local',
      role: 'write',
    });
    expect(res.statusCode).toBe(200);
    const rows = await entries();
    expect(shape(rows)).toEqual([['update', 'member', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(users.reader.id),
      coalesceKey: null,
      summary: "Changed Ravi Reader's role from read to write",
      changes: [{ kind: 'field', field: 'role', from: 'read', to: 'write' }],
    });
  });

  it('DELETE /engagements/:slug/users/:userSlug removing a member writes one delete member entry', async () => {
    const { users, admin } = await setup();
    expect(
      (
        await post('/web/engagements/op1/users', admin, {
          email: 'reader@test.local',
          role: 'read',
        })
      ).statusCode,
    ).toBe(200);
    await truncateAuditLog(app);

    const res = await del(`/web/engagements/op1/users/${users.reader.slug}`, admin);
    expect(res.statusCode).toBe(200);
    const rows = await entries();
    expect(shape(rows)).toEqual([['delete', 'member', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(users.reader.id),
      entityLabel: 'Ravi Reader',
      summary: 'Removed Ravi Reader (reader@test.local) from the engagement',
      changes: [{ kind: 'field', field: 'role', from: 'read', to: null }],
    });
  });

  it('DELETE /engagements/:slug/users/:userSlug for a non-member writes nothing', async () => {
    const { users, admin } = await setup();
    const res = await del(`/web/engagements/op1/users/${users.reader.slug}`, admin);
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe('evidence', () => {
  it('POST /engagements/:slug/evidence with tags writes one create entry and nothing for the tag links', async () => {
    const { users, eng, tag, writer } = await setup();
    const res = await post('/web/engagements/op1/evidence', writer, {
      contentType: 'codeblock',
      title: 'Shell log',
      content: 'id\nuid=0(root)\n',
      tagIds: [tag.id],
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.tags).toHaveLength(1);

    const rows = await entries();
    expect(shape(rows)).toEqual([['create', 'evidence', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: created.uuid,
      entityLabel: 'Shell log',
      engagementId: eng.id,
      actorId: users.writer.id,
      via: 'session',
      summary: `Created evidence “Shell log” (${EVIDENCE_TYPE_LABELS.codeblock})`,
    });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'field',
      field: 'contentType',
      from: null,
      to: 'codeblock',
    });
    expect(rows[0]!.changes).toContainEqual({ kind: 'items', label: 'Tags', items: ['recon'] });
  });

  it('POST /api/engagements/:slug/evidence over HMAC writes the guard’s api_key_auth row and one create entry via apikey', async () => {
    const { users, eng } = await setup();
    const key = await apiKeyFor(app, users.writer.id);
    await truncateAuditLog(app);

    const res = await signed('POST', '/api/engagements/op1/evidence', key, {
      contentType: 'codeblock',
      title: 'Via API',
      content: 'whoami\n',
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();

    const rows = await entries();
    expect(shape(rows)).toEqual([
      ['api_key_auth', 'user', 'intent'],
      ['create', 'evidence', 'intent'],
    ]);
    expect(rows[0]).toMatchObject({
      entityId: users.writer.slug,
      via: 'apikey',
      actorId: users.writer.id,
      coalesceKey: 'auth',
      engagementId: null,
    });
    expect(rows[1]).toMatchObject({
      entityId: created.uuid,
      entityLabel: 'Via API',
      via: 'apikey',
      actorId: users.writer.id,
      engagementId: eng.id,
      summary: `Created evidence “Via API” (${EVIDENCE_TYPE_LABELS.codeblock})`,
    });
    expect(dump(rows)).not.toContain(key.accessKey);
    expect(dump(rows)).not.toContain(key.secretKey);
  });

  it('PUT /engagements/:slug/evidence/:uuid changing title and tags writes one update entry per field and nothing for evidenceTag', async () => {
    const { ev, tag, writer } = await setup();
    const res = await put(`/web/engagements/op1/evidence/${ev.uuid}`, writer, {
      title: 'CAN dump (ECU)',
      tagIds: [tag.id],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toHaveLength(1);

    const rows = await entries();
    expect(shape(rows)).toEqual([
      ['update', 'evidence', 'intent'],
      ['update', 'evidence', 'intent'],
    ]);
    expect(keys(rows)).toEqual(['tags', 'title']);
    for (const r of rows) expect(r).toMatchObject({ entityId: ev.uuid, entityLabel: 'CAN dump' });
    expect(changesFor(rows, 'title')).toEqual([
      { kind: 'field', field: 'title', from: 'CAN dump', to: 'CAN dump (ECU)' },
    ]);
    const tags = (
      changesFor(rows, 'tags') as Array<{ kind: string; to: Array<{ label: string }> }>
    )[0]!;
    expect(tags.kind).toBe('list');
    expect(tags.to.map((t) => t.label)).toEqual(['recon']);
  });

  it('PUT /engagements/:slug/evidence/:uuid that changes nothing writes nothing', async () => {
    const { ev, writer } = await setup();
    const res = await put(`/web/engagements/op1/evidence/${ev.uuid}`, writer, {
      title: 'CAN dump',
    });
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('GET /engagements/:slug/evidence/:uuid/content writes one download entry', async () => {
    const { users, ev, eng, writer } = await setup();
    const res = await get(`/web/engagements/op1/evidence/${ev.uuid}/content`, writer);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('candump');

    const rows = await entries();
    expect(shape(rows)).toEqual([['download', 'evidence', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: ev.uuid,
      entityLabel: 'CAN dump',
      coalesceKey: 'download',
      coalescedCount: 1,
      changes: [],
      engagementId: eng.id,
      actorId: users.writer.id,
      summary: `Downloaded evidence “CAN dump” (${EVIDENCE_TYPE_LABELS.codeblock})`,
    });
  });

  it('GET /engagements/:slug/evidence/:uuid/thumbnail writes nothing', async () => {
    const { ev, writer } = await setup();
    const res = await get(`/web/engagements/op1/evidence/${ev.uuid}/thumbnail`, writer);
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('DELETE /engagements/:slug/evidence/:uuid?comments=cascade with one comment writes one delete entry', async () => {
    const { users, eng, ev, writer } = await setup();
    await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'none',
        title: 'Follow-up',
        occurredAt: new Date(),
        parentEvidenceId: ev.id,
      },
    });
    await truncateAuditLog(app);

    const res = await del(`/web/engagements/op1/evidence/${ev.uuid}?comments=cascade`, writer);
    expect(res.statusCode).toBe(200);
    expect(await app.db.evidence.count()).toBe(0);

    const rows = await entries();
    expect(shape(rows)).toEqual([['delete', 'evidence', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: ev.uuid,
      entityLabel: 'CAN dump',
      summary: 'Deleted evidence “CAN dump” and its 1 comment',
    });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'items',
      label: 'Comments deleted',
      items: ['Follow-up'],
    });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'field',
      field: 'contentType',
      from: 'codeblock',
      to: null,
    });
  });

  it('DELETE /engagements/:slug/evidence/:uuid orphaning one comment writes one delete entry', async () => {
    const { users, eng, ev, writer } = await setup();
    const comment = await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'none',
        title: 'Follow-up',
        occurredAt: new Date(),
        parentEvidenceId: ev.id,
      },
    });
    await truncateAuditLog(app);

    const res = await del(`/web/engagements/op1/evidence/${ev.uuid}`, writer);
    expect(res.statusCode).toBe(200);
    const kept = await app.db.evidence.findUniqueOrThrow({ where: { id: comment.id } });
    expect(kept.parentEvidenceId).toBeNull();

    const rows = await entries();
    expect(shape(rows)).toEqual([['delete', 'evidence', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: ev.uuid,
      summary: 'Deleted evidence “CAN dump”; 1 comment kept as top-level evidence',
    });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Comments kept', count: 1 });
  });
});

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

describe('findings', () => {
  it('POST /engagements/:slug/findings writes one create entry', async () => {
    const { users, eng, writer } = await setup();
    const res = await post('/web/engagements/op1/findings', writer, {
      title: 'Broken AuthZ',
      description: '',
      category: null,
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();

    const rows = await entries();
    expect(shape(rows)).toEqual([['create', 'finding', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: created.uuid,
      entityLabel: 'Broken AuthZ',
      engagementId: eng.id,
      actorId: users.writer.id,
      summary: 'Created finding “Broken AuthZ”',
      changes: [
        { kind: 'field', field: 'kind', from: null, to: 'weakness' },
        { kind: 'field', field: 'fixEffort', from: null, to: 'none' },
      ],
    });
  });

  it('POST /engagements/:slug/findings with a new category writes the backstop’s category create then the intent entry', async () => {
    const { writer } = await setup();
    const res = await post('/web/engagements/op1/findings', writer, {
      title: 'Weak ciphers',
      description: '',
      category: 'Cryptography',
    });
    expect(res.statusCode).toBe(201);

    const rows = await entries();
    expect(shape(rows)).toEqual([
      ['create', 'finding_category', 'backstop'],
      ['create', 'finding', 'intent'],
    ]);
    expect(rows[0]).toMatchObject({ entityLabel: 'Cryptography', engagementSlug: 'op1' });
    expect(rows[1]!.changes).toContainEqual({
      kind: 'field',
      field: 'category',
      from: null,
      to: 'Cryptography',
    });
  });

  it('PUT /engagements/:slug/findings/:uuid changing severity and readyToReport writes one update entry per field', async () => {
    const { finding, writer } = await setup();
    const res = await put(`/web/engagements/op1/findings/${finding.uuid}`, writer, {
      severity: 'high',
      readyToReport: true,
    });
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([
      ['update', 'finding', 'intent'],
      ['update', 'finding', 'intent'],
    ]);
    expect(keys(rows)).toEqual(['readyToReport', 'severity']);
    for (const r of rows) expect(r).toMatchObject({ entityId: finding.uuid, entityLabel: 'F1' });
    expect(changesFor(rows, 'severity')).toEqual([
      { kind: 'field', field: 'severity', from: null, to: 'high' },
    ]);
    expect(changesFor(rows, 'readyToReport')).toEqual([
      { kind: 'field', field: 'readyToReport', from: false, to: true },
    ]);
  });

  it('PUT /engagements/:slug/findings/:uuid that changes nothing writes nothing', async () => {
    const { finding, writer } = await setup();
    const res = await put(`/web/engagements/op1/findings/${finding.uuid}`, writer, {
      title: 'F1',
    });
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('DELETE /engagements/:slug/findings/:uuid with one linked evidence writes one delete entry', async () => {
    const { ev, finding, writer } = await setup();
    await app.db.evidenceFinding.create({
      data: { evidenceId: ev.id, findingId: finding.id, position: 0 },
    });
    await truncateAuditLog(app);

    const res = await del(`/web/engagements/op1/findings/${finding.uuid}`, writer);
    expect(res.statusCode).toBe(200);
    expect(await app.db.finding.count()).toBe(0);

    const rows = await entries();
    expect(shape(rows)).toEqual([['delete', 'finding', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: finding.uuid,
      entityLabel: 'F1',
      summary: 'Deleted finding “F1”; 1 evidence detached',
    });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Evidence links', count: 1 });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Goal links', count: 0 });
  });

  it('POST /engagements/:slug/findings/:uuid/evidence attaching two items writes one link entry', async () => {
    const { users, eng, ev, finding, writer } = await setup();
    const ev2 = await secondEvidence(eng.id, users.writer.id);
    await truncateAuditLog(app);

    const res = await post(`/web/engagements/op1/findings/${finding.uuid}/evidence`, writer, {
      evidenceUuids: [ev.uuid, ev2.uuid],
    });
    expect(res.json()).toEqual({ ok: true, attached: 2 });

    const rows = await entries();
    expect(shape(rows)).toEqual([['link', 'finding', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: finding.uuid,
      entityLabel: 'F1',
      summary: 'Attached 2 evidence to finding “F1” (attached evidence)',
      changes: [{ kind: 'items', label: 'Attached evidence', items: ['CAN dump', 'Shell log'] }],
    });
  });

  it('POST /engagements/:slug/findings/:uuid/evidence for already-attached evidence writes nothing', async () => {
    const { ev, finding, writer } = await setup();
    await app.db.evidenceFinding.create({
      data: { evidenceId: ev.id, findingId: finding.id, position: 0 },
    });
    await truncateAuditLog(app);

    const res = await post(`/web/engagements/op1/findings/${finding.uuid}/evidence`, writer, {
      evidenceUuids: [ev.uuid],
    });
    expect(res.json()).toEqual({ ok: true, attached: 0 });
    expect(await entries()).toEqual([]);
  });

  it('PATCH /engagements/:slug/findings/:uuid/evidence/:evidenceUuid setting a caption writes one finding_evidence update', async () => {
    const { ev, finding, writer } = await setup();
    await app.db.evidenceFinding.create({
      data: { evidenceId: ev.id, findingId: finding.id, position: 0, inPath: true },
    });
    await truncateAuditLog(app);

    const res = await patch(
      `/web/engagements/op1/findings/${finding.uuid}/evidence/${ev.uuid}`,
      writer,
      { caption: 'Gained a foothold' },
    );
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['update', 'finding_evidence', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: `${finding.uuid}:${ev.uuid}`,
      entityLabel: 'F1 ↔ CAN dump',
      coalesceKey: 'caption',
      summary: 'Edited the caption of evidence “CAN dump” on finding “F1”',
      changes: [{ kind: 'field', field: 'caption', from: '', to: 'Gained a foothold' }],
    });
  });

  it('PATCH /engagements/:slug/findings/:uuid/evidence/:evidenceUuid moving buckets writes one finding_evidence update', async () => {
    const { ev, finding, writer } = await setup();
    await app.db.evidenceFinding.create({
      data: { evidenceId: ev.id, findingId: finding.id, position: 0 },
    });
    await truncateAuditLog(app);

    const res = await patch(
      `/web/engagements/op1/findings/${finding.uuid}/evidence/${ev.uuid}`,
      writer,
      { inPath: true },
    );
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['update', 'finding_evidence', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: `${finding.uuid}:${ev.uuid}`,
      coalesceKey: null,
      summary: 'Moved evidence “CAN dump” to the attack path of finding “F1”',
      changes: [{ kind: 'field', field: 'inPath', from: false, to: true }],
    });
  });

  it('PATCH /engagements/:slug/findings/:uuid/evidence/:evidenceUuid with both caption and bucket writes two entries', async () => {
    const { ev, finding, writer } = await setup();
    await app.db.evidenceFinding.create({
      data: { evidenceId: ev.id, findingId: finding.id, position: 0 },
    });
    await truncateAuditLog(app);

    const res = await patch(
      `/web/engagements/op1/findings/${finding.uuid}/evidence/${ev.uuid}`,
      writer,
      { caption: 'Step 1', inPath: true },
    );
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([
      ['update', 'finding_evidence', 'intent'],
      ['update', 'finding_evidence', 'intent'],
    ]);
    expect(rows.map((r) => r.coalesceKey)).toEqual([null, 'caption']);
  });

  it('DELETE /engagements/:slug/findings/:uuid/evidence/:evidenceUuid writes one unlink entry', async () => {
    const { ev, finding, writer } = await setup();
    await app.db.evidenceFinding.create({
      data: { evidenceId: ev.id, findingId: finding.id, position: 0 },
    });
    await truncateAuditLog(app);

    const res = await del(
      `/web/engagements/op1/findings/${finding.uuid}/evidence/${ev.uuid}`,
      writer,
    );
    expect(res.statusCode).toBe(200);
    expect(await app.db.evidenceFinding.count()).toBe(0);

    const rows = await entries();
    expect(shape(rows)).toEqual([['unlink', 'finding', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: finding.uuid,
      summary: 'Detached evidence “CAN dump” from finding “F1” (attached evidence)',
      changes: [{ kind: 'items', label: 'Attached evidence', items: ['CAN dump'] }],
    });
  });

  it('DELETE /engagements/:slug/findings/:uuid/evidence/:evidenceUuid for a non-link writes nothing', async () => {
    const { ev, finding, writer } = await setup();
    const res = await del(
      `/web/engagements/op1/findings/${finding.uuid}/evidence/${ev.uuid}`,
      writer,
    );
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('PATCH /engagements/:slug/findings/reorder writes one reorder entry on the engagement', async () => {
    const { eng, finding, writer } = await setup();
    const f2 = await app.db.finding.create({
      data: { engagementId: eng.id, title: 'F2', position: 1 },
    });
    await truncateAuditLog(app);

    const res = await patch('/web/engagements/op1/findings/reorder', writer, {
      orderedUuids: [f2.uuid, finding.uuid],
    });
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['reorder', 'engagement', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(eng.id),
      entityLabel: 'Op One',
      summary: 'Reordered 2 findings',
      changes: [{ kind: 'order', field: 'findings', from: ['F1', 'F2'], to: ['F2', 'F1'] }],
    });
  });

  it('PATCH /engagements/:slug/findings/reorder to the same order writes nothing', async () => {
    const { eng, finding, writer } = await setup();
    const f2 = await app.db.finding.create({
      data: { engagementId: eng.id, title: 'F2', position: 1 },
    });
    await truncateAuditLog(app);

    const res = await patch('/web/engagements/op1/findings/reorder', writer, {
      orderedUuids: [finding.uuid, f2.uuid],
    });
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('PATCH /engagements/:slug/findings/:uuid/evidence/reorder writes one reorder entry on the finding', async () => {
    const { users, eng, ev, finding, writer } = await setup();
    const ev2 = await secondEvidence(eng.id, users.writer.id);
    await app.db.evidenceFinding.createMany({
      data: [
        { evidenceId: ev.id, findingId: finding.id, position: 0 },
        { evidenceId: ev2.id, findingId: finding.id, position: 1 },
      ],
    });
    await truncateAuditLog(app);

    const res = await patch(
      `/web/engagements/op1/findings/${finding.uuid}/evidence/reorder`,
      writer,
      { orderedUuids: [ev2.uuid, ev.uuid] },
    );
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['reorder', 'finding', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: finding.uuid,
      entityLabel: 'F1',
      summary: 'Reordered 2 evidence in the attached evidence of finding “F1”',
      changes: [
        {
          kind: 'order',
          field: 'attachedEvidence',
          from: ['CAN dump', 'Shell log'],
          to: ['Shell log', 'CAN dump'],
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

describe('goals', () => {
  it('PATCH /engagements/:slug/targets/reorder writes one reorder entry on the engagement', async () => {
    const { eng, target, writer } = await setup();
    const t2 = await app.db.engagementTarget.create({
      data: { engagementId: eng.id, name: 'TCU', position: 1 },
    });
    await truncateAuditLog(app);

    const res = await patch('/web/engagements/op1/targets/reorder', writer, {
      orderedIds: [t2.id, target.id],
    });
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['reorder', 'engagement', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(eng.id),
      summary: 'Reordered 2 targets',
      changes: [{ kind: 'order', field: 'targets', from: ['ECU', 'TCU'], to: ['TCU', 'ECU'] }],
    });
  });

  it('PATCH /engagements/:slug/targets/reorder to the same order writes nothing', async () => {
    const { eng, target, writer } = await setup();
    const t2 = await app.db.engagementTarget.create({
      data: { engagementId: eng.id, name: 'TCU', position: 1 },
    });
    await truncateAuditLog(app);

    const res = await patch('/web/engagements/op1/targets/reorder', writer, {
      orderedIds: [target.id, t2.id],
    });
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('PATCH /engagements/:slug/targets/:id/activities/reorder writes one reorder entry on the target', async () => {
    const { target, activity, writer } = await setup();
    const a2 = await app.db.targetActivity.create({
      data: { targetId: target.id, name: 'UDS', position: 1 },
    });
    await truncateAuditLog(app);

    const res = await patch(
      `/web/engagements/op1/targets/${target.id}/activities/reorder`,
      writer,
      {
        orderedIds: [a2.id, activity.id],
      },
    );
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['reorder', 'target', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(target.id),
      entityLabel: 'ECU',
      summary: 'Reordered 2 activities under target “ECU”',
      changes: [{ kind: 'order', field: 'activities', from: ['CAN', 'UDS'], to: ['UDS', 'CAN'] }],
    });
  });

  it('PATCH /engagements/:slug/targets/:id/activities/reorder to the same order writes nothing', async () => {
    const { target, activity, writer } = await setup();
    const a2 = await app.db.targetActivity.create({
      data: { targetId: target.id, name: 'UDS', position: 1 },
    });
    await truncateAuditLog(app);

    const res = await patch(
      `/web/engagements/op1/targets/${target.id}/activities/reorder`,
      writer,
      {
        orderedIds: [activity.id, a2.id],
      },
    );
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('PATCH /engagements/:slug/activities/:id/goals/reorder writes one reorder entry on the activity', async () => {
    const { activity, goal, writer } = await setup();
    const g2 = await app.db.activityGoal.create({
      data: { activityId: activity.id, title: 'Fuzz UDS', position: 1 },
    });
    await truncateAuditLog(app);

    const res = await patch(
      `/web/engagements/op1/activities/${activity.id}/goals/reorder`,
      writer,
      {
        orderedIds: [g2.id, goal.id],
      },
    );
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['reorder', 'activity', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(activity.id),
      entityLabel: 'CAN',
      summary: 'Reordered 2 goals under activity “CAN”',
      changes: [
        {
          kind: 'order',
          field: 'goals',
          from: ['Enumerate ECUs', 'Fuzz UDS'],
          to: ['Fuzz UDS', 'Enumerate ECUs'],
        },
      ],
    });
  });

  it('PATCH /engagements/:slug/activities/:id/goals/reorder to the same order writes nothing', async () => {
    const { activity, goal, writer } = await setup();
    const g2 = await app.db.activityGoal.create({
      data: { activityId: activity.id, title: 'Fuzz UDS', position: 1 },
    });
    await truncateAuditLog(app);

    const res = await patch(
      `/web/engagements/op1/activities/${activity.id}/goals/reorder`,
      writer,
      {
        orderedIds: [goal.id, g2.id],
      },
    );
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('POST /engagements/:slug/goals/:id/evidence writes the intent link entry, then the backstop’s auto-advance update', async () => {
    const { ev, goal, writer } = await setup();
    const res = await post(`/web/engagements/op1/goals/${goal.id}/evidence`, writer, {
      evidenceUuids: [ev.uuid],
    });
    expect(res.json()).toEqual({ linked: 1 });

    // The documented decision (routes/web/goals.ts header): `activityGoal` is
    // deliberately absent from the link scope, so the status change is the
    // backstop's own entry, and the link entry is written first.
    const rows = await entries();
    expect(shape(rows)).toEqual([
      ['link', 'goal', 'intent'],
      ['update', 'goal', 'backstop'],
    ]);
    expect(rows[0]).toMatchObject({
      entityId: String(goal.id),
      entityLabel: 'Enumerate ECUs',
      summary: 'Linked evidence “CAN dump” to goal “Enumerate ECUs”',
      changes: [{ kind: 'items', label: 'Evidence', items: ['CAN dump'] }],
    });
    expect(rows[1]).toMatchObject({
      entityId: String(goal.id),
      coalesceKey: 'status',
      changes: [{ kind: 'field', field: 'status', from: 'not_started', to: 'in_progress' }],
    });
  });

  it('POST /engagements/:slug/goals/:id/evidence for already-linked evidence writes nothing', async () => {
    const { ev, goal, writer } = await setup();
    const link = { evidenceUuids: [ev.uuid] };
    expect(
      (await post(`/web/engagements/op1/goals/${goal.id}/evidence`, writer, link)).json(),
    ).toEqual({ linked: 1 });
    await truncateAuditLog(app);

    const res = await post(`/web/engagements/op1/goals/${goal.id}/evidence`, writer, link);
    expect(res.json()).toEqual({ linked: 1 });
    expect(await entries()).toEqual([]);
  });

  it('DELETE /engagements/:slug/goals/:id/evidence/:evidenceUuid writes one unlink entry', async () => {
    const { ev, goal, writer } = await setup();
    await app.db.goalEvidence.create({ data: { goalId: goal.id, evidenceId: ev.id } });
    await truncateAuditLog(app);

    const res = await del(`/web/engagements/op1/goals/${goal.id}/evidence/${ev.uuid}`, writer);
    expect(res.statusCode).toBe(200);
    expect(await app.db.goalEvidence.count()).toBe(0);

    const rows = await entries();
    expect(shape(rows)).toEqual([['unlink', 'goal', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(goal.id),
      summary: 'Unlinked evidence “CAN dump” from goal “Enumerate ECUs”',
      changes: [{ kind: 'items', label: 'Evidence', items: ['CAN dump'] }],
    });
  });

  it('POST /engagements/:slug/proposal/import writes exactly one import entry, whatever the proposal creates', async () => {
    const { eng, writer } = await setup();
    const res = await post('/web/engagements/op1/proposal/import', writer, {
      draft: {
        metadata: { clientName: 'May Mobility, Inc.' },
        targets: [
          {
            name: 'Fleet API',
            activities: [
              {
                name: 'REST API',
                category: 'Software / Application',
                goals: [{ title: 'Cryptographic Failures' }, { title: 'W1-TLS weak ciphers' }],
              },
            ],
          },
        ],
      },
      mode: 'merge',
      applyMetadata: true,
      rawProposal: { companyName: 'May Mobility, Inc.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      targetsCreated: 1,
      activitiesCreated: 1,
      goalsCreated: 2,
      metadataApplied: true,
    });
    // The import minted a tag and categories and touched the engagement: all silenced.
    expect(await app.db.tag.count({ where: { engagementId: eng.id, name: 'REST API' } })).toBe(1);

    const rows = await entries();
    expect(shape(rows)).toEqual([['import', 'engagement', 'intent']]);
    expect(rows[0]).toMatchObject({ entityId: String(eng.id), engagementId: eng.id });
    expect(rows[0]!.summary).toContain(
      'Imported a proposal into the goals tree: 1 target, 1 activity and 2 goals created',
    );
    expect(rows[0]!.summary).toContain('engagement details applied');
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Targets', count: 1 });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Activities', count: 1 });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Goals', count: 2 });
    // The raw proposal is a redacted blob and the entry simply never mentions it.
    expect(dump(rows)).not.toContain('companyName');
  });
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

describe('tags', () => {
  it('PUT /engagements/:slug/tags/:id renaming and recoloring writes one update entry', async () => {
    const { tag, writer } = await setup();
    const res = await put(`/web/engagements/op1/tags/${tag.id}`, writer, {
      name: 'recon-v2',
      colorName: 'red',
    });
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['update', 'tag', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(tag.id),
      entityLabel: 'recon',
      coalesceKey: null,
      summary: 'Renamed tag “recon” to “recon-v2” and changed its color from blue to red',
      changes: [
        { kind: 'field', field: 'name', from: 'recon', to: 'recon-v2' },
        { kind: 'field', field: 'colorName', from: 'blue', to: 'red' },
      ],
    });
  });

  it('PUT /engagements/:slug/tags/:id with no change writes nothing', async () => {
    const { tag, writer } = await setup();
    const res = await put(`/web/engagements/op1/tags/${tag.id}`, writer, {
      name: 'recon',
      colorName: 'blue',
    });
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('PATCH /engagements/:slug/tags/reorder writes one reorder entry on the engagement', async () => {
    const { eng, tag, writer } = await setup();
    const t2 = await app.db.tag.create({
      data: { engagementId: eng.id, name: 'exfil', colorName: 'pink', position: 1 },
    });
    await truncateAuditLog(app);

    const res = await patch('/web/engagements/op1/tags/reorder', writer, {
      orderedIds: [t2.id, tag.id],
    });
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['reorder', 'engagement', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(eng.id),
      summary: 'Reordered 2 tags',
      changes: [{ kind: 'order', field: 'tags', from: ['recon', 'exfil'], to: ['exfil', 'recon'] }],
    });
  });

  it('DELETE /engagements/:slug/tags/:id writes one delete entry carrying the usage counts', async () => {
    const { ev, tag, writer } = await setup();
    await app.db.evidenceTag.create({ data: { evidenceId: ev.id, tagId: tag.id } });
    await truncateAuditLog(app);

    const res = await del(`/web/engagements/op1/tags/${tag.id}`, writer);
    expect(res.statusCode).toBe(200);
    expect(await app.db.tag.count()).toBe(0);

    const rows = await entries();
    expect(shape(rows)).toEqual([['delete', 'tag', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(tag.id),
      entityLabel: 'recon',
      summary: 'Deleted tag “recon” (on 1 evidence and 0 findings)',
    });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Evidence', count: 1 });
  });

  it('POST /engagements/:slug/tags/:id/merge writes one merge entry on the surviving tag', async () => {
    const { eng, ev, tag, writer } = await setup();
    const into = await app.db.tag.create({
      data: { engagementId: eng.id, name: 'exfil', colorName: 'pink', position: 1 },
    });
    await app.db.evidenceTag.create({ data: { evidenceId: ev.id, tagId: tag.id } });
    await truncateAuditLog(app);

    const res = await post(`/web/engagements/op1/tags/${tag.id}/merge`, writer, {
      intoTagId: into.id,
    });
    expect(res.statusCode).toBe(200);
    expect(await app.db.tag.count()).toBe(1);

    const rows = await entries();
    expect(shape(rows)).toEqual([['merge', 'tag', 'intent']]);
    expect(rows[0]).toMatchObject({ entityId: String(into.id), entityLabel: 'exfil' });
    expect(rows[0]!.summary).toContain(
      'Merged tag “recon” into “exfil”: 1 evidence and 0 findings relinked',
    );
    expect(rows[0]!.changes).toContainEqual({
      kind: 'items',
      label: 'Merged from',
      items: ['recon'],
    });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Evidence moved', count: 1 });
  });

  it('POST /engagements/:slug/tags/:id/unapply writes one unapply entry', async () => {
    const { ev, tag, writer } = await setup();
    await app.db.evidenceTag.create({ data: { evidenceId: ev.id, tagId: tag.id } });
    await truncateAuditLog(app);

    const res = await post(`/web/engagements/op1/tags/${tag.id}/unapply`, writer, {});
    expect(res.statusCode).toBe(200);
    expect(await app.db.evidenceTag.count()).toBe(0);

    const rows = await entries();
    expect(shape(rows)).toEqual([['unapply', 'tag', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(tag.id),
      summary: 'Removed tag “recon” from 1 evidence and 0 findings',
      changes: [
        { kind: 'count', label: 'Evidence', count: 1 },
        { kind: 'count', label: 'Findings', count: 0 },
      ],
    });
  });

  it('POST /engagements/:slug/tags is left to the backstop: one create entry, source backstop', async () => {
    const { users, writer } = await setup();
    const res = await post('/web/engagements/op1/tags', writer, {
      name: 'exfil',
      colorName: 'pink',
    });
    expect(res.statusCode).toBe(201);

    const rows = await entries();
    expect(shape(rows)).toEqual([['create', 'tag', 'backstop']]);
    expect(rows[0]).toMatchObject({
      entityId: String(res.json().id),
      entityLabel: 'exfil',
      actorId: users.writer.id,
      via: 'session',
      engagementSlug: 'op1',
      summary: 'Created tag “exfil”',
    });
  });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

describe('admin', () => {
  it('PUT /admin/users/:slug flipping admin and disabled writes one discrete update per flag', async () => {
    const { users, admin } = await setup();
    const res = await put(`/web/admin/users/${users.writer.slug}`, admin, {
      admin: true,
      disabled: true,
    });
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([
      ['update', 'user', 'intent'],
      ['update', 'user', 'intent'],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        entityId: users.writer.slug,
        entityLabel: 'Wendy Writer',
        coalesceKey: null,
        engagementId: null,
        actorId: users.admin.id,
      });
    }
    expect(rows[0]).toMatchObject({
      summary: 'Granted site admin to “Wendy Writer”',
      changes: [{ kind: 'field', field: 'admin', from: false, to: true }],
    });
    expect(rows[1]).toMatchObject({
      summary: 'Disabled user “Wendy Writer”',
      changes: [{ kind: 'field', field: 'disabled', from: false, to: true }],
    });
  });

  it('PUT /admin/users/:slug with the same values writes nothing', async () => {
    const { users, admin } = await setup();
    const res = await put(`/web/admin/users/${users.writer.slug}`, admin, {
      admin: false,
      disabled: false,
    });
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('DELETE /admin/users/:slug writes one delete entry carrying the anonymization counts', async () => {
    const { users, admin } = await setup();
    const res = await del(`/web/admin/users/${users.writer.slug}`, admin);
    expect(res.statusCode).toBe(200);
    expect(await app.db.user.count({ where: { id: users.writer.id } })).toBe(0);

    const rows = await entries();
    expect(shape(rows)).toEqual([['delete', 'user', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: users.writer.slug,
      entityLabel: 'Wendy Writer',
      actorId: users.admin.id,
      engagementId: null,
      summary:
        'Deleted user “Wendy Writer” (writer@test.local): 1 evidence and 0 comments anonymized, 1 membership and 0 API keys revoked',
    });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'count',
      label: 'Evidence anonymized',
      count: 1,
    });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'count',
      label: 'Memberships revoked',
      count: 1,
    });
  });

  it('POST /admin/users/:slug/recovery writes one recovery_link_issued entry and never the code', async () => {
    const { users, admin } = await setup();
    const res = await post(`/web/admin/users/${users.writer.slug}/recovery`, admin);
    expect(res.statusCode).toBe(200);
    const code = String(res.json().recoveryUrl).split('/login/recovery/')[1]!;
    expect(code.length).toBeGreaterThan(20);

    const rows = await entries();
    expect(shape(rows)).toEqual([['recovery_link_issued', 'user', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: users.writer.slug,
      entityLabel: 'Wendy Writer',
      actorId: users.admin.id,
      summary: 'Issued a recovery link for “Wendy Writer”',
    });
    expect(rows[0]!.changes).toHaveLength(1);
    expect(rows[0]!.changes).toMatchObject([{ kind: 'field', field: 'expiresAt', from: null }]);
    expect(dump(rows)).not.toContain(code);
  });

  it('POST /admin/users/:slug/totp-reset writes one totp_reset entry and never the secret', async () => {
    const { users, admin } = await setup();
    const totpSecret = 'JBSWY3DPEHPK3PXPPLANTEDTOTPSECRET';
    await app.db.authIdentity.updateMany({
      where: { userId: users.writer.id },
      data: { totpSecret },
    });
    await truncateAuditLog(app);

    const res = await post(`/web/admin/users/${users.writer.slug}/totp-reset`, admin);
    expect(res.json()).toEqual({ ok: true, hadTotp: true });

    const rows = await entries();
    expect(shape(rows)).toEqual([['totp_reset', 'user', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: users.writer.slug,
      summary: 'Reset TOTP for “Wendy Writer”',
      changes: [{ kind: 'count', label: 'Identities cleared', count: 1 }],
    });
    expect(dump(rows)).not.toContain(totpSecret);
  });

  it('DELETE /admin/users/:slug/api-keys/:accessKey writes one api_key delete keyed on the row id, never the access key', async () => {
    const { users, admin } = await setup();
    const key = await apiKeyFor(app, users.writer.id);
    const row = await app.db.apiKey.findUniqueOrThrow({ where: { accessKey: key.accessKey } });
    await truncateAuditLog(app);

    const res = await del(
      `/web/admin/users/${users.writer.slug}/api-keys/${encodeURIComponent(key.accessKey)}`,
      admin,
    );
    expect(res.statusCode).toBe(200);
    expect(await app.db.apiKey.count()).toBe(0);

    const rows = await entries();
    expect(shape(rows)).toEqual([['delete', 'api_key', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(row.id),
      entityLabel: 'API key of Wendy Writer',
      actorId: users.admin.id,
      engagementId: null,
      summary: 'Revoked an API key of “Wendy Writer”',
      changes: [{ kind: 'field', field: 'createdAt', from: row.createdAt.toISOString(), to: null }],
    });
    expect(dump(rows)).not.toContain(key.accessKey);
    expect(dump(rows)).not.toContain(key.secretKey);
  });
});

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

describe('account', () => {
  it('POST /account/api-keys writes one api_key create keyed on the row id, never the key pair', async () => {
    const { users, writer } = await setup();
    const res = await post('/web/account/api-keys', writer, {});
    expect(res.statusCode).toBe(201);
    const { accessKey, secretKey } = res.json();
    const row = await app.db.apiKey.findUniqueOrThrow({ where: { accessKey } });

    const rows = await entries();
    expect(shape(rows)).toEqual([['create', 'api_key', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(row.id),
      entityLabel: 'API key',
      actorId: users.writer.id,
      engagementId: null,
      summary: 'Created an API key',
      changes: [],
    });
    expect(dump(rows)).not.toContain(accessKey);
    expect(dump(rows)).not.toContain(secretKey);
  });

  it('DELETE /account/api-keys/:accessKey writes one api_key delete', async () => {
    const { users, writer } = await setup();
    const key = await apiKeyFor(app, users.writer.id);
    const row = await app.db.apiKey.findUniqueOrThrow({ where: { accessKey: key.accessKey } });
    await truncateAuditLog(app);

    const res = await del(`/web/account/api-keys/${encodeURIComponent(key.accessKey)}`, writer);
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['delete', 'api_key', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(row.id),
      actorId: users.writer.id,
      summary: 'Revoked an API key',
      changes: [{ kind: 'field', field: 'createdAt', from: row.createdAt.toISOString(), to: null }],
    });
    expect(dump(rows)).not.toContain(key.accessKey);
  });

  it('POST /account/password writes one password_changed entry and neither password', async () => {
    const { users, writer } = await setup();
    const newPassword = 'Sup3rSecretNewPassw0rd!';
    const res = await post('/web/account/password', writer, {
      currentPassword: 'password123',
      newPassword,
    });
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['password_changed', 'user', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: users.writer.slug,
      entityLabel: 'Wendy Writer',
      actorId: users.writer.id,
      engagementId: null,
      summary: 'Changed password',
      changes: [],
    });
    const all = dump(rows);
    expect(all).not.toContain('password123');
    expect(all).not.toContain(newPassword);
    for (const identity of await app.db.authIdentity.findMany()) {
      if (identity.passwordHash) expect(all).not.toContain(identity.passwordHash);
    }
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  const login = (email: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/web/login',
      headers: WEB_HEADERS,
      payload: { email, password },
    });

  it('POST /login writes one sign_in entry', async () => {
    const { users } = await setup();
    const res = await login('writer@test.local', 'password123');
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['sign_in', 'user', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: users.writer.slug,
      entityLabel: 'Wendy Writer',
      actorId: users.writer.id,
      actorEmail: 'writer@test.local',
      via: 'session',
      engagementId: null,
      coalesceKey: null,
      summary: 'Signed in',
    });
  });

  it('POST /login with a wrong password for a live account writes one sign_in_failed entry', async () => {
    const { users } = await setup();
    const res = await login('writer@test.local', 'not-the-password');
    expect(res.statusCode).toBe(401);

    const rows = await entries();
    expect(shape(rows)).toEqual([['sign_in_failed', 'user', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: users.writer.slug,
      actorId: users.writer.id,
      coalesceKey: 'auth-fail',
      coalescedCount: 1,
      summary: 'Failed sign-in: wrong password',
    });
    expect(dump(rows)).not.toContain('not-the-password');
  });

  it('POST /login with an unknown email writes nothing', async () => {
    await setup();
    const res = await login('nobody@test.local', 'password123');
    expect(res.statusCode).toBe(401);
    expect(await entries()).toEqual([]);
  });

  it('POST /logout writes one sign_out entry', async () => {
    const { users, writer } = await setup();
    const res = await post('/web/logout', writer);
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['sign_out', 'user', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: users.writer.slug,
      actorId: users.writer.id,
      via: 'session',
      summary: 'Signed out',
    });
  });

  it('POST /logout with no live session writes nothing', async () => {
    await setup();
    const res = await app.inject({ method: 'POST', url: '/web/logout', headers: WEB_HEADERS });
    expect(res.statusCode).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('POST /setup on an empty database writes the first admin’s create and sign-in, both attributed to them', async () => {
    // No seedUsers: the beforeEach truncate left the users table empty.
    const password = 'firstadminpassw0rd';
    const res = await app.inject({
      method: 'POST',
      url: '/web/setup',
      headers: WEB_HEADERS,
      payload: { firstName: 'First', lastName: 'Admin', email: 'first@test.local', password },
    });
    expect(res.statusCode).toBe(200);
    const user = await app.db.user.findUniqueOrThrow({ where: { email: 'first@test.local' } });
    expect(user.admin).toBe(true);

    const rows = await entries();
    expect(shape(rows)).toEqual([
      ['create', 'user', 'intent'],
      ['sign_in', 'user', 'intent'],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        entityId: user.slug,
        entityLabel: 'First Admin',
        actorId: user.id,
        actorName: 'First Admin',
        actorEmail: 'first@test.local',
        via: 'session',
        engagementId: null,
      });
    }
    expect(rows[0]!.summary).toBe(
      'Created the first admin account “First Admin” (first@test.local)',
    );
    expect(rows[0]!.changes).toContainEqual({
      kind: 'count',
      label: 'Identities created',
      count: 1,
    });
    expect(rows[1]!.summary).toBe('Signed in');
    const all = dump(rows);
    expect(all).not.toContain(password);
    for (const identity of await app.db.authIdentity.findMany()) {
      if (identity.passwordHash) expect(all).not.toContain(identity.passwordHash);
    }
  });
});

// ---------------------------------------------------------------------------
// Reports and transfers
// ---------------------------------------------------------------------------

describe('reports and transfers', () => {
  it('GET /engagements/:slug/findings/export.json writes one export entry', async () => {
    const { users, eng, writer } = await setup();
    const res = await get('/web/engagements/op1/findings/export.json?includeAll=true', writer);
    expect(res.statusCode).toBe(200);
    expect(res.json().findings).toHaveLength(1);

    const rows = await entries();
    expect(shape(rows)).toEqual([['export', 'engagement', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(eng.id),
      entityLabel: 'Op One',
      engagementId: eng.id,
      actorId: users.writer.id,
      summary: 'Exported findings as JSON, including findings not ready to report',
    });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'field',
      field: 'includeAll',
      from: null,
      to: true,
    });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'count',
      label: 'Findings exported',
      count: 1,
    });
  });

  it('POST /engagements/:slug/findings/import writes exactly one import entry, whatever it creates', async () => {
    const { eng, writer } = await setup();
    const file = {
      schemaVersion: FINDINGS_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      engagement: { slug: 'other', name: 'Other' },
      includesEvidenceContent: false,
      findings: [
        {
          uuid: randomUUID(),
          title: 'Imported finding',
          description: '',
          remediation: '',
          category: 'Cryptography',
          kind: 'weakness',
          affectedTarget: '',
          impact: '',
          fixEffort: 'none',
          iso21434Refs: [],
          unr155Refs: [],
          severity: 'high',
          cvssVector: null,
          cvssScore: null,
          readyToReport: true,
          position: 0,
          evidence: [],
        },
      ],
    };
    const res = await post('/web/engagements/op1/findings/import', writer, file);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ findingsCreated: 1 });
    // A category was minted and a finding created: both silenced by the importer.
    expect(await app.db.findingCategory.count({ where: { engagementId: eng.id } })).toBe(1);

    const rows = await entries();
    expect(shape(rows)).toEqual([['import', 'engagement', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(eng.id),
      engagementId: eng.id,
      summary:
        'Imported findings from “other”: 1 finding created, 0 updated, 0 skipped; 0 evidence added, 0 linked, 0 skipped',
    });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Findings created', count: 1 });
  });

  it('GET /engagements/:slug/report.json writes one report_generated entry, and the artifact patch after it is silent', async () => {
    const { users, eng, writer } = await setup();
    const res = await get('/web/engagements/op1/report.json?preset=findings', writer);
    expect(res.statusCode).toBe(200);
    const report = await app.db.generatedReport.findFirstOrThrow({
      where: { engagementId: eng.id },
    });
    // The best-effort patch that stored the bytes ran (blobKey is set) and,
    // touching only ignored columns, left no row of its own.
    expect(report.blobKey).not.toBeNull();

    const rows = await entries();
    expect(shape(rows)).toEqual([['report_generated', 'generated_report', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: report.uuid,
      entityLabel: 'Findings only v1.0',
      engagementId: eng.id,
      actorId: users.writer.id,
      summary: 'Generated report v1.0 (JSON) — Findings only',
    });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'field',
      field: 'preset',
      from: null,
      to: 'findings',
    });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'field',
      field: 'format',
      from: null,
      to: 'json',
    });
  });

  // The `report_generated` entry itself is proven by the JSON case above, on the
  // identical `recordReport -> recordGeneratedReport` path; the PDF and ZIP
  // routes only differ in rendering a real document through headless Chrome,
  // which CI does not install and no other test in the suite renders. What is
  // worth pinning separately is the OTHER half of that render path: reading the
  // report branding. It used to be an `upsert` on a read, which minted the
  // singleton row on first render and let the backstop log "Created report
  // branding" against whoever rendered first. It is a `findUnique` now — the
  // defaults come back, no row is created, and nothing is recorded — so the one
  // write-free check below stands in for the branding half without a browser.
  // `report_settings` is not in the harness's TABLES, so it is cleared here to
  // make the pre-state deterministic rather than dependent on case order.
  it('GET /admin/report-settings reads the branding row without creating it or recording anything', async () => {
    const { admin } = await setup();
    await app.db.reportSettings.deleteMany();
    await truncateAuditLog(app);

    const res = await get('/web/admin/report-settings', admin);
    expect(res.statusCode).toBe(200);
    expect(res.json().organizationName).toBe('Block Harbor');
    // The row was NOT minted by the read, and the log is empty.
    expect(await app.db.reportSettings.count()).toBe(0);
    expect(await entries()).toHaveLength(0);
  });

  it('GET /engagements/:slug/reports/:uuid/download writes one download entry', async () => {
    const { users, eng, writer } = await setup();
    expect((await get('/web/engagements/op1/report.json?preset=findings', writer)).statusCode).toBe(
      200,
    );
    const report = await app.db.generatedReport.findFirstOrThrow({
      where: { engagementId: eng.id },
    });
    await truncateAuditLog(app);

    const res = await get(`/web/engagements/op1/reports/${report.uuid}/download`, writer);
    expect(res.statusCode).toBe(200);

    const rows = await entries();
    expect(shape(rows)).toEqual([['download', 'generated_report', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: report.uuid,
      entityLabel: 'Findings only v1.0',
      engagementId: eng.id,
      actorId: users.writer.id,
      coalesceKey: null,
      summary: 'Downloaded report v1.0 (JSON) — Findings only',
    });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'field',
      field: 'format',
      from: null,
      to: 'json',
    });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'count',
      label: 'Bytes',
      count: report.sizeBytes,
    });
  });

  it('GET /engagements/:slug/export.zip writes one export entry', async () => {
    const { users, eng, admin } = await setup();
    const res = await get('/web/engagements/op1/export.zip', admin);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');

    const rows = await entries();
    expect(shape(rows)).toEqual([['export', 'engagement', 'intent']]);
    expect(rows[0]).toMatchObject({
      entityId: String(eng.id),
      entityLabel: 'Op One',
      engagementId: eng.id,
      actorId: users.admin.id,
    });
    expect(rows[0]!.summary).toMatch(
      /^Exported engagement “Op One” as a backup \(1 evidence, 1 finding, /,
    );
    expect(rows[0]!.summary).toContain('0 of 0 audit entries');
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Evidence', count: 1 });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Findings', count: 1 });
  });

  it('POST /engagements/import writes exactly one import entry on the new engagement; the restored rows are marked import', async () => {
    const { users, eng, admin } = await setup();
    // Two rows for the archive to carry, from two real requests.
    expect((await put('/web/engagements/op1', admin, { clientName: 'ACME' })).statusCode).toBe(200);
    expect(
      (await post('/web/engagements/op1/tags', admin, { name: 'exfil', colorName: 'pink' }))
        .statusCode,
    ).toBe(201);
    expect(await app.db.auditEntry.count()).toBe(2);
    const exported = await get('/web/engagements/op1/export.zip', admin);
    expect(exported.statusCode).toBe(200);
    await truncateAuditLog(app);

    const { body, contentType } = buildMultipart({}, [
      {
        field: 'file',
        filename: 'engagement.zip',
        contentType: 'application/zip',
        data: exported.rawPayload,
      },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/web/engagements/import',
      headers: { ...WEB_HEADERS, cookie: admin, 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const copy = await app.db.engagement.findUniqueOrThrow({
      where: { slug: res.json().engagement.slug },
    });
    expect(copy.id).not.toBe(eng.id);

    const rows = await entries();
    const own = rows.filter((r) => r.source !== 'import');
    const restored = rows.filter((r) => r.source === 'import');
    expect(shape(own)).toEqual([['import', 'engagement', 'intent']]);
    expect(own[0]).toMatchObject({
      entityId: String(copy.id),
      engagementId: copy.id,
      engagementSlug: copy.slug,
      actorId: users.admin.id,
    });
    expect(own[0]!.summary).toContain('from a backup of “Op One” (op1');
    expect(own[0]!.summary).toContain('2 audit entries');
    expect(own[0]!.changes).toContainEqual({
      kind: 'count',
      label: 'Audit entries restored',
      count: 2,
    });
    expect(restored).toHaveLength(2);
    expect(restored.map((r) => [r.action, r.entityType]).sort()).toEqual([
      ['create', 'tag'],
      ['update', 'engagement'],
    ]);
    for (const r of restored) expect(r).toMatchObject({ engagementId: copy.id, coalesceKey: null });
    // Nothing landed on the source engagement.
    expect(rows.filter((r) => r.engagementId === eng.id)).toEqual([]);
  });
});
