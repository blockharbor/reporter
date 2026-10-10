import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Prisma, User } from '@prisma/client';
import {
  AUDIT_DELETE_REASON_MAX_CHARS,
  AUDIT_ENTRY_ALREADY_REMOVED,
  AUDIT_MAX_OFFSET,
  SYSTEM_ACTOR_LABEL,
  auditFacetsSchema,
  auditLogPageSchema,
  isoDateSchema,
  removeAuditEntryResultSchema,
  type AuditEntry,
  type AuditFacets,
  type AuditLogPage,
} from '@reporter/shared';
import { createLocalUser } from '../src/services/users.js';
import {
  WEB_HEADERS,
  buildTestApp,
  loginCookie,
  seedUsers,
  truncateAll,
  truncateAuditLog,
} from './helpers.js';

// The audit log's READ side over HTTP: the two list planes and their facets,
// the filter vocabulary against real rows, sorting and paging, and the one
// write the admin plane carries — the tamper-evident removal. Rows are seeded
// straight through `app.db.auditEntry.create`, so every case states exactly
// what is in the log and the suite does not depend on the writers; two cases
// go through a real request to prove the request path lands in the list.
//
// Every fixture write (users, engagements, and each login's sign_in entry) is
// itself recorded, so `setup()` truncates the log AFTER the fixture and each
// case starts from an empty table. Where a case must delete a user or an
// engagement mid-way — the referential actions are the point of those cases —
// the backstop's own system rows are tolerated and assertions key on uuids.

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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const ENG = '/web/engagements/op1/audit-log';
const SITE = '/web/admin/audit-log';
const PASSWORD = 'password123';

interface Eng {
  id: number;
  slug: string;
  name: string;
}

interface Fixture {
  users: { admin: User; writer: User; reader: User; engAdmin: User; outsider: User };
  op1: Eng;
  op2: Eng;
  cookies: Record<'admin' | 'writer' | 'reader' | 'engAdmin' | 'outsider', string>;
}

/**
 * Three engagement roles on op1 (write, read, admin) plus a site admin who is a
 * member of nothing and a user who is a member of nothing at all. Every session
 * is opened here, before the log is cleared, so no case has to account for the
 * sign_in entries a login records.
 */
async function setup(): Promise<Fixture> {
  const base = await seedUsers(app);
  const engAdmin = await createLocalUser(app.db, {
    firstName: 'Eve',
    lastName: 'Engadmin',
    email: 'engadmin@test.local',
    password: PASSWORD,
  });
  const outsider = await createLocalUser(app.db, {
    firstName: 'Nora',
    lastName: 'Outsider',
    email: 'outsider@test.local',
    password: PASSWORD,
  });
  const op1 = await app.db.engagement.create({
    data: {
      slug: 'op1',
      name: 'Op One',
      roles: {
        create: [
          { userId: base.writer.id, role: 'write' },
          { userId: base.reader.id, role: 'read' },
          { userId: engAdmin.id, role: 'admin' },
        ],
      },
    },
  });
  const op2 = await app.db.engagement.create({
    data: {
      slug: 'op2',
      name: 'Op Two',
      roles: { create: [{ userId: base.writer.id, role: 'write' }] },
    },
  });
  const cookies = {
    admin: await loginCookie(app, base.admin.email, PASSWORD),
    writer: await loginCookie(app, base.writer.email, PASSWORD),
    reader: await loginCookie(app, base.reader.email, PASSWORD),
    engAdmin: await loginCookie(app, engAdmin.email, PASSWORD),
    outsider: await loginCookie(app, outsider.email, PASSWORD),
  };
  await truncateAuditLog(app);
  return { users: { ...base, engAdmin, outsider }, op1, op2, cookies };
}

type RowInput = Prisma.AuditEntryUncheckedCreateInput;

/** Fixed instants, so sorting and range cases are deterministic. */
const T1 = new Date('2026-03-01T10:00:00.000Z');
const T2 = new Date('2026-03-02T10:00:00.000Z');
const T3 = new Date('2026-03-03T10:00:00.000Z');

const EVIDENCE_UUID = 'e0a1b2c3-0000-4000-8000-000000000001';

function actorOf(u: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'>) {
  return { actorId: u.id, actorName: `${u.firstName} ${u.lastName}`, actorEmail: u.email };
}
function inEng(e: Eng) {
  return { engagementId: e.id, engagementSlug: e.slug, engagementName: e.name };
}
const SYSTEM = { actorId: null, actorName: null, actorEmail: null, via: 'system' } as const;
const NO_ENG = { engagementId: null, engagementSlug: null, engagementName: null } as const;

/** A live entry about an evidence item, as the recorder would write it, with overrides. */
function row(eng: Eng, actor: User, over: Partial<RowInput> = {}): RowInput {
  const at = over.createdAt ?? T2;
  return {
    ...inEng(eng),
    ...actorOf(actor),
    via: 'session',
    action: 'update',
    entityType: 'evidence',
    entityId: EVIDENCE_UUID,
    entityLabel: 'CAN dump',
    summary: 'Edited evidence “CAN dump”: Description',
    changes: [{ kind: 'field', field: 'description', from: 'before', to: 'after' }],
    coalesceKey: 'description',
    source: 'intent',
    createdAt: at,
    lastAt: at,
    ...over,
  };
}

