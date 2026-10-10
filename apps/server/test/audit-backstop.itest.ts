import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildAuthHeaders } from '@reporter/api-client';
import { AUDIT_BULK_ROW_CAP } from '@reporter/shared';
import { auditCtxFromContext, recordAudit, withIntent } from '../src/services/audit.js';
import {
  WEB_HEADERS,
  apiKeyFor,
  buildTestApp,
  loginCookie,
  seedUsers,
  truncateAll,
  truncateAuditLog,
} from './helpers.js';

// The backstop against a real database: what a write through `app.db` leaves
// in the audit log, who it is attributed to on each plane, what it refuses to
// carry, and the two places it deliberately stays silent (suppression, and an
// unwrapped transaction). Every case truncates the log AFTER its fixtures, so
// the assertions count exactly the entries the exercised write produced.

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
  return { users, eng, tag: eng.tags[0]! };
}

function post(url: string, cookie: string, payload: unknown) {
  return app.inject({ method: 'POST', url, headers: { ...WEB_HEADERS, cookie }, payload });
}
function put(url: string, cookie: string, payload: unknown) {
  return app.inject({ method: 'PUT', url, headers: { ...WEB_HEADERS, cookie }, payload });
}

function signed(
  method: string,
  url: string,
  key: { accessKey: string; secretKey: string },
  body?: unknown,
) {
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const headers = buildAuthHeaders(method, url, raw, key.accessKey, key.secretKey);
  return app.inject({
    method: method as 'GET' | 'POST',
    url,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    payload: body === undefined ? undefined : raw,
  });
}

describe('attribution', () => {
  it('records a web-plane write as the session user, via session, on its engagement', async () => {
    const { users, eng } = await setup();
    const cookie = await loginCookie(app, 'writer@test.local', 'password123');
    await truncateAuditLog(app);

    const res = await post('/web/engagements/op1/targets', cookie, { name: 'ECU' });
    expect(res.statusCode).toBe(200);
    const target = res.json();

    const rows = await entries();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      action: 'create',
      entityType: 'target',
      entityId: String(target.id),
      entityLabel: 'ECU',
      summary: 'Created target “ECU”',
      source: 'backstop',
      via: 'session',
      actorId: users.writer.id,
      actorName: 'Wendy Writer',
      actorEmail: 'writer@test.local',
      engagementId: eng.id,
      engagementSlug: 'op1',
      engagementName: 'Op One',
      coalesceKey: null,
      coalescedCount: 1,
    });
    expect(row.changes).toContainEqual({ kind: 'field', field: 'name', from: null, to: 'ECU' });
  });

  it('records an HMAC write as the user behind the key, via apikey, with a coalescing api_key_auth entry and no key identity', async () => {
    const { users } = await setup();
    const key = await apiKeyFor(app, users.writer.id);
    await truncateAuditLog(app);

    const res = await signed('POST', '/api/engagements/op1/tags', key, {
      name: 'api-tag',
      colorName: 'green',
    });
    expect(res.statusCode).toBe(200);

    let rows = await entries();
    expect(rows.map((r) => [r.action, r.entityType])).toEqual([
      ['api_key_auth', 'user'],
      ['create', 'tag'],
    ]);
    expect(rows[0]).toMatchObject({
      entityId: users.writer.slug,
      entityLabel: 'Wendy Writer',
      via: 'apikey',
      actorId: users.writer.id,
      actorEmail: 'writer@test.local',
      coalesceKey: 'auth',
      coalescedCount: 1,
      engagementId: null,
      changes: [],
    });
    expect(rows[1]).toMatchObject({
      via: 'apikey',
      actorId: users.writer.id,
      engagementSlug: 'op1',
      entityLabel: 'api-tag',
    });

    // A second authenticated request folds into the same auth entry.
    const again = await signed('GET', '/api/checkconnection', key);
    expect(again.statusCode).toBe(200);
    rows = await entries();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.coalescedCount).toBe(2);

    // No key identity anywhere, and no entityId that is a live access key.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(key.accessKey);
    expect(dump).not.toContain(key.secretKey);
    const leaked = await app.db.$queryRaw<unknown[]>`
      SELECT 1 FROM audit_entries e JOIN api_keys k ON e.entity_id = k.access_key`;
    expect(leaked).toHaveLength(0);
  });

  it('records a write outside any request as a system row with no actor', async () => {
    await setup();
    await truncateAuditLog(app);

    await app.db.defaultTag.create({ data: { name: 'sys-tag', colorName: 'blue' } });

    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      via: 'system',
      actorId: null,
      actorName: null,
      actorEmail: null,
      engagementId: null,
      entityType: 'default_tag',
      action: 'create',
      summary: 'Created default tag “sys-tag”',
    });
  });
});

