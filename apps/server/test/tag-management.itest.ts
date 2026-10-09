import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildAuthHeaders, buildMultipart } from '@reporter/api-client';
import { TAG_COLOR_NAMES } from '@reporter/shared';
import {
  WEB_HEADERS,
  apiKeyFor,
  buildTestApp,
  loginCookie,
  seedUsers,
  truncateAll,
} from './helpers.js';

// First integration coverage of the tag routes. Tags are addressed by NAME from
// three places outside the `tags` table (saved queries, the report's timeline
// config, and — by id — the Goals activity correlation), and by ORDER from every
// picker and chip row, so most of what is pinned here is what a rename, merge,
// unapply or reorder does to those neighbours rather than to the tag row itself.

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
  const eng = await app.db.engagement.create({
    data: {
      slug: 'op1',
      name: 'Op One',
      roles: {
        create: [
          { userId: users.writer.id, role: 'write' },
          { userId: users.reader.id, role: 'read' },
        ],
      },
    },
  });
  const cookie = await loginCookie(app, 'writer@test.local', 'password123');
  return { users, cookie, eng };
}

/** A second engagement the writer can also write to, for the isolation cases. */
async function setupSecond(writerId: number) {
  return app.db.engagement.create({
    data: {
      slug: 'op2',
      name: 'Op Two',
      roles: { create: [{ userId: writerId, role: 'write' }] },
    },
  });
}