/** Insert in order, so ids ascend with the array — the tiebreak the sorts rely on. */
async function seed(rows: RowInput[]) {
  const out = [];
  for (const data of rows) out.push(await app.db.auditEntry.create({ data }));
  return out;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function get(url: string, cookie?: string) {
  return app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
}

function remove(uuid: string, cookie: string | undefined, payload: unknown, csrf = true) {
  return app.inject({
    method: 'POST',
    url: `${SITE}/${uuid}/remove`,
    headers: { ...(csrf ? WEB_HEADERS : {}), ...(cookie ? { cookie } : {}) },
    payload,
  });
}

/** GET a list route, assert 200, and parse the envelope through the shared schema. */
async function list(url: string, cookie: string): Promise<AuditLogPage> {
  const res = await get(url, cookie);
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return auditLogPageSchema.parse(res.json());
}

async function facets(url: string, cookie: string): Promise<AuditFacets> {
  const res = await get(url, cookie);
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return auditFacetsSchema.parse(res.json());
}

const uuids = (page: AuditLogPage): string[] => page.items.map((i) => i.uuid);
const sorted = (xs: string[]): string[] => [...xs].sort();

/** Walk every page of a query at `pageSize` and return the items in order. */
async function walk(url: string, cookie: string, pageSize: number): Promise<AuditEntry[]> {
  const sep = url.includes('?') ? '&' : '?';
  const items: AuditEntry[] = [];
  const first = await list(`${url}${sep}pageSize=${pageSize}&page=1`, cookie);
  items.push(...first.items);
  const pages = Math.ceil(first.total / pageSize);
  for (let p = 2; p <= pages; p++) {
    const page = await list(`${url}${sep}pageSize=${pageSize}&page=${p}`, cookie);
    expect(page.total).toBe(first.total);
    expect(page.page).toBe(p);
    items.push(...page.items);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe('access', () => {
  it('opens the engagement list and facets to write and admin members and to a site admin, and refuses read members and non-members', async () => {
    const { users, op1, cookies } = await setup();
    await seed([row(op1, users.writer)]);

    for (const url of [ENG, `${ENG}/facets`]) {
      expect((await get(url, cookies.writer)).statusCode, `writer ${url}`).toBe(200);
      expect((await get(url, cookies.engAdmin)).statusCode, `engagement admin ${url}`).toBe(200);
      // Ada is a site admin and a member of nothing: the guard's bypass.
      expect((await get(url, cookies.admin)).statusCode, `site admin ${url}`).toBe(200);
      expect((await get(url, cookies.reader)).statusCode, `read member ${url}`).toBe(403);
      expect((await get(url, cookies.outsider)).statusCode, `non-member ${url}`).toBe(403);
      expect((await get(url)).statusCode, `anonymous ${url}`).toBe(401);
    }
    expect((await get('/web/engagements/nope/audit-log', cookies.admin)).statusCode).toBe(404);
    expect((await get('/web/engagements/nope/audit-log/facets', cookies.writer)).statusCode).toBe(
      404,
    );
  });

  it('keeps the site list, its facets and the removal route to site admins', async () => {
    const { users, op1, cookies } = await setup();
    const [target] = await seed([row(op1, users.writer)]);

    for (const url of [SITE, `${SITE}/facets`]) {
      expect((await get(url, cookies.admin)).statusCode, `admin ${url}`).toBe(200);
      expect((await get(url, cookies.writer)).statusCode, `writer ${url}`).toBe(403);
      expect((await get(url, cookies.engAdmin)).statusCode, `engagement admin ${url}`).toBe(403);
      expect((await get(url)).statusCode, `anonymous ${url}`).toBe(401);
    }
    const reason = { reason: 'test' };
    expect((await remove(target!.uuid, cookies.writer, reason)).statusCode).toBe(403);
    expect((await remove(target!.uuid, cookies.engAdmin, reason)).statusCode).toBe(403);
    expect((await remove(target!.uuid, undefined, reason)).statusCode).toBe(401);
    // The web plane's CSRF guard runs before the handler, even for an admin.
    expect((await remove(target!.uuid, cookies.admin, reason, false)).statusCode).toBe(403);

    // None of those refusals touched the row.
    const after = await app.db.auditEntry.findUniqueOrThrow({ where: { id: target!.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.summary).toBe(target!.summary);
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe('scope', () => {
  it('returns only that engagement’s rows from the engagement list, whatever the querystring says', async () => {
    const { users, op1, op2, cookies } = await setup();
    const [a1, a2, b1, site, gone] = await seed([
      row(op1, users.writer, { createdAt: T1 }),
      row(op1, users.admin, { createdAt: T2 }),
      row(op2, users.writer),
      row(op1, users.writer, { ...NO_ENG, action: 'sign_in', entityType: 'user' }),
      row(op1, users.writer, {
        engagementId: null,
        engagementSlug: 'gone',
        engagementName: 'Gone',
      }),
    ]);

    const plain = await list(ENG, cookies.writer);
    expect(plain.total).toBe(2);
    expect(sorted(uuids(plain))).toEqual(sorted([a1!.uuid, a2!.uuid]));
    for (const item of plain.items) {
      expect(item.engagement).toEqual({ slug: 'op1', name: 'Op One', deleted: false });
    }

    // The site-only filters are parsed and then ignored: no 400, no wider view.
    for (const qs of ['?eng=op2', '?eng=gone', '?noEng=1', '?eng=op2&noEng=true', '?eng=op1']) {
      const page = await list(`${ENG}${qs}`, cookies.writer);
      expect(sorted(uuids(page)), qs).toEqual(sorted([a1!.uuid, a2!.uuid]));
      expect(page.total, qs).toBe(2);
    }
    expect(uuids(plain)).not.toContain(b1!.uuid);
    expect(uuids(plain)).not.toContain(site!.uuid);
    expect(uuids(plain)).not.toContain(gone!.uuid);

    // op2 through the same writer is the other scope, nothing shared.
    const other = await list('/web/engagements/op2/audit-log', cookies.writer);
    expect(uuids(other)).toEqual([b1!.uuid]);
  });

  it('lists rows with no engagement and rows whose engagement is gone on the site list, flagging the latter deleted', async () => {
    const { users, op1, cookies } = await setup();
    const [live, site, gone] = await seed([
      row(op1, users.writer),
      row(op1, users.writer, { ...NO_ENG, action: 'sign_in', entityType: 'user' }),
      row(op1, users.writer, {
        engagementId: null,
        engagementSlug: 'gone',
        engagementName: 'Gone',
      }),
    ]);

    const page = await list(SITE, cookies.admin);
    expect(page.total).toBe(3);
    const byUuid = new Map(page.items.map((i) => [i.uuid, i]));
    expect(byUuid.get(live!.uuid)!.engagement).toEqual({
      slug: 'op1',
      name: 'Op One',
      deleted: false,
    });
    expect(byUuid.get(site!.uuid)!.engagement).toBeNull();
    expect(byUuid.get(gone!.uuid)!.engagement).toEqual({
      slug: 'gone',
      name: 'Gone',
      deleted: true,
    });

    // ?noEng=1 is only the site-wide rows: not the live one, not the dead one.
    const siteOnly = await list(`${SITE}?noEng=1`, cookies.admin);
    expect(uuids(siteOnly)).toEqual([site!.uuid]);
    // …and `0` is the flag off.
    expect((await list(`${SITE}?noEng=0`, cookies.admin)).total).toBe(3);
  });

  it('matches ?eng= by FK for a live engagement and by snapshot for a deleted one, so a reused slug returns both and the dead row never links', async () => {
    const { users, cookies } = await setup();

    // Engagement x, a row about it, then the engagement is deleted: the FK goes
    // to NULL through ON DELETE SET NULL and only the slug snapshot remains.
    const first = await app.db.engagement.create({ data: { slug: 'x', name: 'X the first' } });
    const [dead] = await seed([row(first, users.writer, { createdAt: T1 })]);
    await app.db.engagement.delete({ where: { id: first.id } });
    const nulled = await app.db.auditEntry.findUniqueOrThrow({ where: { id: dead!.id } });
    expect(nulled.engagementId).toBeNull();
    expect(nulled.engagementSlug).toBe('x');

    // A new engagement inherits the freed slug, and a row is written about it.
    const second = await app.db.engagement.create({ data: { slug: 'x', name: 'X the second' } });
    const [alive] = await seed([row(second, users.writer, { createdAt: T3 })]);

    const page = await list(`${SITE}?eng=x`, cookies.admin);
    const got = new Map(page.items.map((i) => [i.uuid, i]));
    expect(got.has(dead!.uuid)).toBe(true);
    expect(got.has(alive!.uuid)).toBe(true);
    // Every match — including the backstop's own rows for the delete and the
    // create above — is about slug x, and only the ones with a live FK link.
    for (const item of page.items) expect(item.engagement?.slug).toBe('x');
    expect(got.get(dead!.uuid)!.engagement).toEqual({
      slug: 'x',
      name: 'X the first',
      deleted: true,
    });
    expect(got.get(alive!.uuid)!.engagement).toEqual({
      slug: 'x',
      name: 'X the second',
      deleted: false,
    });
    // The dead row is not reachable through the new engagement's own tab.
    const tab = await list('/web/engagements/x/audit-log', cookies.admin);
    expect(uuids(tab)).toContain(alive!.uuid);
    expect(uuids(tab)).not.toContain(dead!.uuid);

    // A slug nothing ever had matches nothing rather than failing.
    expect((await list(`${SITE}?eng=never`, cookies.admin)).total).toBe(0);
    // The site facet offers x once, as the live engagement.
    const f = await facets(`${SITE}/facets`, cookies.admin);
    expect(f.engagements!.filter((e) => e.slug === 'x')).toEqual([
      { slug: 'x', name: 'X the second', deleted: false },
    ]);
  });

  it('lands a real sign-in in the site list as a site-wide session row, and in no engagement list', async () => {
    const { users, op1, cookies } = await setup();
    await seed([row(op1, users.writer)]);

    await loginCookie(app, users.writer.email, PASSWORD);

    const page = await list(`${SITE}?action=sign_in`, cookies.admin);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      engagement: null,
      actor: {
        name: 'Wendy Writer',
        email: users.writer.email,
        slug: users.writer.slug,
        currentName: null,
      },
      via: 'session',
      action: 'sign_in',
      entityType: 'user',
      entityId: users.writer.slug,
      summary: 'Signed in',
      source: 'intent',
      deleted: null,
    });
    expect((await list(`${SITE}?noEng=1`, cookies.admin)).items[0]!.uuid).toBe(page.items[0]!.uuid);
    expect((await list(`${ENG}?action=sign_in`, cookies.writer)).total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

describe('facets', () => {
  it('gives an engagement writer no engagements key and only the actors who acted in that engagement', async () => {
    const { users, op1, op2, cookies } = await setup();
    await seed([
      row(op1, users.writer),
      row(op1, users.writer, { action: 'create' }),
      row(op2, users.engAdmin, { action: 'delete', entityType: 'finding' }),
      row(op2, users.reader, { ...SYSTEM, entityType: 'tag' }),
      row(op1, users.writer, { ...NO_ENG, action: 'sign_in', entityType: 'user' }),
    ]);

    const res = await get(`${ENG}/facets`, cookies.writer);
    expect(res.statusCode).toBe(200);
    const raw = res.json() as Record<string, unknown>;
    expect(raw).not.toHaveProperty('engagements');
    const f = auditFacetsSchema.parse(raw);
    expect(f.actors).toEqual([
      {
        value: users.writer.slug,
        label: 'Wendy Writer',
        email: users.writer.email,
        deleted: false,
      },
    ]);
    expect(f.actions).toEqual(['create', 'update']);
    expect(f.entityTypes).toEqual(['evidence']);
    // The site admin's view of the same tab is the same scope, not the site.
    const viaAdmin = await get(`${ENG}/facets`, cookies.admin);
    expect(viaAdmin.json()).not.toHaveProperty('engagements');
    expect(auditFacetsSchema.parse(viaAdmin.json()).actors.map((a) => a.value)).toEqual([
      users.writer.slug,
    ]);
  });

  it('lists live and deleted engagements for a site admin, in the enum’s order for actions and types', async () => {
    const { users, op1, cookies } = await setup();
    await seed([
      row(op1, users.writer, { action: 'update' }),
      row(op1, users.writer, { action: 'create', entityType: 'target' }),
      row(op1, users.writer, {
        engagementId: null,
        engagementSlug: 'gone',
        engagementName: 'Gone Op',
        action: 'delete',
        entityType: 'engagement',
      }),
      row(op1, users.writer, { ...NO_ENG, action: 'sign_in', entityType: 'user' }),
    ]);

    const f = await facets(`${SITE}/facets`, cookies.admin);
    expect(f.engagements).toEqual([
      { slug: 'op1', name: 'Op One', deleted: false },
      { slug: 'op2', name: 'Op Two', deleted: false },
      { slug: 'gone', name: 'Gone Op', deleted: true },
    ]);
    expect(f.actions).toEqual(['create', 'update', 'delete', 'sign_in']);
    expect(f.entityTypes).toEqual(['engagement', 'target', 'evidence', 'user']);
  });

  it('folds a renamed user into one option under the live name while the rows keep their snapshots with currentName', async () => {
    const { users, op1, cookies } = await setup();
    const [old1, old2] = await seed([
      row(op1, users.writer, { createdAt: T1 }),
      row(op1, users.writer, { createdAt: T2, action: 'create' }),
    ]);
    // Renaming through the model is a backstop-recorded write; it lands in the
    // log as a system row about the user, which is fine for this case.
    const renamed = await app.db.user.update({
      where: { id: users.writer.id },
      data: { firstName: 'Wendolyn' },
    });
    const [fresh] = await seed([row(op1, renamed, { createdAt: T3, action: 'delete' })]);

    for (const url of [`${ENG}/facets`, `${SITE}/facets`]) {
      const f = await facets(url, cookies.admin);
      const wendy = f.actors.filter((a) => a.email === users.writer.email);
      expect(wendy, url).toEqual([
        {
          value: users.writer.slug,
          label: 'Wendolyn Writer',
          email: users.writer.email,
          deleted: false,
        },
      ]);
    }

    const page = await list(`${ENG}?actor=${users.writer.slug}`, cookies.admin);
    expect(page.total).toBe(3);
    const got = new Map(page.items.map((i) => [i.uuid, i]));
    for (const old of [old1!, old2!]) {
      expect(got.get(old.uuid)!.actor).toEqual({
        name: 'Wendy Writer',
        email: users.writer.email,
        slug: users.writer.slug,
        currentName: 'Wendolyn Writer',
      });
    }
    expect(got.get(fresh!.uuid)!.actor).toEqual({
      name: 'Wendolyn Writer',
      email: users.writer.email,
      slug: users.writer.slug,
      currentName: null,
    });
  });

  it('folds a hard-deleted user’s rows into one option valued by email and flagged deleted, which the email filter still finds', async () => {
    const { users, op1, cookies } = await setup();
    const dora = await createLocalUser(app.db, {
      firstName: 'Dora',
      lastName: 'Departed',
      email: 'Dora@Test.local',
      password: PASSWORD,
    });
    const [r1, r2] = await seed([
      row(op1, dora, { createdAt: T1 }),
      // The snapshot keeps whatever case the account had at the time; the fold
      // and the filter are case-insensitive.
      row(op1, dora, { createdAt: T2, actorEmail: 'dora@test.local', action: 'create' }),
      row(op1, users.writer, { createdAt: T3 }),
    ]);
    await app.db.user.delete({ where: { id: dora.id } });

    for (const url of [`${ENG}/facets`, `${SITE}/facets`]) {
      const f = await facets(url, cookies.admin);
      const gone = f.actors.filter((a) => a.deleted);
      expect(gone, url).toEqual([
        {
          value: 'dora@test.local',
          label: 'Dora Departed',
          email: 'dora@test.local',
          deleted: true,
        },
      ]);
      // Alphabetical by label; the deleted one is just another option.
      expect(f.actors.map((a) => a.label).slice(0, 2), url).toEqual([
        'Dora Departed',
        'Wendy Writer',
      ]);
    }

    for (const url of [`${ENG}?actor=DORA@TEST.LOCAL`, `${SITE}?actor=dora@test.local`]) {
      const page = await list(url, cookies.admin);
      expect(sorted(uuids(page)), url).toEqual(sorted([r1!.uuid, r2!.uuid]));
      for (const item of page.items) {
        expect(item.actor?.slug, url).toBeNull();
        expect(item.actor?.name, url).toBe('Dora Departed');
        expect(item.actor?.currentName, url).toBeNull();
      }
    }
    // The dead account's old slug resolves to nothing: empty, not an error.
    expect((await list(`${SITE}?actor=${dora.slug}`, cookies.admin)).total).toBe(0);
  });

  it('offers the system option only when a system row exists, and dates the log from the migration', async () => {
    const { users, op1, cookies } = await setup();
    await seed([row(op1, users.writer)]);

    const before = await facets(`${SITE}/facets`, cookies.admin);
    expect(before.actors.map((a) => a.value)).toEqual([users.writer.slug]);
    expect(before.logStartsAt).not.toBeNull();
    expect(() => isoDateSchema.parse(before.logStartsAt)).not.toThrow();

    await seed([
      row(op1, users.writer, { ...SYSTEM, entityType: 'default_tag', action: 'create' }),
    ]);
    const after = await facets(`${SITE}/facets`, cookies.admin);
    expect(after.actors).toEqual([
      {
        value: users.writer.slug,
        label: 'Wendy Writer',
        email: users.writer.email,
        deleted: false,
      },
      { value: 'system', label: SYSTEM_ACTOR_LABEL, email: null, deleted: false },
    ]);
    // The option's value is what the filter takes back.
    const sys = await list(`${SITE}?actor=system`, cookies.admin);
    expect(sys.total).toBe(1);
    expect(sys.items[0]!.actor).toBeNull();
    expect(sys.items[0]!.via).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('filters', () => {
  it('takes actor as a slug, a numeric id, a case-insensitive email or the literal system, ORs several, and matches nothing for an unknown slug', async () => {
    const { users, op1, cookies } = await setup();
    const [w1, w2, a1, s1] = await seed([
      row(op1, users.writer, { createdAt: T1 }),
      row(op1, users.writer, { createdAt: T2 }),
      row(op1, users.admin, { createdAt: T2 }),
      row(op1, users.writer, { ...SYSTEM, createdAt: T3, entityType: 'tag' }),
    ]);
    const wendy = sorted([w1!.uuid, w2!.uuid]);

    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? cookies.writer : cookies.admin;
      expect(sorted(uuids(await list(`${base}?actor=${users.writer.slug}`, cookie)))).toEqual(
        wendy,
      );
      expect(sorted(uuids(await list(`${base}?actor=${users.writer.id}`, cookie)))).toEqual(wendy);
      expect(sorted(uuids(await list(`${base}?actor=WRITER@test.LOCAL`, cookie)))).toEqual(wendy);
      expect(uuids(await list(`${base}?actor=system`, cookie))).toEqual([s1!.uuid]);
      expect(uuids(await list(`${base}?actor=${users.admin.slug}`, cookie))).toEqual([a1!.uuid]);
      // Several values, repeated or comma-joined, are ORed.
      expect(
        sorted(uuids(await list(`${base}?actor=${users.admin.slug}&actor=system`, cookie))),
      ).toEqual(sorted([a1!.uuid, s1!.uuid]));
      expect(
        sorted(
          uuids(await list(`${base}?actor=${users.admin.id},system,${users.writer.slug}`, cookie)),
        ),
      ).toEqual(sorted([a1!.uuid, s1!.uuid, w1!.uuid, w2!.uuid]));
      // An unknown slug, id or email is an empty page, not a 400.
      expect((await list(`${base}?actor=nobody-here`, cookie)).total).toBe(0);
      expect((await list(`${base}?actor=999999`, cookie)).total).toBe(0);
      expect((await list(`${base}?actor=ghost@test.local`, cookie)).total).toBe(0);
    }
  });

  it('narrows on action and entity (repeated and comma-joined), via and entityId', async () => {
    const { users, op1, cookies } = await setup();
    const OTHER = 'e0a1b2c3-0000-4000-8000-000000000002';
    const [cEv, uEv, dFi, lGo, kEv] = await seed([
      row(op1, users.writer, { action: 'create' }),
      row(op1, users.writer, { action: 'update' }),
      row(op1, users.writer, { action: 'delete', entityType: 'finding', entityId: '7' }),
      row(op1, users.writer, { action: 'link', entityType: 'goal', entityId: '3' }),
      row(op1, users.writer, { action: 'update', via: 'apikey', entityId: OTHER }),
    ]);

    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? cookies.writer : cookies.admin;
      const ids = async (qs: string) => sorted(uuids(await list(`${base}${qs}`, cookie)));

      expect(await ids('?action=create')).toEqual([cEv!.uuid]);
      expect(await ids('?action=create&action=delete')).toEqual(sorted([cEv!.uuid, dFi!.uuid]));
      expect(await ids('?action=create,delete')).toEqual(sorted([cEv!.uuid, dFi!.uuid]));
      expect(await ids('?entity=finding')).toEqual([dFi!.uuid]);
      expect(await ids('?entity=finding&entity=goal')).toEqual(sorted([dFi!.uuid, lGo!.uuid]));
      expect(await ids('?entity=finding,goal')).toEqual(sorted([dFi!.uuid, lGo!.uuid]));
      expect(await ids('?via=apikey')).toEqual([kEv!.uuid]);
      expect(await ids('?via=session')).toEqual(
        sorted([cEv!.uuid, uEv!.uuid, dFi!.uuid, lGo!.uuid]),
      );
      expect(await ids(`?entityId=${EVIDENCE_UUID}`)).toEqual(sorted([cEv!.uuid, uEv!.uuid]));
      expect(await ids(`?entityId=${OTHER}`)).toEqual([kEv!.uuid]);
      // Filters AND together.
      expect(await ids(`?action=update&entity=evidence&via=session`)).toEqual([uEv!.uuid]);
      expect(await ids(`?action=update&entity=finding`)).toEqual([]);
    }
  });

  it('bounds createdAt inclusively with from and to', async () => {
    const { users, op1, cookies } = await setup();
    const [d1, d2, d3] = await seed([
      row(op1, users.writer, { createdAt: T1 }),
      row(op1, users.writer, { createdAt: T2 }),
      row(op1, users.writer, { createdAt: T3 }),
    ]);
    const iso = (d: Date) => encodeURIComponent(d.toISOString());

    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? cookies.writer : cookies.admin;
      const ids = async (qs: string) => sorted(uuids(await list(`${base}${qs}`, cookie)));
      expect(await ids(`?from=${iso(T2)}`)).toEqual(sorted([d2!.uuid, d3!.uuid]));
      expect(await ids(`?to=${iso(T2)}`)).toEqual(sorted([d1!.uuid, d2!.uuid]));
      expect(await ids(`?from=${iso(T2)}&to=${iso(T2)}`)).toEqual([d2!.uuid]);
      expect(await ids(`?from=${iso(T1)}&to=${iso(T3)}`)).toEqual(
        sorted([d1!.uuid, d2!.uuid, d3!.uuid]),
      );
      // An offset form is accepted too (+00:00 is encoded, or the + becomes a space).
      expect(await ids(`?from=${encodeURIComponent('2026-03-03T11:00:00+01:00')}`)).toEqual([
        d3!.uuid,
      ]);
      expect(await ids(`?to=${iso(new Date(T1.getTime() - 1))}`)).toEqual([]);
    }
  });

  it('matches q against summary and entityLabel case-insensitively on both scopes', async () => {
    const { users, op1, cookies } = await setup();
    const [bySummary, byLabel] = await seed([
      row(op1, users.writer, {
        summary: 'Edited evidence “CAN dump”: Title',
        entityLabel: 'CAN dump',
      }),
      row(op1, users.writer, { summary: 'Created finding', entityLabel: 'Keyfob Replay' }),
      row(op1, users.writer, { summary: 'Created target', entityLabel: 'Telematics unit' }),
    ]);

    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? cookies.writer : cookies.admin;
      const ids = async (qs: string) => sorted(uuids(await list(`${base}${qs}`, cookie)));
      expect(await ids('?q=title')).toEqual([bySummary!.uuid]);
      expect(await ids('?q=TITLE')).toEqual([bySummary!.uuid]);
      expect(await ids('?q=keyfob')).toEqual([byLabel!.uuid]);
      expect(await ids('?q=KEYFOB%20replay')).toEqual([byLabel!.uuid]);
      expect(await ids('?q=created')).toHaveLength(2);
      expect(await ids('?q=nothing-like-this')).toEqual([]);
      // An empty or whitespace q is no filter.
      expect(await ids('?q=')).toHaveLength(3);
      expect(await ids('?q=%20%20')).toHaveLength(3);
    }
  });

  it('searches the changes text with q only under site scope', async () => {
    const { users, op1, cookies } = await setup();
    const token = 'hunter2-leaked-token';
    const [leak] = await seed([
      row(op1, users.writer, {
        summary: 'Edited evidence “CAN dump”: Description',
        entityLabel: 'CAN dump',
        changes: [{ kind: 'field', field: 'description', from: 'clean', to: `password=${token}` }],
      }),
      row(op1, users.writer, { summary: 'Created target', entityLabel: 'ECU' }),
    ]);

    const site = await list(`${SITE}?q=${token}`, cookies.admin);
    expect(uuids(site)).toEqual([leak!.uuid]);
    // Case-insensitive on the diff half as well.
    expect(uuids(await list(`${SITE}?q=HUNTER2-LEAKED`, cookies.admin))).toEqual([leak!.uuid]);
    // Same row, same q, engagement scope: the diff is not searched.
    expect((await list(`${ENG}?q=${token}`, cookies.writer)).total).toBe(0);
    expect((await list(`${ENG}?q=${token}`, cookies.admin)).total).toBe(0);
    // The summary half still works there, of course.
    expect(uuids(await list(`${ENG}?q=description`, cookies.writer))).toEqual([leak!.uuid]);
  });

  it('treats % and _ in q as literal characters', async () => {
    const { users, op1, cookies } = await setup();
    // Pairs: one row with the metacharacter, one with what a wildcard would
    // also have matched. Only the first of each pair may come back.
    const [pct, , under, , diffPct] = await seed([
      row(op1, users.writer, { summary: 'Coverage reached 100% today', entityLabel: 'a' }),
      row(op1, users.writer, { summary: 'Coverage reached 100 today', entityLabel: 'b' }),
      row(op1, users.writer, { summary: 'Renamed to can_dump', entityLabel: 'c' }),
      row(op1, users.writer, { summary: 'Renamed to canXdump', entityLabel: 'd' }),
      row(op1, users.writer, {
        summary: 'Edited a thing',
        entityLabel: 'e',
        changes: [{ kind: 'field', field: 'note', from: null, to: 'ratio 7% exactly' }],
      }),
      row(op1, users.writer, {
        summary: 'Edited another thing',
        entityLabel: 'f',
        changes: [{ kind: 'field', field: 'note', from: null, to: 'ratio 7 percent' }],
      }),
    ]);

    // Soft, so one leaking metacharacter does not hide the others in the report.
    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? cookies.writer : cookies.admin;
      const ids = async (qs: string) => sorted(uuids(await list(`${base}${qs}`, cookie)));
      expect.soft(await ids('?q=100%25%20today'), `${base} %`).toEqual([pct!.uuid]);
      expect.soft(await ids('?q=100%25'), `${base} % trailing`).toEqual([pct!.uuid]);
      expect.soft(await ids('?q=can_dump'), `${base} _`).toEqual([under!.uuid]);
      // A backslash is data as well, not an escape: nothing seeded contains one.
      expect.soft((await list(`${base}?q=%5C`, cookie)).total, `${base} backslash`).toBe(0);
      expect.soft((await list(`${base}?q=100%5C%25`, cookie)).total, `${base} \\%`).toBe(0);
    }
    // The diff half under site scope escapes too.
    expect
      .soft(sorted(uuids(await list(`${SITE}?q=7%25`, cookies.admin))), 'diff %')
      .toEqual([diffPct!.uuid]);
  });

  it('cannot reach a removed entry through q on either scope', async () => {
    const { users, op1, cookies } = await setup();
    const needle = 'needle-in-the-log';
    const [target, keep] = await seed([
      row(op1, users.writer, {
        summary: `Edited ${needle}`,
        entityLabel: needle,
        changes: [{ kind: 'field', field: 'x', from: null, to: needle }],
      }),
      row(op1, users.writer, { summary: 'Something else', entityLabel: needle }),
    ]);
    expect((await list(`${SITE}?q=${needle}`, cookies.admin)).total).toBe(2);

    const res = await remove(target!.uuid, cookies.admin, { reason: 'Contained a credential' });
    expect(res.statusCode).toBe(200);

    for (const [url, cookie] of [
      [`${SITE}?q=${needle}`, cookies.admin],
      [`${ENG}?q=${needle}`, cookies.writer],
    ] as const) {
      const page = await list(url, cookie);
      expect(uuids(page), url).toEqual([keep!.uuid]);
    }
    // Not through the summary, the label, or the diff.
    expect((await list(`${SITE}?q=edited`, cookies.admin)).total).toBe(0);
  });

  it('refuses an invalid sort, dir, via, action, entity or from with a 400 rather than ignoring it', async () => {
    const { users, op1, cookies } = await setup();
    await seed([row(op1, users.writer)]);

    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? cookies.writer : cookies.admin;
      for (const qs of [
        '?sort=actor',
        '?sort=',
        '?dir=up',
        '?via=browser',
        '?action=edited',
        '?action=create,edited',
        '?entity=comment',
        '?from=yesterday',
        '?to=2026-03-01',
      ]) {
        const res = await get(`${base}${qs}`, cookie);
        expect(res.statusCode, `${base}${qs}`).toBe(400);
        expect(res.json()).toMatchObject({ error: 'Validation failed' });
      }
    }
    // The site-only keys are validated on the site list…
    expect((await get(`${SITE}?eng=Not_A_Slug`, cookies.admin)).statusCode).toBe(400);
    // …and parsed (so also validated) on the engagement list, even though ignored.
    expect((await get(`${ENG}?eng=Not_A_Slug`, cookies.writer)).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('sorting', () => {
  /** Seven rows with ties on every sortable column, in both scopes' view. */
  async function seedForSort(f: Fixture) {
    return seed([
      row(f.op1, f.users.writer, { createdAt: T1, action: 'update' }),
      row(f.op1, f.users.admin, { createdAt: T1, action: 'create' }),
      row(f.op1, f.users.writer, { createdAt: T2, action: 'delete' }),
      row(f.op1, f.users.writer, { createdAt: T2, action: 'update' }),
      row(f.op1, f.users.admin, { createdAt: T2, action: 'update' }),
      row(f.op1, f.users.writer, { ...SYSTEM, createdAt: T3, action: 'create', entityType: 'tag' }),
      row(f.op1, f.users.writer, { createdAt: T3, action: 'create' }),
    ]);
  }

  it('defaults to newest first, and honours when/who/action with dir', async () => {
    const f = await setup();
    const rows = await seedForSort(f);
    /** The seeded rows' uuids in the given seed order. */
    const order = (...idx: number[]) => idx.map((i) => rows[i]!.uuid);

    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? f.cookies.writer : f.cookies.admin;

      // Default: createdAt desc, id desc.
      const dflt = await list(base, cookie);
      expect(uuids(dflt), base).toEqual(order(6, 5, 4, 3, 2, 1, 0));
      expect(uuids(await list(`${base}?sort=when&dir=desc`, cookie)), base).toEqual(uuids(dflt));
      // when asc: createdAt asc, id asc.
      expect(uuids(await list(`${base}?sort=when&dir=asc`, cookie)), base).toEqual(
        order(0, 1, 2, 3, 4, 5, 6),
      );

      // who asc: actorName asc with the System row (null) last; ties newest-first.
      const whoAsc = await list(`${base}?sort=who&dir=asc`, cookie);
      expect(
        whoAsc.items.map((i) => i.actor?.name ?? null),
        base,
      ).toEqual([
        'Ada Admin',
        'Ada Admin',
        'Wendy Writer',
        'Wendy Writer',
        'Wendy Writer',
        'Wendy Writer',
        null,
      ]);
      expect(uuids(whoAsc), base).toEqual(order(4, 1, 6, 3, 2, 0, 5));
      // who desc: System first, then names descending; ties still newest-first.
      const whoDesc = await list(`${base}?sort=who&dir=desc`, cookie);
      expect(uuids(whoDesc), base).toEqual(order(5, 6, 3, 2, 0, 4, 1));

      // action asc/desc, ties newest-first either way.
      const actAsc = await list(`${base}?sort=action&dir=asc`, cookie);
      expect(
        actAsc.items.map((i) => i.action),
        base,
      ).toEqual(['create', 'create', 'create', 'delete', 'update', 'update', 'update']);
      expect(uuids(actAsc), base).toEqual(order(6, 5, 1, 2, 4, 3, 0));
      const actDesc = await list(`${base}?sort=action&dir=desc`, cookie);
      expect(uuids(actDesc), base).toEqual(order(4, 3, 0, 2, 6, 5, 1));
    }
  });

  it('is stable across pages for every sort key and direction', async () => {
    const f = await setup();
    const rows = await seedForSort(f);
    const all = sorted(rows.map((r) => r.uuid));

    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? f.cookies.writer : f.cookies.admin;
      for (const sort of ['when', 'who', 'action'] as const) {
        for (const dir of ['asc', 'desc'] as const) {
          const url = `${base}?sort=${sort}&dir=${dir}`;
          const whole = await list(`${url}&pageSize=250`, cookie);
          const paged = await walk(url, cookie, 2);
          // No overlap, nothing missed, and the same order as one big page.
          expect(sorted(paged.map((i) => i.uuid)), url).toEqual(all);
          expect(
            paged.map((i) => i.uuid),
            url,
          ).toEqual(uuids(whole));
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

describe('paging', () => {
  it('returns the envelope with an exact total on every page', async () => {
    const { users, op1, cookies } = await setup();
    const rows = await seed(
      Array.from({ length: 5 }, (_, i) =>
        row(op1, users.writer, { createdAt: new Date(T1.getTime() + i * 1000) }),
      ),
    );
    const newest = [...rows].reverse().map((r) => r.uuid);

    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? cookies.writer : cookies.admin;
      const p1 = await list(`${base}?pageSize=2`, cookie);
      expect(p1).toMatchObject({ total: 5, page: 1, pageSize: 2 });
      expect(uuids(p1)).toEqual(newest.slice(0, 2));
      const p3 = await list(`${base}?pageSize=2&page=3`, cookie);
      expect(p3).toMatchObject({ total: 5, page: 3, pageSize: 2 });
      expect(uuids(p3)).toEqual(newest.slice(4));
      // A filter's total is the filtered count, not the table's.
      const filtered = await list(`${base}?pageSize=2&actor=${users.admin.slug}`, cookie);
      expect(filtered).toMatchObject({ total: 0, page: 1, pageSize: 2, items: [] });
      // Defaults: page 1 of 50.
      expect(await list(base, cookie)).toMatchObject({ page: 1, pageSize: 50, total: 5 });
    }
  });

  it('clamps a too-deep page to the deepest page for that page size instead of refusing it', async () => {
    const { users, op1, cookies } = await setup();
    await seed([row(op1, users.writer)]);

    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? cookies.writer : cookies.admin;
      for (const pageSize of [50, 250, 7, 1]) {
        const page = await list(`${base}?page=99999&pageSize=${pageSize}`, cookie);
        expect(page.page, `${base} pageSize=${pageSize}`).toBe(
          Math.ceil(AUDIT_MAX_OFFSET / pageSize),
        );
        expect(page.pageSize).toBe(pageSize);
        expect(page.total).toBe(1);
        expect(page.items).toEqual([]);
      }
      // A page within reach is served as asked.
      expect((await list(`${base}?page=2&pageSize=1`, cookie)).page).toBe(2);
      // Nonsense is the default page, not an error.
      expect((await list(`${base}?page=-4`, cookie)).page).toBe(1);
      expect((await list(`${base}?page=abc`, cookie)).page).toBe(1);
    }
  });

  it('caps pageSize at 250 and floors it at 1', async () => {
    const { users, op1, cookies } = await setup();
    await seed([row(op1, users.writer), row(op1, users.writer)]);

    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? cookies.writer : cookies.admin;
      expect((await list(`${base}?pageSize=9999`, cookie)).pageSize).toBe(250);
      expect((await list(`${base}?pageSize=0`, cookie)).pageSize).toBe(1);
      expect((await list(`${base}?pageSize=-1`, cookie)).pageSize).toBe(1);
      expect((await list(`${base}?pageSize=lots`, cookie)).pageSize).toBe(50);
      const one = await list(`${base}?pageSize=1`, cookie);
      expect(one.items).toHaveLength(1);
      expect(one.total).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

describe('removal', () => {
  it('refuses an unknown uuid (404), a malformed uuid (400) and a missing, blank or over-long reason (400), leaving the row live', async () => {
    const { users, op1, cookies } = await setup();
    const [target] = await seed([row(op1, users.writer)]);
    const good = { reason: 'Contained a credential' };

    const unknown = await remove('11111111-2222-4333-8444-555555555555', cookies.admin, good);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'Audit entry not found' });

    for (const bad of ['not-a-uuid', '123', target!.id.toString()]) {
      const res = await remove(bad, cookies.admin, good);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json()).toMatchObject({ error: 'Validation failed' });
    }

    for (const body of [
      {},
      { reason: '' },
      { reason: '   ' },
      { reason: 'x'.repeat(AUDIT_DELETE_REASON_MAX_CHARS + 1) },
      { reason: 42 },
    ]) {
      const res = await remove(target!.uuid, cookies.admin, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'Validation failed' });
    }
    const noBody = await app.inject({
      method: 'POST',
      url: `${SITE}/${target!.uuid}/remove`,
      headers: { ...WEB_HEADERS, cookie: cookies.admin },
    });
    expect(noBody.statusCode).toBe(400);

    const after = await app.db.auditEntry.findUniqueOrThrow({ where: { id: target!.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.summary).toBe(target!.summary);
    expect(after.changes).toEqual(target!.changes);
    expect((await list(ENG, cookies.writer)).items[0]!.deleted).toBeNull();
  });

  it('returns the serialized tombstone with the skeleton intact, and a second removal is a 409', async () => {
    const { users, op1, cookies } = await setup();
    const [target] = await seed([row(op1, users.writer, { createdAt: T1 })]);
    const before = (await list(ENG, cookies.writer)).items[0]!;
    expect(before.deleted).toBeNull();
    const reason = ' A credential was pasted into the description. ';

    const res = await remove(target!.uuid, cookies.admin, { reason });
    expect(res.statusCode, res.body).toBe(200);
    const { entry } = removeAuditEntryResultSchema.parse(res.json());

    expect(entry.deleted).not.toBeNull();
    expect(() => isoDateSchema.parse(entry.deleted!.at)).not.toThrow();
    expect(entry.deleted).toMatchObject({
      byName: 'Ada Admin',
      byEmail: users.admin.email,
      bySlug: users.admin.slug,
      reason: reason.trim(),
    });
    expect(entry.summary).toBe('');
    expect(entry.entityLabel).toBe('');
    expect(entry.changes).toEqual([]);
    // Everything that places the row in the list is preserved.
    expect(entry).toMatchObject({
      uuid: before.uuid,
      action: before.action,
      entityType: before.entityType,
      entityId: before.entityId,
      actor: before.actor,
      engagement: before.engagement,
      via: before.via,
      source: before.source,
      createdAt: before.createdAt,
      lastAt: before.lastAt,
      coalescedCount: before.coalescedCount,
    });
    expect(entry.createdAt).toBe(T1.toISOString());

    // Reason exactly at the cap is accepted on another row.
    const [second] = await seed([row(op1, users.writer)]);
    const atCap = await remove(second!.uuid, cookies.admin, {
      reason: 'y'.repeat(AUDIT_DELETE_REASON_MAX_CHARS),
    });
    expect(atCap.statusCode).toBe(200);

    const again = await remove(target!.uuid, cookies.admin, { reason: 'once more' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: AUDIT_ENTRY_ALREADY_REMOVED });
    // The first removal's record stands.
    const stored = await app.db.auditEntry.findUniqueOrThrow({ where: { id: target!.id } });
    expect(stored.deletedReason).toBe(reason.trim());
    expect(stored.deletedById).toBe(users.admin.id);
  });

  it('keeps a removed row in both lists, where it still sorts and filters, with nothing gone from the table', async () => {
    const { users, op1, cookies } = await setup();
    const [first, target, third] = await seed([
      row(op1, users.admin, {
        createdAt: T1,
        action: 'create',
        entityType: 'target',
        entityId: '1',
      }),
      row(op1, users.writer, { createdAt: T2, action: 'update', entityType: 'evidence' }),
      row(op1, users.writer, {
        createdAt: T3,
        action: 'delete',
        entityType: 'finding',
        entityId: '7',
      }),
    ]);
    const countBefore = await app.db.auditEntry.count();

    expect((await remove(target!.uuid, cookies.admin, { reason: 'purge' })).statusCode).toBe(200);
    expect(await app.db.auditEntry.count()).toBe(countBefore);

    for (const base of [ENG, SITE]) {
      const cookie = base === ENG ? cookies.writer : cookies.admin;
      const page = await list(base, cookie);
      expect(page.total, base).toBe(3);
      expect(uuids(page), base).toEqual([third!.uuid, target!.uuid, first!.uuid]);
      const tomb = page.items[1]!;
      expect(tomb.deleted?.byName, base).toBe('Ada Admin');
      expect(tomb.summary, base).toBe('');
      expect(tomb.changes, base).toEqual([]);
      expect(tomb.actor?.name, base).toBe('Wendy Writer');

      // Sorts into its place under every key.
      expect(uuids(await list(`${base}?sort=when&dir=asc`, cookie)), base).toEqual([
        first!.uuid,
        target!.uuid,
        third!.uuid,
      ]);
      expect(uuids(await list(`${base}?sort=who&dir=asc`, cookie)), base).toEqual([
        first!.uuid,
        third!.uuid,
        target!.uuid,
      ]);
      expect(uuids(await list(`${base}?sort=action&dir=asc`, cookie)), base).toEqual([
        first!.uuid,
        third!.uuid,
        target!.uuid,
      ]);
      // Filters by its kept skeleton.
      expect(uuids(await list(`${base}?actor=${users.writer.slug}`, cookie)), base).toEqual([
        third!.uuid,
        target!.uuid,
      ]);
      expect(uuids(await list(`${base}?action=update`, cookie)), base).toEqual([target!.uuid]);
      expect(uuids(await list(`${base}?entity=evidence`, cookie)), base).toEqual([target!.uuid]);
      expect(uuids(await list(`${base}?entityId=${EVIDENCE_UUID}`, cookie)), base).toEqual([
        target!.uuid,
      ]);
      expect(uuids(await list(`${base}?entity=evidence,target`, cookie)), base).toEqual([
        target!.uuid,
        first!.uuid,
      ]);
      // The removal is not a facet of its own: the actor and action stay offered.
      const f = await facets(`${base}/facets`, cookie);
      expect(f.actions, base).toEqual(['create', 'update', 'delete']);
      expect(
        f.actors.map((a) => a.value),
        base,
      ).toEqual([users.admin.slug, users.writer.slug]);
    }
  });

  it('keeps the tombstone readable after the remover’s own account is hard-deleted', async () => {
    const { users, op1, cookies } = await setup();
    const backup = await createLocalUser(app.db, {
      firstName: 'Bea',
      lastName: 'Backup',
      email: 'backup@test.local',
      password: PASSWORD,
      admin: true,
    });
    const [target] = await seed([row(op1, users.writer)]);
    expect((await remove(target!.uuid, cookies.admin, { reason: 'purge' })).statusCode).toBe(200);

    await app.db.user.delete({ where: { id: users.admin.id } });
    // Ada's session died with the account; Bea reads the log now.
    expect((await get(SITE, cookies.admin)).statusCode).toBe(401);
    const bea = await loginCookie(app, backup.email, PASSWORD);

    for (const [url, cookie] of [
      [`${SITE}?entity=evidence`, bea],
      [`${ENG}?entity=evidence`, cookies.writer],
    ] as const) {
      const page = await list(url, cookie);
      const tomb = page.items.find((i) => i.uuid === target!.uuid);
      expect(tomb, url).toBeDefined();
      expect(tomb!.deleted, url).toMatchObject({
        byName: 'Ada Admin',
        byEmail: users.admin.email,
        bySlug: null,
        reason: 'purge',
      });
      expect(tomb!.summary, url).toBe('');
    }
    // Still frozen: a second removal by the surviving admin is a 409, not a rewrite.
    expect((await remove(target!.uuid, bea, { reason: 'again' })).statusCode).toBe(409);
  });
});