describe('what the log never carries', () => {
  it('holds none of the secrets planted through login, password change, API key, TOTP, recovery and a logo', async () => {
    const { users } = await setup();
    // `report_settings` is not in the harness's TABLES; start from no branding
    // row so the logo below is a create, whichever case ran before this one.
    await app.db.reportSettings.deleteMany();
    const admin = await loginCookie(app, 'admin@test.local', 'password123');
    const writer = await loginCookie(app, 'writer@test.local', 'password123');

    const newPassword = 'Sup3rSecretNewPassw0rd!';
    expect(
      (
        await post('/web/account/password', writer, {
          currentPassword: 'password123',
          newPassword,
        })
      ).statusCode,
    ).toBe(200);

    const keyRes = await post('/web/account/api-keys', writer, {});
    expect(keyRes.statusCode).toBe(201);
    const { accessKey, secretKey } = keyRes.json();

    const recovery = await post(`/web/admin/users/${users.writer.slug}/recovery`, admin, {});
    expect(recovery.statusCode).toBe(200);
    const code = String(recovery.json().recoveryUrl).split('/').pop()!;

    const totpSecret = 'JBSWY3DPEHPK3PXPPLANTEDTOTPSECRET';
    await app.db.authIdentity.updateMany({
      where: { userId: users.writer.id },
      data: { totpSecret },
    });
    const reset = await post(`/web/admin/users/${users.writer.slug}/totp-reset`, admin, {});
    expect(reset.json()).toEqual({ ok: true, hadTotp: true });

    const logoMarker = 'PLANTEDLOGOBYTES'.repeat(16);
    const logo = await put('/web/admin/report-settings', admin, {
      organizationName: 'Block Harbor',
      logoDataUri: `data:image/png;base64,${logoMarker}`,
    });
    expect(logo.statusCode).toBe(200);

    const hashes = (await app.db.authIdentity.findMany()).map((i) => i.passwordHash!);
    expect(hashes.length).toBeGreaterThan(0);

    const rows = await entries();
    const dump = JSON.stringify(rows);
    for (const secret of [
      'password123',
      newPassword,
      ...hashes,
      accessKey,
      secretKey,
      code,
      totpSecret,
      logoMarker,
      '"type":"Buffer"',
    ]) {
      expect(dump).not.toContain(secret);
    }

    // The logo change IS recorded — as a size, through the redaction table.
    const branding = rows.find(
      (r) =>
        r.entityType === 'report_settings' && JSON.stringify(r.changes).includes('logoDataUri'),
    );
    expect(branding).toBeDefined();
    expect(JSON.stringify(branding!.changes)).toContain('"$opaque":"blob"');

    // The seeded users' create entries are in this log (nothing truncated them)
    // and each carries its nested identity — the row with the password hash — as
    // a count only.
    const userCreates = rows.filter((r) => r.entityType === 'user' && r.action === 'create');
    expect(userCreates).toHaveLength(3);
    for (const r of userCreates) {
      expect(r.changes).toContainEqual({ kind: 'count', label: 'Identities created', count: 1 });
    }
  });

  it('records a login only as the route’s own sign-in entry, and nothing for an edit that touches only ignored columns', async () => {
    const { users, eng } = await setup();
    const ev = await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'none',
        title: 'CAN dump',
        occurredAt: new Date(),
      },
    });
    await truncateAuditLog(app);

    // Session and AuthIdentity are unaudited, so the backstop writes nothing
    // for a login; the one row is the hand-written `sign_in` (routes/web/auth.ts).
    await loginCookie(app, 'writer@test.local', 'password123');
    const login = await entries();
    expect(login).toHaveLength(1);
    expect(login[0]).toMatchObject({
      action: 'sign_in',
      entityType: 'user',
      entityId: users.writer.slug,
      source: 'intent',
      actorId: users.writer.id,
      engagementId: null,
    });
    await truncateAuditLog(app);

    await app.db.evidence.update({
      where: { id: ev.id },
      data: { lastEditedById: users.admin.id, thumbBlobKey: 'rotated' },
    });
    expect(await entries()).toHaveLength(0);

    // A real edit is one coalescable entry per field, and a second edit of the
    // same field by the same actor folds into it with the original `from`.
    await app.db.evidence.update({ where: { id: ev.id }, data: { title: 'CAN dump (ECU)' } });
    await app.db.evidence.update({ where: { id: ev.id }, data: { title: 'CAN dump (TCU)' } });
    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'update',
      entityType: 'evidence',
      entityId: ev.uuid,
      coalesceKey: 'title',
      coalescedCount: 2,
      summary: 'Edited evidence “CAN dump (ECU)”: Title',
      changes: [{ kind: 'field', field: 'title', from: 'CAN dump', to: 'CAN dump (TCU)' }],
    });
  });
});