function get(url: string, cookie: string) {
  return app.inject({ method: 'GET', url, headers: { cookie } });
}
function post(url: string, cookie: string, payload: unknown) {
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

interface TagRow {
  id: number;
  name: string;
  colorName: string;
  usageCount?: number;
  evidenceCount?: number;
  findingCount?: number;
  activityNames?: string[];
}

/** Create a tag through the web route (so it gets a real `position`). */
async function createTag(cookie: string, name: string, colorName = 'blue', slug = 'op1') {
  const res = await post(`/web/engagements/${slug}/tags`, cookie, { name, colorName });
  if (res.statusCode !== 201) throw new Error(`createTag ${name}: ${res.statusCode} ${res.body}`);
  return res.json() as TagRow;
}

async function listTags(cookie: string, slug = 'op1'): Promise<TagRow[]> {
  const res = await get(`/web/engagements/${slug}/tags`, cookie);
  if (res.statusCode !== 200) throw new Error(`listTags: ${res.statusCode} ${res.body}`);
  return res.json();
}

async function tagNames(cookie: string, slug = 'op1'): Promise<string[]> {
  return (await listTags(cookie, slug)).map((t) => t.name);
}

/** A piece of evidence carrying the given tags, written straight to the DB. */
async function createEvidence(
  engagementId: number,
  operatorId: number,
  description: string,
  tagIds: number[],
) {
  return app.db.evidence.create({
    data: {
      engagementId,
      operatorId,
      contentType: 'none',
      description,
      occurredAt: new Date(),
      tags: { create: tagIds.map((tagId) => ({ tagId })) },
    },
  });
}

/** The tag chip names an evidence row comes back with over the web plane. */
async function evidenceTagNames(cookie: string, uuid: string): Promise<string[]> {
  const res = await get(`/web/engagements/op1/evidence/${uuid}`, cookie);
  if (res.statusCode !== 200) throw new Error(`evidence ${uuid}: ${res.statusCode} ${res.body}`);
  return (res.json().tags as { name: string }[]).map((t) => t.name);
}

/** A finding carrying the given tags, written straight to the DB. */
async function createFindingWith(engagementId: number, title: string, tagIds: number[]) {
  return app.db.finding.create({
    data: {
      engagementId,
      title,
      tags: { create: tagIds.map((tagId) => ({ tagId })) },
    },
  });
}

/** The tag chip names a finding comes back with over the web plane. */
async function findingTagNames(cookie: string, uuid: string): Promise<string[]> {
  const res = await get(`/web/engagements/op1/findings/${uuid}`, cookie);
  if (res.statusCode !== 200) throw new Error(`finding ${uuid}: ${res.statusCode} ${res.body}`);
  return (res.json().tags as { name: string }[]).map((t) => t.name);
}

/** Create a Goals target + activity; the activity mints its own correlation tag. */
async function createActivity(cookie: string, name: string) {
  const target = (
    await post('/web/engagements/op1/targets', cookie, { name: `Target for ${name}` })
  ).json();
  const res = await post(`/web/engagements/op1/targets/${target.id}/activities`, cookie, { name });
  if (res.statusCode !== 200) throw new Error(`createActivity: ${res.statusCode} ${res.body}`);
  return res.json() as { id: number; tagId: number | null };
}

/** A timeline subsection in the shape the report editor writes. */
function timelineSection(title: string, tags: string[]) {
  return {
    kind: 'timeline',
    title,
    body: '',
    evidence: [],
    timeline: {
      tags,
      types: [],
      group: 'chronological',
      includeComments: false,
      starredOnly: false,
    },
  };
}

async function setNarrative(engagementId: number, subsections: unknown[]) {
  await app.db.engagement.update({
    where: { id: engagementId },
    data: { executionNarrative: subsections as never },
  });
}

async function readNarrative(engagementId: number): Promise<any[]> {
  const eng = await app.db.engagement.findUniqueOrThrow({
    where: { id: engagementId },
    select: { executionNarrative: true },
  });
  return eng.executionNarrative as any[];
}

/**
 * Download the whole-engagement export as bytes. The route is gated on the
 * engagement `admin` role, which a site admin bypasses — the import test does the
 * same, and the two helpers are copied from it rather than shared so neither
 * file's harness depends on the other's.
 */
async function exportArchive(cookie: string, slug = 'op1'): Promise<Buffer> {
  const res = await app.inject({
    method: 'GET',
    url: `/web/engagements/${slug}/export.zip`,
    headers: { ...WEB_HEADERS, cookie },
  });
  if (res.statusCode !== 200) throw new Error(`export ${slug}: ${res.statusCode} ${res.body}`);
  return res.rawPayload;
}

/** POST an archive to the import route (site admin only), as the web UI's upload. */
async function importArchive(cookie: string, archive: Buffer, fields: Record<string, string> = {}) {
  const { body, contentType } = buildMultipart(fields, [
    { field: 'file', filename: 'engagement.zip', contentType: 'application/zip', data: archive },
  ]);
  return app.inject({
    method: 'POST',
    url: '/web/engagements/import',
    headers: { ...WEB_HEADERS, cookie, 'content-type': contentType },
    payload: body,
  });
}

describe('tag list order', () => {
  it('lists tags in curated (creation) order, not alphabetically', async () => {
    const { cookie } = await setup();
    await createTag(cookie, 'zulu');
    await createTag(cookie, 'alpha');
    await createTag(cookie, 'mike');

    // POST assigns position = count, so creation order IS the curated order. An
    // `orderBy: { name: 'asc' }` creeping back into the read path fails this.
    expect(await tagNames(cookie)).toEqual(['zulu', 'alpha', 'mike']);
  });

  it('a new tag still lands at the end after a delete and after a merge', async () => {
    const { cookie } = await setup();
    const a = await createTag(cookie, 'a');
    const b = await createTag(cookie, 'b');
    const c = await createTag(cookie, 'c');

    // Delete and merge remove rows without compacting the survivors' positions,
    // so once `a` is gone the row count (2) is below the highest stored position
    // (c's 2). A count-based "next" put `aa` AT 2 — tied with `c`, and the name
    // tiebreak then read it mid-list as [b, aa, c]. `max + 1` keeps it last.
    expect((await del(`/web/engagements/op1/tags/${a.id}`, cookie)).statusCode).toBe(200);
    await createTag(cookie, 'aa');
    expect(await tagNames(cookie)).toEqual(['b', 'c', 'aa']);

    // A merge deletes its source too. With b(1) and aa(3) left, a count-based
    // `zz` would take 2 and sort in front of `aa` outright, no tiebreak involved.
    const merge = await post(`/web/engagements/op1/tags/${c.id}/merge`, cookie, {
      intoTagId: b.id,
    });
    expect(merge.statusCode).toBe(200);
    await createTag(cookie, 'zz');
    expect(await tagNames(cookie)).toEqual(['b', 'aa', 'zz']);

    // The Goals path mints its correlation tag through `ensureActivityTag`, which
    // has to take the same end-of-list position POST does. With `b` gone the
    // survivors sit at 3 and 4, so a count-based position (2) would put the new
    // activity's tag FIRST, not last.
    expect((await del(`/web/engagements/op1/tags/${b.id}`, cookie)).statusCode).toBe(200);
    const activity = await createActivity(cookie, 'Recon');
    expect(activity.tagId).toBeTypeOf('number');
    expect(await tagNames(cookie)).toEqual(['aa', 'zz', 'Recon']);
  });

  it('evidence chips follow the curated tag order', async () => {
    const { cookie, users, eng } = await setup();
    const zulu = await createTag(cookie, 'zulu');
    const alpha = await createTag(cookie, 'alpha');
    // Join rows written in creation order, which is also primary-key order, so
    // before the reorder every incidental order a read without the nested
    // orderBy could fall back to agrees with the curated one. The reorder is the
    // decisive step: afterwards neither heap order nor key order matches.
    const ev = await createEvidence(eng.id, users.writer.id, 'both', [zulu.id, alpha.id]);
    expect(await evidenceTagNames(cookie, ev.uuid)).toEqual(['zulu', 'alpha']);

    const reorder = await patch('/web/engagements/op1/tags/reorder', cookie, {
      orderedIds: [alpha.id, zulu.id],
    });
    expect(reorder.statusCode).toBe(200);

    // The SAME item's chips follow, on the detail route and on the timeline
    // list — both come through `evidenceInclude`, so both must agree.
    expect(await evidenceTagNames(cookie, ev.uuid)).toEqual(['alpha', 'zulu']);
    const list = await get('/web/engagements/op1/evidence', cookie);
    expect(list.statusCode).toBe(200);
    const items = list.json().items as { uuid: string; tags: { name: string }[] }[];
    expect(items.map((e) => [e.uuid, e.tags.map((t) => t.name)])).toEqual([
      [ev.uuid, ['alpha', 'zulu']],
    ]);
  });

  it("the migration's backfill turns a pre-position table into alphabetical positions", async () => {
    const { cookie, users, eng } = await setup();
    const op2 = await setupSecond(users.writer.id);
    await createTag(cookie, 'zulu');
    await createTag(cookie, 'alpha');
    await createTag(cookie, 'mike');
    await createTag(cookie, 'yankee', 'red', 'op2');
    await createTag(cookie, 'bravo', 'red', 'op2');

    // Simulate the column having just been added: every row at the default 0.
    await app.db.$executeRawUnsafe('UPDATE "tags" SET "position" = 0');
    // The backfill statement is read out of the migration itself rather than
    // copied here, so what runs below is what `prisma migrate deploy` runs — a
    // copy would keep passing after an edit to the real file broke it. The
    // partition is the clause worth naming: without it the ranks would run on
    // across engagements and op2 would not restart at 0.
    const sql = readFileSync(
      new URL('../prisma/migrations/20261009120000_tag_position/migration.sql', import.meta.url),
      'utf8',
    );
    expect(sql).toContain('PARTITION BY "engagement_id"');
    const backfill = sql.match(/UPDATE "tags"[\s\S]*?;/)?.[0];
    expect(backfill, 'the UPDATE "tags" backfill statement in migration.sql').toBeDefined();
    await app.db.$executeRawUnsafe(backfill!);

    // The stored positions are the alphabetical ranks, partitioned per
    // engagement (op2 restarts at 0) — asserted directly because with every row
    // at 0 the `name` tiebreak alone would already make GET read alphabetically.
    const rows = await app.db.tag.findMany({
      where: { engagementId: eng.id },
      orderBy: { position: 'asc' },
      select: { name: true, position: true },
    });
    expect(rows).toEqual([
      { name: 'alpha', position: 0 },
      { name: 'mike', position: 1 },
      { name: 'zulu', position: 2 },
    ]);
    const rows2 = await app.db.tag.findMany({
      where: { engagementId: op2.id },
      orderBy: { position: 'asc' },
      select: { name: true, position: true },
    });
    expect(rows2).toEqual([
      { name: 'bravo', position: 0 },
      { name: 'yankee', position: 1 },
    ]);

    expect(await tagNames(cookie)).toEqual(['alpha', 'mike', 'zulu']);
    expect(await tagNames(cookie, 'op2')).toEqual(['bravo', 'yankee']);
  });
});

describe('rename and recolor', () => {
  it('PUT renames and recolors, and a follow-up GET agrees', async () => {
    const { cookie } = await setup();
    const t = await createTag(cookie, 'alpha', 'blue');

    const res = await put(`/web/engagements/op1/tags/${t.id}`, cookie, {
      name: 'omega',
      colorName: 'green',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: t.id, name: 'omega', colorName: 'green' });

    const [row] = await listTags(cookie);
    expect(row).toMatchObject({ id: t.id, name: 'omega', colorName: 'green' });
  });

  it('a colorName-only patch keeps the name, and a name-only patch keeps the color', async () => {
    const { cookie } = await setup();
    const t = await createTag(cookie, 'alpha', 'blue');

    const recolor = await put(`/web/engagements/op1/tags/${t.id}`, cookie, { colorName: 'pink' });
    expect(recolor.statusCode).toBe(200);
    expect(recolor.json()).toMatchObject({ name: 'alpha', colorName: 'pink' });

    const rename = await put(`/web/engagements/op1/tags/${t.id}`, cookie, { name: 'beta' });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({ name: 'beta', colorName: 'pink' });
  });

  it('renaming onto a name already in use returns 409, not 500', async () => {
    const { cookie } = await setup();
    const a = await createTag(cookie, 'alpha');
    await createTag(cookie, 'beta');

    const res = await put(`/web/engagements/op1/tags/${a.id}`, cookie, { name: 'beta' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('A tag with that name already exists');

    // The trim happens before the collision check, so whitespace does not sneak
    // a visually identical label past it.
    const padded = await put(`/web/engagements/op1/tags/${a.id}`, cookie, { name: '  beta ' });
    expect(padded.statusCode).toBe(409);

    // Nothing moved.
    expect(await tagNames(cookie)).toEqual(['alpha', 'beta']);
  });

  it('saving a tag under its own name is not a collision', async () => {
    const { cookie } = await setup();
    const a = await createTag(cookie, 'alpha', 'blue');

    const res = await put(`/web/engagements/op1/tags/${a.id}`, cookie, {
      name: 'alpha',
      colorName: 'teal',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'alpha', colorName: 'teal' });
  });

  it('rejects an off-palette colorName and accepts every palette name, on PUT and POST', async () => {
    const { cookie } = await setup();
    const t = await createTag(cookie, 'alpha');

    const junkPut = await put(`/web/engagements/op1/tags/${t.id}`, cookie, {
      colorName: 'chartreuse',
    });
    expect(junkPut.statusCode).toBe(400);
    expect((await listTags(cookie))[0]!.colorName).toBe('blue');

    const junkPost = await post('/web/engagements/op1/tags', cookie, {
      name: 'junk',
      colorName: 'chartreuse',
    });
    expect(junkPost.statusCode).toBe(400);
    expect(await tagNames(cookie)).toEqual(['alpha']);

    for (const colorName of TAG_COLOR_NAMES) {
      const r = await put(`/web/engagements/op1/tags/${t.id}`, cookie, { colorName });
      expect(r.statusCode, `PUT colorName=${colorName}`).toBe(200);
      expect(r.json().colorName).toBe(colorName);

      const c = await post('/web/engagements/op1/tags', cookie, {
        name: `tag-${colorName}`,
        colorName,
      });
      expect(c.statusCode, `POST colorName=${colorName}`).toBe(201);
      expect(c.json().colorName).toBe(colorName);
    }
  });

  it('PUT {} is 400, and extra keys from the old Partial<Tag> client type are stripped', async () => {
    const { cookie } = await setup();
    const t = await createTag(cookie, 'alpha');

    const empty = await put(`/web/engagements/op1/tags/${t.id}`, cookie, {});
    expect(empty.statusCode).toBe(400);

    const res = await put(`/web/engagements/op1/tags/${t.id}`, cookie, {
      name: 'x',
      id: 999,
      usageCount: 7,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(t.id);

    const rows = await listTags(cookie);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: t.id, name: 'x', usageCount: 0 });
    // The id did not move under the row.
    expect(await app.db.tag.findUnique({ where: { id: 999 } })).toBeNull();
  });

  it('a non-numeric tag id is a 400, not a crash', async () => {
    const { cookie } = await setup();
    const res = await put('/web/engagements/op1/tags/abc', cookie, { name: 'x' });
    expect(res.statusCode).toBe(400);
  });
});

describe('rename follow-through', () => {
  it('rewrites the timeline config but leaves a saved query string byte-identical', async () => {
    const { cookie, eng } = await setup();
    const alpha = await createTag(cookie, 'alpha');
    const query = (
      await post('/web/engagements/op1/queries', cookie, {
        name: 'Starred alpha',
        query: 'tag:alpha starred',
        type: 'evidence',
      })
    ).json();
    const prose = { kind: 'narrative', title: 'Intro', body: 'alpha prose', evidence: [] };
    await setNarrative(eng.id, [prose, timelineSection('Alpha work', ['alpha'])]);

    const res = await put(`/web/engagements/op1/tags/${alpha.id}`, cookie, { name: 'omega' });
    expect(res.statusCode).toBe(200);

    const narrative = await readNarrative(eng.id);
    expect(narrative[0]).toEqual(prose);
    expect(narrative[1].timeline.tags).toEqual(['omega']);
    expect(narrative[1].title).toBe('Alpha work');

    const saved = await app.db.savedQuery.findUniqueOrThrow({ where: { id: query.id } });
    expect(saved.query).toBe('tag:alpha starred');

    // And the references endpoint now reflects that asymmetry: the timeline
    // section follows the new name, the saved query does not.
    const refs = (await get(`/web/engagements/op1/tags/${alpha.id}/references`, cookie)).json();
    expect(refs.savedQueries).toEqual([]);
    expect(refs.timelineSections).toEqual([{ index: 1, title: 'Alpha work' }]);
  });

  it('leaves executionNarrative untouched when nothing names the tag', async () => {
    const { cookie, eng } = await setup();
    const alpha = await createTag(cookie, 'alpha');
    // A legacy-shaped row: no `kind`, no `evidence`. A zod round trip would add
    // defaults; the rename path must write nothing at all here.
    const legacy = [{ title: 'Legacy', body: 'old prose' }, timelineSection('Other', ['gamma'])];
    await setNarrative(eng.id, legacy);

    const res = await put(`/web/engagements/op1/tags/${alpha.id}`, cookie, { name: 'omega' });
    expect(res.statusCode).toBe(200);
    expect(await readNarrative(eng.id)).toEqual(legacy);
  });
});

describe('usage counts', () => {
  it('splits evidence usage and reports the activity names', async () => {
    const { cookie, users, eng } = await setup();
    const t = await createTag(cookie, 'alpha');
    await createEvidence(eng.id, users.writer.id, 'one', [t.id]);
    await createEvidence(eng.id, users.writer.id, 'two', [t.id]);
    const unused = await createTag(cookie, 'unused');
    const activity = await createActivity(cookie, 'Recon');

    const rows = await listTags(cookie);
    const alpha = rows.find((r) => r.id === t.id)!;
    expect(alpha.evidenceCount).toBe(2);
    expect(alpha.usageCount).toBe(2);
    // No finding carries alpha here; the finding side is pinned in the next case.
    expect(alpha.findingCount).toBe(0);
    expect(alpha.activityNames).toEqual([]);

    expect(rows.find((r) => r.id === unused.id)).toMatchObject({
      evidenceCount: 0,
      usageCount: 0,
      activityNames: [],
    });
    expect(rows.find((r) => r.id === activity.tagId)).toMatchObject({
      name: 'Recon',
      evidenceCount: 0,
      activityNames: ['Recon'],
    });
  });

  it('counts findings separately and sums both into usageCount', async () => {
    const { cookie, users, eng } = await setup();
    const t = await createTag(cookie, 'alpha');
    await createEvidence(eng.id, users.writer.id, 'one', [t.id]);
    await createEvidence(eng.id, users.writer.id, 'two', [t.id]);
    await createFindingWith(eng.id, 'F1', [t.id]);
    await createFindingWith(eng.id, 'F2', [t.id]);
    await createFindingWith(eng.id, 'F3', [t.id]);
    // A finding with no tags must not be counted anywhere.
    await createFindingWith(eng.id, 'untagged', []);
    const findingsOnly = await createTag(cookie, 'findings-only');
    await createFindingWith(eng.id, 'F4', [findingsOnly.id]);

    const rows = await listTags(cookie);
    // The split is what the delete/merge/unapply confirmations quote — "2
    // evidence and 3 findings" — and `usageCount` stays the total every older
    // reader of that field expects.
    expect(rows.find((r) => r.id === t.id)).toMatchObject({
      evidenceCount: 2,
      findingCount: 3,
      usageCount: 5,
    });
    expect(rows.find((r) => r.id === findingsOnly.id)).toMatchObject({
      evidenceCount: 0,
      findingCount: 1,
      usageCount: 1,
    });
  });
});

describe('merge', () => {
  it('handles an item that already carries both tags without a duplicate chip', async () => {
    const { cookie, users, eng } = await setup();
    const t1 = await createTag(cookie, 't1');
    const t2 = await createTag(cookie, 't2');
    const a = await createEvidence(eng.id, users.writer.id, 'A', [t1.id]);
    const b = await createEvidence(eng.id, users.writer.id, 'B', [t1.id, t2.id]);
    const c = await createEvidence(eng.id, users.writer.id, 'C', [t2.id]);

    const res = await post(`/web/engagements/op1/tags/${t1.id}/merge`, cookie, {
      intoTagId: t2.id,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      movedEvidence: 1,
      evidenceAlreadyTagged: 1,
      movedFindings: 0,
      findingsAlreadyTagged: 0,
      repointedActivities: 0,
      rewrittenTimelineSections: 0,
    });
    // The survivor comes back with refreshed counts: all three items now.
    expect(res.json().tag).toMatchObject({
      id: t2.id,
      name: 't2',
      evidenceCount: 3,
      usageCount: 3,
    });

    expect(await tagNames(cookie)).toEqual(['t2']);
    expect(await evidenceTagNames(cookie, a.uuid)).toEqual(['t2']);
    expect(await evidenceTagNames(cookie, b.uuid)).toEqual(['t2']);
    expect(await evidenceTagNames(cookie, c.uuid)).toEqual(['t2']);
    // No stray join rows survived the source's deletion.
    expect(await app.db.evidenceTag.count({ where: { tagId: t1.id } })).toBe(0);
  });

  it('moves finding tags the same way, skipping a finding that already carries both', async () => {
    const { cookie, users, eng } = await setup();
    const t1 = await createTag(cookie, 't1');
    const t2 = await createTag(cookie, 't2');
    const a = await createFindingWith(eng.id, 'A', [t1.id]);
    const b = await createFindingWith(eng.id, 'B', [t1.id, t2.id]);
    const c = await createFindingWith(eng.id, 'C', [t2.id]);
    // One piece of evidence on the source too, so the two tallies are visibly
    // separate rather than one being a copy of the other.
    const ev = await createEvidence(eng.id, users.writer.id, 'E', [t1.id]);

    const res = await post(`/web/engagements/op1/tags/${t1.id}/merge`, cookie, {
      intoTagId: t2.id,
    });
    expect(res.statusCode).toBe(200);
    // A re-point (`updateMany`) instead of a copy would violate the composite key
    // on B and abort the whole merge.
    expect(res.json()).toMatchObject({
      movedEvidence: 1,
      evidenceAlreadyTagged: 0,
      movedFindings: 1,
      findingsAlreadyTagged: 1,
      repointedActivities: 0,
      rewrittenTimelineSections: 0,
    });
    expect(res.json().tag).toMatchObject({
      id: t2.id,
      evidenceCount: 1,
      findingCount: 3,
      usageCount: 4,
    });

    expect(await tagNames(cookie)).toEqual(['t2']);
    // Every finding ends with exactly one chip: the survivor, once.
    expect(await findingTagNames(cookie, a.uuid)).toEqual(['t2']);
    expect(await findingTagNames(cookie, b.uuid)).toEqual(['t2']);
    expect(await findingTagNames(cookie, c.uuid)).toEqual(['t2']);
    expect(await evidenceTagNames(cookie, ev.uuid)).toEqual(['t2']);
    expect(await app.db.findingTag.count({ where: { tagId: t1.id } })).toBe(0);
    expect(await app.db.findingTag.count()).toBe(3);
  });

  it("re-points an activity's correlation tag at the survivor instead of nulling it", async () => {
    const { cookie } = await setup();
    const activity = await createActivity(cookie, 'Recon');
    expect(activity.tagId).toBeTypeOf('number');
    const other = await createTag(cookie, 'other');

    const res = await post(`/web/engagements/op1/tags/${activity.tagId}/merge`, cookie, {
      intoTagId: other.id,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repointedActivities).toBe(1);
    expect(res.json().tag.activityNames).toEqual(['Recon']);

    const row = await app.db.targetActivity.findUniqueOrThrow({ where: { id: activity.id } });
    expect(row.tagId).toBe(other.id);
    expect(await tagNames(cookie)).toEqual(['other']);
  });

  it('rewrites and dedups the timeline config, leaving a narrative subsection alone', async () => {
    const { cookie, eng } = await setup();
    const alpha = await createTag(cookie, 'alpha');
    const beta = await createTag(cookie, 'beta');
    const prose = { kind: 'narrative', title: 'alpha', body: 'alpha and beta prose', evidence: [] };
    await setNarrative(eng.id, [
      prose,
      timelineSection('Only alpha', ['alpha']),
      timelineSection('Both', ['alpha', 'beta']),
      timelineSection('Unrelated', ['gamma']),
    ]);

    const res = await post(`/web/engagements/op1/tags/${alpha.id}/merge`, cookie, {
      intoTagId: beta.id,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rewrittenTimelineSections).toBe(2);

    const narrative = await readNarrative(eng.id);
    expect(narrative).toHaveLength(4);
    expect(narrative[0]).toEqual(prose);
    expect(narrative[1].timeline.tags).toEqual(['beta']);
    expect(narrative[2].timeline.tags).toEqual(['beta']);
    expect(narrative[3].timeline.tags).toEqual(['gamma']);
  });

  it('refuses a self-merge and a cross-engagement target before writing anything', async () => {
    const { cookie, users, eng } = await setup();
    const op2 = await setupSecond(users.writer.id);
    const alpha = await createTag(cookie, 'alpha');
    const foreign = await createTag(cookie, 'foreign', 'red', 'op2');
    await createEvidence(eng.id, users.writer.id, 'A', [alpha.id]);

    const self = await post(`/web/engagements/op1/tags/${alpha.id}/merge`, cookie, {
      intoTagId: alpha.id,
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().error).toBe('A tag cannot be merged into itself');

    const cross = await post(`/web/engagements/op1/tags/${alpha.id}/merge`, cookie, {
      intoTagId: foreign.id,
    });
    expect(cross.statusCode).toBe(404);

    const missing = await post(`/web/engagements/op1/tags/${alpha.id}/merge`, cookie, {
      intoTagId: 999_999,
    });
    expect(missing.statusCode).toBe(404);

    // Source still exists, still applied, and nothing leaked into op2.
    const [row] = await listTags(cookie);
    expect(row).toMatchObject({ id: alpha.id, name: 'alpha', evidenceCount: 1 });
    expect(await app.db.evidenceTag.count({ where: { tagId: foreign.id } })).toBe(0);
    expect(await tagNames(cookie, 'op2')).toEqual(['foreign']);
    expect(op2.id).not.toBe(eng.id);
  });
});

describe('unapply', () => {
  it('strips every application, keeps the tag, and leaves the activity correlation alone', async () => {
    const { cookie, users, eng } = await setup();
    const activity = await createActivity(cookie, 'Recon');
    const tagId = activity.tagId!;
    const a = await createEvidence(eng.id, users.writer.id, 'A', [tagId]);
    const b = await createEvidence(eng.id, users.writer.id, 'B', [tagId]);
    const other = await createTag(cookie, 'other');
    const c = await createEvidence(eng.id, users.writer.id, 'C', [other.id, tagId]);

    const res = await post(`/web/engagements/op1/tags/${tagId}/unapply`, cookie, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ evidenceCleared: 3, findingsCleared: 0 });

    const rows = await listTags(cookie);
    expect(rows.find((r) => r.id === tagId)).toMatchObject({
      name: 'Recon',
      evidenceCount: 0,
      usageCount: 0,
      activityNames: ['Recon'],
    });
    expect(await evidenceTagNames(cookie, a.uuid)).toEqual([]);
    expect(await evidenceTagNames(cookie, b.uuid)).toEqual([]);
    // Another tag on the same item is untouched.
    expect(await evidenceTagNames(cookie, c.uuid)).toEqual(['other']);

    const row = await app.db.targetActivity.findUniqueOrThrow({ where: { id: activity.id } });
    expect(row.tagId).toBe(tagId);
  });

  it('strips the tag from findings too, reporting them separately', async () => {
    const { cookie, users, eng } = await setup();
    const t = await createTag(cookie, 'alpha');
    const other = await createTag(cookie, 'other');
    const f1 = await createFindingWith(eng.id, 'F1', [t.id]);
    const f2 = await createFindingWith(eng.id, 'F2', [other.id, t.id]);
    const untouched = await createFindingWith(eng.id, 'F3', [other.id]);
    await createEvidence(eng.id, users.writer.id, 'E', [t.id]);

    const res = await post(`/web/engagements/op1/tags/${t.id}/unapply`, cookie, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ evidenceCleared: 1, findingsCleared: 2 });

    // The tag survives with nothing applied…
    expect((await listTags(cookie)).find((r) => r.id === t.id)).toMatchObject({
      name: 'alpha',
      evidenceCount: 0,
      findingCount: 0,
      usageCount: 0,
    });
    // …each finding comes back untagged, and another tag on the same finding is
    // left alone.
    expect(await findingTagNames(cookie, f1.uuid)).toEqual([]);
    expect(await findingTagNames(cookie, f2.uuid)).toEqual(['other']);
    expect(await findingTagNames(cookie, untouched.uuid)).toEqual(['other']);
    expect(await app.db.findingTag.count({ where: { tagId: t.id } })).toBe(0);
  });
});

describe('delete', () => {
  it('removes the tag, its chips, and nulls the activity correlation', async () => {
    const { cookie, users, eng } = await setup();
    const activity = await createActivity(cookie, 'Recon');
    const tagId = activity.tagId!;
    const a = await createEvidence(eng.id, users.writer.id, 'A', [tagId]);

    const res = await del(`/web/engagements/op1/tags/${tagId}`, cookie);
    expect(res.statusCode).toBe(200);

    expect(await tagNames(cookie)).toEqual([]);
    expect(await evidenceTagNames(cookie, a.uuid)).toEqual([]);
    const row = await app.db.targetActivity.findUniqueOrThrow({ where: { id: activity.id } });
    expect(row.tagId).toBeNull();
  });

  it('cascades off a finding instead of blocking the delete', async () => {
    const { cookie, eng } = await setup();
    const t = await createTag(cookie, 'alpha');
    const other = await createTag(cookie, 'other');
    const f = await createFindingWith(eng.id, 'F', [t.id, other.id]);

    // Without ON DELETE CASCADE on the join's tag_id, this would be the 500 every
    // tag deletion hit the moment a finding used the tag.
    const res = await del(`/web/engagements/op1/tags/${t.id}`, cookie);
    expect(res.statusCode).toBe(200);

    expect(await tagNames(cookie)).toEqual(['other']);
    // The finding itself survives, minus the one chip.
    expect(await findingTagNames(cookie, f.uuid)).toEqual(['other']);
    expect(await app.db.findingTag.count({ where: { tagId: t.id } })).toBe(0);
    expect(await app.db.findingTag.count({ where: { findingId: f.id } })).toBe(1);
  });

  it("drops the tag's name from the report timeline config and leaves everything else alone", async () => {
    const { cookie, eng } = await setup();
    const alpha = await createTag(cookie, 'alpha');
    await createTag(cookie, 'beta');
    const query = (
      await post('/web/engagements/op1/queries', cookie, {
        name: 'Alpha',
        query: 'tag:alpha',
        type: 'evidence',
      })
    ).json();
    const prose = { kind: 'narrative', title: 'Intro', body: 'alpha prose', evidence: [] };
    await setNarrative(eng.id, [
      timelineSection('Both', ['alpha', 'beta']),
      timelineSection('Only alpha', ['alpha']),
      prose,
    ]);

    const res = await del(`/web/engagements/op1/tags/${alpha.id}`, cookie);
    expect(res.statusCode).toBe(200);

    // A section filtered on alpha AND beta keeps beta, rather than being left
    // naming a tag that no longer exists and silently matching nothing. A section
    // filtered on alpha alone keeps its array — now empty, which the report reads
    // as "no tag filter" — rather than losing the key or the section itself.
    const narrative = await readNarrative(eng.id);
    expect(narrative).toHaveLength(3);
    expect(narrative[0].title).toBe('Both');
    expect(narrative[0].timeline.tags).toEqual(['beta']);
    expect(narrative[1].title).toBe('Only alpha');
    expect(narrative[1].timeline.tags).toEqual([]);
    expect(narrative[2]).toEqual(prose);

    // Saved queries are reported, never rewritten — the same asymmetry rename
    // and merge keep.
    const saved = await app.db.savedQuery.findUniqueOrThrow({ where: { id: query.id } });
    expect(saved.query).toBe('tag:alpha');
    expect(await tagNames(cookie)).toEqual(['beta']);
  });
});

describe('reorder', () => {
  it('applies a full ordered list and rejects partial, duplicate, foreign and empty lists', async () => {
    const { cookie, users } = await setup();
    await setupSecond(users.writer.id);
    const a = await createTag(cookie, 'a');
    const b = await createTag(cookie, 'b');
    const c = await createTag(cookie, 'c');
    const foreign = await createTag(cookie, 'foreign', 'red', 'op2');

    const ok = await patch('/web/engagements/op1/tags/reorder', cookie, {
      orderedIds: [c.id, a.id, b.id],
    });
    expect(ok.statusCode).toBe(200);
    expect(await tagNames(cookie)).toEqual(['c', 'a', 'b']);

    const bad = [
      { label: 'partial', orderedIds: [c.id, a.id] },
      { label: 'duplicate', orderedIds: [c.id, c.id, a.id] },
      { label: 'foreign', orderedIds: [c.id, a.id, foreign.id] },
      { label: 'superset', orderedIds: [c.id, a.id, b.id, foreign.id] },
      { label: 'empty', orderedIds: [] },
    ];
    for (const { label, orderedIds } of bad) {
      const res = await patch('/web/engagements/op1/tags/reorder', cookie, { orderedIds });
      expect(res.statusCode, label).toBe(400);
      expect(await tagNames(cookie), label).toEqual(['c', 'a', 'b']);
    }
    // op2's own order is untouched by any of that.
    expect(await tagNames(cookie, 'op2')).toEqual(['foreign']);
  });

  it('"pin to top" is a reorder, and a new tag still lands at the end', async () => {
    const { cookie } = await setup();
    const a = await createTag(cookie, 'a');
    const b = await createTag(cookie, 'b');
    const c = await createTag(cookie, 'c');

    const pin = await patch('/web/engagements/op1/tags/reorder', cookie, {
      orderedIds: [c.id, a.id, b.id],
    });
    expect(pin.statusCode).toBe(200);
    await createTag(cookie, 'd');
    expect(await tagNames(cookie)).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('references', () => {
  it('lists only parsed tag: terms and timeline subsections naming the tag', async () => {
    const { cookie, eng } = await setup();
    const alpha = await createTag(cookie, 'alpha');
    const hit = (
      await post('/web/engagements/op1/queries', cookie, {
        name: 'Alpha starred',
        query: 'tag:alpha starred',
        type: 'evidence',
      })
    ).json();
    await post('/web/engagements/op1/queries', cookie, {
      name: 'Free text',
      query: 'alpha stuff',
      type: 'evidence',
    });
    await post('/web/engagements/op1/queries', cookie, {
      name: 'Beta',
      query: 'tag:beta',
      type: 'evidence',
    });
    await setNarrative(eng.id, [
      { kind: 'narrative', title: 'alpha', body: 'mentions alpha', evidence: [] },
      timelineSection('Alpha timeline', ['alpha']),
      timelineSection('Beta timeline', ['beta']),
      timelineSection('Both', ['beta', 'alpha']),
    ]);

    const res = await get(`/web/engagements/op1/tags/${alpha.id}/references`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      savedQueries: [{ id: hit.id, name: 'Alpha starred', type: 'evidence' }],
      timelineSections: [
        { index: 1, title: 'Alpha timeline' },
        { index: 3, title: 'Both' },
      ],
    });
  });

  it('is empty for a tag nothing names', async () => {
    const { cookie } = await setup();
    const t = await createTag(cookie, 'lonely');
    const res = await get(`/web/engagements/op1/tags/${t.id}/references`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ savedQueries: [], timelineSections: [] });
  });
});

describe('export and import', () => {
  it('export writes tags in curated order and import restores it', async () => {
    const { cookie } = await setup();
    const zulu = await createTag(cookie, 'zulu', 'red');
    const alpha = await createTag(cookie, 'alpha', 'green');
    const mike = await createTag(cookie, 'mike', 'blue');
    const reorder = await patch('/web/engagements/op1/tags/reorder', cookie, {
      orderedIds: [mike.id, zulu.id, alpha.id],
    });
    expect(reorder.statusCode).toBe(200);

    // Export needs the engagement `admin` role and import needs site admin; the
    // site admin satisfies both.
    const admin = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(admin);
    const res = await importArchive(admin, archive, { slug: 'op1-copy' });
    expect(res.statusCode).toBe(200);
    expect(res.json().engagement.slug).toBe('op1-copy');

    // The file carries no `position` field — the array order IS the order — so
    // an exporter writing alphabetically would restore [alpha, mike, zulu] here,
    // and an importer ignoring the index would read that way via the name
    // tiebreak. Colors travel with the names.
    expect(await listTags(admin, 'op1-copy')).toMatchObject([
      { name: 'mike', colorName: 'blue' },
      { name: 'zulu', colorName: 'red' },
      { name: 'alpha', colorName: 'green' },
    ]);
    // Stored positions are the array indexes, dense from 0, not all-zero rows
    // that happen to read right.
    const copy = await app.db.engagement.findUniqueOrThrow({ where: { slug: 'op1-copy' } });
    const rows = await app.db.tag.findMany({
      where: { engagementId: copy.id },
      orderBy: { position: 'asc' },
      select: { name: true, position: true },
    });
    expect(rows).toEqual([
      { name: 'mike', position: 0 },
      { name: 'zulu', position: 1 },
      { name: 'alpha', position: 2 },
    ]);
    // The source is as it was.
    expect(await tagNames(cookie)).toEqual(['mike', 'zulu', 'alpha']);
  });
});

describe('cross-engagement isolation', () => {
  it('every :id route 404s for a tag that belongs to another engagement', async () => {
    const { cookie, users } = await setup();
    await setupSecond(users.writer.id);
    const mine = await createTag(cookie, 'mine');
    const theirs = await createTag(cookie, 'theirs', 'red', 'op2');

    const base = `/web/engagements/op1/tags/${theirs.id}`;
    expect((await put(base, cookie, { name: 'renamed' })).statusCode).toBe(404);
    expect((await del(base, cookie)).statusCode).toBe(404);
    expect((await post(`${base}/merge`, cookie, { intoTagId: mine.id })).statusCode).toBe(404);
    expect((await post(`${base}/unapply`, cookie, {})).statusCode).toBe(404);
    expect((await get(`${base}/references`, cookie)).statusCode).toBe(404);

    // The foreign tag is exactly as it was, and op1 only ever sees its own.
    expect(await listTags(cookie, 'op2')).toMatchObject([{ id: theirs.id, name: 'theirs' }]);
    expect(await tagNames(cookie)).toEqual(['mine']);
  });
});

describe('role gating', () => {
  it('a read member can list and read references but not mutate; a writer can do all of it', async () => {
    const { cookie: writer } = await setup();
    const reader = await loginCookie(app, 'reader@test.local', 'password123');
    const a = await createTag(writer, 'a');
    const b = await createTag(writer, 'b');

    expect((await get('/web/engagements/op1/tags', reader)).statusCode).toBe(200);
    expect((await get(`/web/engagements/op1/tags/${a.id}/references`, reader)).statusCode).toBe(
      200,
    );

    const denied = [
      post('/web/engagements/op1/tags', reader, { name: 'c', colorName: 'blue' }),
      put(`/web/engagements/op1/tags/${a.id}`, reader, { name: 'renamed' }),
      del(`/web/engagements/op1/tags/${a.id}`, reader),
      post(`/web/engagements/op1/tags/${a.id}/merge`, reader, { intoTagId: b.id }),
      post(`/web/engagements/op1/tags/${a.id}/unapply`, reader, {}),
      patch('/web/engagements/op1/tags/reorder', reader, { orderedIds: [b.id, a.id] }),
    ];
    for (const res of await Promise.all(denied)) expect(res.statusCode).toBe(403);
    // Nothing the reader sent took effect.
    expect(await tagNames(writer)).toEqual(['a', 'b']);

    expect((await get('/web/engagements/op1/tags', writer)).statusCode).toBe(200);
    expect((await get(`/web/engagements/op1/tags/${a.id}/references`, writer)).statusCode).toBe(
      200,
    );
    expect(
      (await patch('/web/engagements/op1/tags/reorder', writer, { orderedIds: [b.id, a.id] }))
        .statusCode,
    ).toBe(200);
    expect(
      (await put(`/web/engagements/op1/tags/${a.id}`, writer, { name: 'renamed' })).statusCode,
    ).toBe(200);
    expect((await post(`/web/engagements/op1/tags/${a.id}/unapply`, writer, {})).statusCode).toBe(
      200,
    );
    expect(
      (await post(`/web/engagements/op1/tags/${a.id}/merge`, writer, { intoTagId: b.id }))
        .statusCode,
    ).toBe(200);
    expect(
      (await post('/web/engagements/op1/tags', writer, { name: 'c', colorName: 'blue' }))
        .statusCode,
    ).toBe(201);
    expect((await del(`/web/engagements/op1/tags/${b.id}`, writer)).statusCode).toBe(200);
    expect(await tagNames(writer)).toEqual(['c']);
  });

  it('a mutation without the CSRF header is rejected even for a writer', async () => {
    const { cookie } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/web/engagements/op1/tags',
      headers: { cookie },
      payload: { name: 'x', colorName: 'blue' },
    });
    expect(res.statusCode).toBe(403);
    expect(await tagNames(cookie)).toEqual([]);

    // PATCH is a mutation too, and reorder is the one PATCH on this plane. It
    // must get exactly the answer the POST did — a guard that only lists
    // POST/PUT/DELETE would wave it through.
    const a = await createTag(cookie, 'a');
    const b = await createTag(cookie, 'b');
    const reorder = await app.inject({
      method: 'PATCH',
      url: '/web/engagements/op1/tags/reorder',
      headers: { cookie },
      payload: { orderedIds: [b.id, a.id] },
    });
    expect(reorder.statusCode).toBe(res.statusCode);
    expect(await tagNames(cookie)).toEqual(['a', 'b']);
  });
});

describe('HMAC client API', () => {
  function signed(
    method: string,
    path: string,
    key: { accessKey: string; secretKey: string },
    body?: unknown,
  ) {
    const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers = buildAuthHeaders(method, path, raw, key.accessKey, key.secretKey);
    return app.inject({
      method: method as 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE',
      url: path,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      payload: body === undefined ? undefined : raw,
    });
  }

  it('lists {id,name,colorName} in the same curated order as /web, and exposes no new verbs', async () => {
    const { cookie, users } = await setup();
    const zulu = await createTag(cookie, 'zulu', 'red');
    const alpha = await createTag(cookie, 'alpha', 'green');
    const mike = await createTag(cookie, 'mike', 'blue');
    // Curate the order on the web side; the client plane must follow it.
    await patch('/web/engagements/op1/tags/reorder', cookie, {
      orderedIds: [mike.id, zulu.id, alpha.id],
    });
    const key = await apiKeyFor(app, users.writer.id);

    const list = await signed('GET', '/api/engagements/op1/tags', key);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      { id: mike.id, name: 'mike', colorName: 'blue' },
      { id: zulu.id, name: 'zulu', colorName: 'red' },
      { id: alpha.id, name: 'alpha', colorName: 'green' },
    ]);
    // Field-for-field unchanged: no counts, no activity names, no position.
    for (const t of list.json()) expect(Object.keys(t).sort()).toEqual(['colorName', 'id', 'name']);
    expect(await tagNames(cookie)).toEqual(['mike', 'zulu', 'alpha']);

    // None of the five management verbs exists on the client plane. Each is a
    // plain 404 — the answer any unknown path gets — with a correctly signed
    // request, so what is being probed is the route table, not the signature.
    const verbs: [method: string, path: string, body?: unknown][] = [
      ['PUT', `/api/engagements/op1/tags/${zulu.id}`, { name: 'x' }],
      ['DELETE', `/api/engagements/op1/tags/${zulu.id}`],
      ['PATCH', '/api/engagements/op1/tags/reorder', { orderedIds: [alpha.id, zulu.id, mike.id] }],
      ['POST', `/api/engagements/op1/tags/${zulu.id}/merge`, { intoTagId: alpha.id }],
      ['POST', `/api/engagements/op1/tags/${zulu.id}/unapply`, {}],
    ];
    for (const [method, path, body] of verbs) {
      const res = await signed(method, path, key, body);
      expect(res.statusCode, `${method} ${path}`).toBe(404);
    }
    // Nothing was renamed, deleted, reordered, merged or unapplied.
    expect(await tagNames(cookie)).toEqual(['mike', 'zulu', 'alpha']);
    expect(await listTags(cookie)).toMatchObject([
      { id: mike.id, name: 'mike' },
      { id: zulu.id, name: 'zulu' },
      { id: alpha.id, name: 'alpha' },
    ]);
  });
});