describe('what a write looks like', () => {
  it('summarises nested writes on a create as counts on one entry', async () => {
    const { users } = await setup();
    await truncateAuditLog(app);

    // The same statement POST /web/engagements issues, outside any request, so
    // it is the backstop — not the route's own entry — that describes it.
    await app.db.engagement.create({
      data: {
        slug: 'new-eng',
        name: 'New Engagement',
        roles: { create: { userId: users.admin.id, role: 'admin' } },
        tags: {
          create: [
            { name: 'recon', colorName: 'blue', position: 0 },
            { name: 'exfil', colorName: 'pink', position: 1 },
          ],
        },
      },
    });

    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'create',
      entityType: 'engagement',
      entityLabel: 'New Engagement',
      engagementSlug: 'new-eng',
      source: 'backstop',
      via: 'system',
      summary: 'Created engagement “New Engagement” (Roles created: 1, Tags created: 2)',
    });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Roles created', count: 1 });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Tags created', count: 2 });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'field',
      field: 'slug',
      from: null,
      to: 'new-eng',
    });
  });

  it('stays silent for POST /web/engagements, whose handler writes its own entry', async () => {
    await setup();
    await app.db.defaultTag.createMany({
      data: [
        { name: 'recon', colorName: 'blue' },
        { name: 'exfil', colorName: 'pink' },
      ],
    });
    const admin = await loginCookie(app, 'admin@test.local', 'password123');
    await truncateAuditLog(app);

    const res = await post('/web/engagements', admin, { slug: 'new-eng', name: 'New Engagement' });
    expect(res.statusCode).toBe(200);

    // One entry, the route's: `withIntent(['engagement'])` silences the
    // backstop for the create, and the nested role and tag rows never reach it
    // as writes of their own.
    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'create',
      entityType: 'engagement',
      entityLabel: 'New Engagement',
      engagementSlug: 'new-eng',
      source: 'intent',
      via: 'session',
      summary: 'Created engagement “New Engagement” (new-eng)',
      changes: [{ kind: 'count', label: 'Default tags copied', count: 2 }],
    });
  });

  it('records a link on the owning goal and still sees the auto-advance side effect', async () => {
    const { users, eng } = await setup();
    const target = await app.db.engagementTarget.create({
      data: {
        engagementId: eng.id,
        name: 'ECU',
        activities: { create: { name: 'CAN', goals: { create: { title: 'Enumerate ECUs' } } } },
      },
      include: { activities: { include: { goals: true } } },
    });
    const goal = target.activities[0]!.goals[0]!;
    const ev = await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'none',
        title: 'CAN dump',
        occurredAt: new Date(),
      },
    });
    const writer = await loginCookie(app, 'writer@test.local', 'password123');
    await truncateAuditLog(app);

    const res = await post(`/web/engagements/op1/goals/${goal.id}/evidence`, writer, {
      evidenceUuids: [ev.uuid],
    });
    expect(res.json()).toEqual({ linked: 1 });

    const rows = await entries();
    expect(rows.map((r) => [r.action, r.entityType])).toEqual([
      ['link', 'goal'],
      ['update', 'goal'],
    ]);
    expect(rows[0]).toMatchObject({
      entityId: String(goal.id),
      entityLabel: 'Enumerate ECUs',
      summary: 'Linked evidence “CAN dump” to goal “Enumerate ECUs”',
      changes: [{ kind: 'items', label: 'Evidence', items: ['CAN dump'] }],
      engagementSlug: 'op1',
    });
    expect(rows[1]).toMatchObject({
      coalesceKey: 'status',
      changes: [{ kind: 'field', field: 'status', from: 'not_started', to: 'in_progress' }],
    });
  });

  it('records a tag application as a tags list change on the evidence', async () => {
    const { users, eng, tag } = await setup();
    const ev = await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'none',
        title: 'CAN dump',
        occurredAt: new Date(),
      },
    });
    await truncateAuditLog(app);

    await app.db.evidenceTag.create({ data: { evidenceId: ev.id, tagId: tag.id } });

    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'update',
      entityType: 'evidence',
      entityId: ev.uuid,
      coalesceKey: 'tags',
      summary: 'Edited evidence “CAN dump”: Tags',
    });
    const change = (
      rows[0]!.changes as Array<{ kind: string; from: unknown[]; to: Array<{ label: string }> }>
    )[0]!;
    expect(change.kind).toBe('list');
    expect(change.from).toEqual([]);
    expect(change.to.map((r) => r.label)).toEqual(['recon']);
  });

  it('records an upsert as a create the first time and an update after', async () => {
    await setup();
    const admin = await loginCookie(app, 'admin@test.local', 'password123');
    // `report_settings` is not in the harness's TABLES, so the singleton row an
    // earlier case created would otherwise turn the first PUT into an update.
    await app.db.reportSettings.deleteMany();
    await truncateAuditLog(app);

    await put('/web/admin/report-settings', admin, { organizationName: 'Block Harbor' });
    await put('/web/admin/report-settings', admin, { organizationName: 'BH Labs' });

    const rows = await entries();
    expect(rows.map((r) => r.action)).toEqual(['create', 'update']);
    expect(rows[0]).toMatchObject({
      entityType: 'report_settings',
      summary: 'Created report branding “Report branding”',
      engagementId: null,
    });
    expect(rows[1]).toMatchObject({
      coalesceKey: 'organizationName',
      changes: [{ kind: 'field', field: 'organizationName', from: 'Block Harbor', to: 'BH Labs' }],
    });
  });

  it('caps a bulk write at AUDIT_BULK_ROW_CAP individual entries plus one summary with the true total', async () => {
    const { eng } = await setup();
    const target = await app.db.engagementTarget.create({
      data: {
        engagementId: eng.id,
        name: 'ECU',
        activities: {
          create: {
            name: 'CAN',
            goals: { create: Array.from({ length: 30 }, (_, i) => ({ title: `Goal ${i}` })) },
          },
        },
      },
      include: { activities: true },
    });
    const activityId = target.activities[0]!.id;
    await truncateAuditLog(app);

    const result = await app.db.activityGoal.updateMany({
      where: { activityId },
      data: { status: 'in_progress' },
    });
    expect(result.count).toBe(30);

    const rows = await entries();
    expect(rows).toHaveLength(AUDIT_BULK_ROW_CAP + 1);
    const individual = rows.filter((r) => r.entityId !== null);
    expect(individual).toHaveLength(AUDIT_BULK_ROW_CAP);
    for (const r of individual) {
      expect(r).toMatchObject({ entityType: 'goal', action: 'update', coalesceKey: 'status' });
    }
    const summary = rows.find((r) => r.entityId === null)!;
    expect(summary).toMatchObject({
      action: 'update',
      entityType: 'goal',
      entityLabel: '30 goals',
      summary: `Updated 30 goals in one operation; the first ${AUDIT_BULK_ROW_CAP} are recorded individually`,
      changes: [{ kind: 'count', label: 'Goals updated', count: 30 }],
      engagementSlug: 'op1',
    });
  });

  it('keeps every entry about a deleted engagement, with the cascade counted on the delete', async () => {
    const { users, eng } = await setup();
    await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'none',
        title: 'CAN dump',
        occurredAt: new Date(),
      },
    });
    const admin = await loginCookie(app, 'admin@test.local', 'password123');
    await truncateAuditLog(app);

    // An earlier entry, written by the backstop outside any request so the case
    // does not depend on what the targets route records by hand.
    await app.db.engagementTarget.create({ data: { engagementId: eng.id, name: 'ECU' } });
    const del = await app.inject({
      method: 'DELETE',
      url: '/web/engagements/op1',
      headers: { ...WEB_HEADERS, cookie: admin },
    });
    expect(del.statusCode).toBe(200);
    expect(await app.db.engagement.count()).toBe(0);

    const rows = await entries();
    expect(rows.map((r) => [r.action, r.entityType])).toEqual([
      ['create', 'target'],
      ['delete', 'engagement'],
    ]);
    // The earlier entry lost its FK to the SET NULL and kept its snapshot.
    expect(rows[0]).toMatchObject({
      engagementId: null,
      engagementSlug: 'op1',
      engagementName: 'Op One',
    });
    // The delete is the route's own entry (routes/web/engagements.ts), written
    // inside the delete's transaction before the row goes — so it too had its
    // FK nulled by the cascade it describes, and reads from the snapshot.
    expect(rows[1]).toMatchObject({
      engagementId: null,
      engagementSlug: 'op1',
      engagementName: 'Op One',
      entityId: String(eng.id),
      entityLabel: 'Op One',
      source: 'intent',
      summary: 'Deleted engagement “Op One” (op1): 1 evidence, 0 findings, 0 reports',
      actorId: users.admin.id,
    });
    expect(rows[1]!.changes).toContainEqual({ kind: 'count', label: 'Evidence', count: 1 });
    expect(rows[1]!.changes).toContainEqual({ kind: 'count', label: 'Reports', count: 0 });
  });

  it('counts the cascade on a direct engagement delete', async () => {
    const { users, eng } = await setup();
    await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'none',
        title: 'CAN dump',
        occurredAt: new Date(),
      },
    });
    await app.db.engagementTarget.create({ data: { engagementId: eng.id, name: 'ECU' } });
    await truncateAuditLog(app);

    // No request, no handler: the backstop describes the delete itself, with
    // the rows the database cascade is about to take counted beforehand.
    await app.db.engagement.delete({ where: { id: eng.id } });

    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'delete',
      entityType: 'engagement',
      engagementId: null,
      engagementSlug: 'op1',
      engagementName: 'Op One',
      entityId: String(eng.id),
      entityLabel: 'Op One',
      source: 'backstop',
      via: 'system',
      summary: 'Deleted engagement “Op One” with 1 evidence, 1 tag, 1 target, 2 members',
    });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Evidence', count: 1 });
    expect(rows[0]!.changes).toContainEqual({ kind: 'count', label: 'Members', count: 2 });
    expect(rows[0]!.changes).toContainEqual({
      kind: 'field',
      field: 'name',
      from: 'Op One',
      to: null,
    });
  });
});

describe('where the backstop stays silent', () => {
  it('skips an unsuppressed write inside a transaction and logs an error naming it', async () => {
    const { eng, tag } = await setup();
    await truncateAuditLog(app);
    const spy = vi.spyOn(app.log, 'error');
    try {
      await app.db.$transaction(async (tx) => {
        await tx.tag.create({ data: { engagementId: eng.id, name: 'tx-tag', colorName: 'blue' } });
      });
      await app.db.$transaction([
        app.db.tag.update({ where: { id: tag.id }, data: { name: 'renamed-in-batch' } }),
      ]);
      expect(await app.db.tag.count()).toBe(2);
      expect(await entries()).toHaveLength(0);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'Tag', operation: 'create', transaction: 'itx' }),
        expect.stringMatching(/withIntent/),
      );
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'Tag', operation: 'update', transaction: 'batch' }),
        expect.stringMatching(/withIntent/),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('stays silent under withIntent for the named models only, and the scope trips when nothing was recorded', async () => {
    const { eng } = await setup();
    await truncateAuditLog(app);

    // Listed model written, nothing recorded: the tripwire (thrown under NODE_ENV=test).
    await expect(
      withIntent(['tag'], () =>
        app.db.tag.create({ data: { engagementId: eng.id, name: 'quiet', colorName: 'blue' } }),
      ),
    ).rejects.toThrow(/wrote tag but recorded nothing/);
    expect(await entries()).toHaveLength(0);

    // Listed model written and an intent entry recorded; an unlisted side-effect
    // write in the same scope still reaches the backstop.
    await withIntent(['tag'], async () => {
      await app.db.tag.create({ data: { engagementId: eng.id, name: 'loud', colorName: 'blue' } });
      await recordAudit(
        auditCtxFromContext(app.db, app.log, { id: eng.id, slug: eng.slug, name: eng.name }),
        {
          action: 'create',
          entityType: 'tag',
          entity: { id: '0', label: 'loud' },
          summary: 'Created tag “loud” by hand',
        },
      );
      await app.db.defaultTag.create({ data: { name: 'side-effect', colorName: 'red' } });
    });
    const rows = await entries();
    expect(rows.map((r) => [r.source, r.entityType])).toEqual([
      ['intent', 'tag'],
      ['backstop', 'default_tag'],
    ]);
  });
});
