import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CANNOT_DELETE_SELF, DEFAULT_REPORT_SECTIONS, LAST_ADMIN_REASON } from '@reporter/shared';
import {
  WEB_HEADERS,
  apiKeyFor,
  buildTestApp,
  loginCookie,
  seedUsers,
  truncateAll,
} from './helpers.js';
import {
  buildFindingsExport,
  buildReportHtml,
  gatherSupportingFiles,
  type JsonExportOptions,
} from '../src/services/findings-report.js';

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

/** The writer is a member of op1; the admin owns the Admin panel. */
async function setup() {
  const users = await seedUsers(app);
  const eng = await app.db.engagement.create({
    data: {
      slug: 'op1',
      name: 'Op One',
      roles: { create: [{ userId: users.writer.id, role: 'write' }] },
    },
  });
  const cookie = await loginCookie(app, 'writer@test.local', 'password123');
  const adminCookie = await loginCookie(app, 'admin@test.local', 'password123');
  return { users, eng, cookie, adminCookie };
}

function makeEvidence(
  engagementId: number,
  operatorId: number,
  fields: Partial<{ title: string; description: string; excludeFromReport: boolean }> = {},
) {
  return app.db.evidence.create({
    data: {
      engagementId,
      operatorId,
      contentType: 'none',
      title: fields.title ?? 'Ev',
      description: fields.description ?? 'body',
      occurredAt: new Date(),
      excludeFromReport: fields.excludeFromReport ?? false,
    },
  });
}

const deleteUser = (adminCookie: string, slug: string) =>
  app.inject({
    method: 'DELETE',
    url: `/web/admin/users/${slug}`,
    headers: { ...WEB_HEADERS, cookie: adminCookie },
  });

describe('deleting a user anonymizes their evidence rather than removing it', () => {
  it('hard-deletes the account but keeps the evidence and comments, authorship nulled', async () => {
    const { users, eng, adminCookie } = await setup();
    const ev = await makeEvidence(eng.id, users.writer.id, { title: 'Captured by Wendy' });
    await app.db.evidenceComment.create({
      data: { evidenceId: ev.id, authorId: users.writer.id, body: 'a remark' },
    });
    await apiKeyFor(app, users.writer.id);

    const res = await deleteUser(adminCookie, users.writer.slug);
    expect(res.statusCode).toBe(200);
    // The counts describe exactly what this delete touched.
    expect(res.json()).toMatchObject({
      ok: true,
      evidence: 1,
      comments: 1,
      engagements: 1,
      apiKeys: 1,
    });

    // The user row is really gone — not merely flagged.
    expect(await app.db.user.findUnique({ where: { id: users.writer.id } })).toBeNull();

    // The evidence is the client deliverable, so it outlives its author.
    const kept = await app.db.evidence.findUniqueOrThrow({ where: { id: ev.id } });
    expect(kept.operatorId).toBeNull();
    expect(kept.title).toBe('Captured by Wendy');
    const comment = await app.db.evidenceComment.findFirstOrThrow({ where: { evidenceId: ev.id } });
    expect(comment.authorId).toBeNull();
    expect(comment.body).toBe('a remark');

    // Everything that only served the account itself goes with it.
    expect(await app.db.apiKey.count({ where: { userId: users.writer.id } })).toBe(0);
    expect(await app.db.userEngagementRole.count({ where: { userId: users.writer.id } })).toBe(0);
  });

  it('serves the anonymized evidence with a null operator instead of failing', async () => {
    const { users, eng, adminCookie } = await setup();
    const ev = await makeEvidence(eng.id, users.writer.id);
    await deleteUser(adminCookie, users.writer.slug);

    // The admin is not a member of op1, so read it as one.
    await app.db.userEngagementRole.create({
      data: { userId: users.admin.id, engagementId: eng.id, role: 'read' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/web/engagements/op1/evidence/${ev.uuid}`,
      headers: { ...WEB_HEADERS, cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    // The serializer must report the gap, not fabricate an operator.
    expect(res.json().operator).toBeNull();
  });

  it('drops the deleted operator from the operator filter list but keeps the evidence listed', async () => {
    const { users, eng, adminCookie } = await setup();
    await makeEvidence(eng.id, users.writer.id);
    await deleteUser(adminCookie, users.writer.slug);
    await app.db.userEngagementRole.create({
      data: { userId: users.admin.id, engagementId: eng.id, role: 'read' },
    });

    const operators = await app
      .inject({
        method: 'GET',
        url: '/web/engagements/op1/evidence/operators',
        headers: { ...WEB_HEADERS, cookie: adminCookie },
      })
      .then((r) => r.json());
    expect(operators).toEqual([]);

    const list = await app
      .inject({
        method: 'GET',
        url: '/web/engagements/op1/evidence',
        headers: { ...WEB_HEADERS, cookie: adminCookie },
      })
      .then((r) => r.json());
    expect(list.total).toBe(1);
  });

  it('frees the email address for a new account', async () => {
    const { users, adminCookie } = await setup();
    await deleteUser(adminCookie, users.writer.slug);
    const res = await app.inject({
      method: 'POST',
      url: '/web/admin/users',
      headers: { ...WEB_HEADERS, cookie: adminCookie },
      payload: {
        firstName: 'Wanda',
        lastName: 'Second',
        email: 'writer@test.local',
        password: 'password123',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses to delete yourself', async () => {
    const { users, adminCookie } = await setup();
    const res = await deleteUser(adminCookie, users.admin.slug);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(CANNOT_DELETE_SELF);
    expect(await app.db.user.findUnique({ where: { id: users.admin.id } })).not.toBeNull();
  });

  it('refuses to let the last admin who can sign in demote or disable themselves', async () => {
    const { users, adminCookie } = await setup();
    const put = (patch: Record<string, unknown>) =>
      app.inject({
        method: 'PUT',
        url: `/web/admin/users/${users.admin.slug}`,
        headers: { ...WEB_HEADERS, cookie: adminCookie },
        payload: patch,
      });

    // Self-demotion is the reachable lockout: deleting someone else can never empty
    // the admin pool, because the caller has to be an admin to make the request.
    // Demoting and disabling are the same lockout by another name.
    for (const patch of [{ admin: false }, { disabled: true }]) {
      const res = await put(patch);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(LAST_ADMIN_REASON);
    }
    const still = await app.db.user.findUniqueOrThrow({ where: { id: users.admin.id } });
    expect(still.admin).toBe(true);
    expect(still.disabled).toBe(false);

    // With a second eligible admin there is no lockout, so it is allowed.
    await app.db.user.update({ where: { id: users.writer.id }, data: { admin: true } });
    expect((await put({ admin: false })).statusCode).toBe(200);
  });

  it('allows the delete once another admin can sign in', async () => {
    const { users, adminCookie } = await setup();
    await app.db.user.update({ where: { id: users.writer.id }, data: { admin: true } });
    const res = await deleteUser(adminCookie, users.writer.slug);
    expect(res.statusCode).toBe(200);
  });

  it('reports the deletion impact and the blocking reason before the click', async () => {
    const { users, eng, adminCookie } = await setup();
    await makeEvidence(eng.id, users.writer.id);
    await apiKeyFor(app, users.writer.id);

    const impact = await app
      .inject({
        method: 'GET',
        url: `/web/admin/users/${users.writer.slug}/impact`,
        headers: { ...WEB_HEADERS, cookie: adminCookie },
      })
      .then((r) => r.json());
    expect(impact).toMatchObject({
      slug: users.writer.slug,
      evidence: 1,
      comments: 0,
      engagements: 1,
      apiKeys: 1,
      canDelete: true,
      blockedReason: null,
    });

    // The admin is both the caller and the last eligible admin.
    const self = await app
      .inject({
        method: 'GET',
        url: `/web/admin/users/${users.admin.slug}/impact`,
        headers: { ...WEB_HEADERS, cookie: adminCookie },
      })
      .then((r) => r.json());
    expect(self).toMatchObject({ canDelete: false, blockedReason: CANNOT_DELETE_SELF });
  });
});

describe('a finding reports its linked-goal count and last-updated time', () => {
  // The Findings page filters and sorts on both, so they have to survive the
  // serializer rather than defaulting to 0 / the created time.
  it('serves numGoals and updatedAt on the findings list', async () => {
    const { eng, cookie } = await setup();
    const finding = await app
      .inject({
        method: 'POST',
        url: '/web/engagements/op1/findings',
        headers: { ...WEB_HEADERS, cookie },
        payload: { title: 'Linked', description: '', category: null },
      })
      .then((r) => r.json());
    expect(finding.numGoals).toBe(0);

    const target = await app.db.engagementTarget.create({
      data: {
        engagementId: eng.id,
        name: 'Gateway',
        activities: { create: { name: 'Probe', goals: { create: { title: 'Reach CAN' } } } },
      },
      include: { activities: { include: { goals: true } } },
    });
    const goalId = target.activities[0]!.goals[0]!.id;
    const link = await app.inject({
      method: 'POST',
      url: `/web/engagements/op1/goals/${goalId}/findings`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { findingUuids: [finding.uuid] },
    });
    expect(link.statusCode).toBe(200);

    const [listed] = await app
      .inject({
        method: 'GET',
        url: '/web/engagements/op1/findings',
        headers: { ...WEB_HEADERS, cookie },
      })
      .then((r) => r.json());
    expect(listed.numGoals).toBe(1);
    expect(listed.updatedAt).toEqual(expect.any(String));
  });
});

describe('excludeFromReport keeps evidence in the app but out of every report output', () => {
  /** A finding with two evidence items attached, one of them report-excluded. */
  async function seedExcluded() {
    const { users, eng, cookie, adminCookie } = await setup();
    const shown = await makeEvidence(eng.id, users.writer.id, {
      title: 'Shown evidence',
      description: 'visible-in-report',
    });
    const hidden = await makeEvidence(eng.id, users.writer.id, {
      title: 'Secret evidence',
      description: 'must-never-appear',
      excludeFromReport: true,
    });
    const finding = await app
      .inject({
        method: 'POST',
        url: '/web/engagements/op1/findings',
        headers: { ...WEB_HEADERS, cookie },
        payload: { title: 'F', description: '', category: null },
      })
      .then((r) => r.json());
    await app.inject({
      method: 'POST',
      url: `/web/engagements/op1/findings/${finding.uuid}/evidence`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { evidenceUuids: [shown.uuid, hidden.uuid] },
    });
    return { users, eng, cookie, adminCookie, shown, hidden, finding };
  }

  it('stays fully visible in the app, flagged, so it can be un-excluded', async () => {
    const { cookie, hidden } = await seedExcluded();
    const list = await app
      .inject({
        method: 'GET',
        url: '/web/engagements/op1/evidence',
        headers: { ...WEB_HEADERS, cookie },
      })
      .then((r) => r.json());
    // Both items are listed — the Evidence tab never hides excluded evidence.
    expect(list.total).toBe(2);

    const detail = await app
      .inject({
        method: 'GET',
        url: `/web/engagements/op1/evidence/${hidden.uuid}`,
        headers: { ...WEB_HEADERS, cookie },
      })
      .then((r) => r.json());
    expect(detail.excludeFromReport).toBe(true);
  });

  it('is toggled off and back on through the evidence update route', async () => {
    const { cookie, hidden } = await seedExcluded();
    const put = (excludeFromReport: boolean) =>
      app.inject({
        method: 'PUT',
        url: `/web/engagements/op1/evidence/${hidden.uuid}`,
        headers: { ...WEB_HEADERS, cookie },
        payload: { excludeFromReport },
      });
    expect((await put(false)).json().excludeFromReport).toBe(false);
    expect((await put(true)).json().excludeFromReport).toBe(true);

    // An unrelated patch must leave the flag alone rather than reset it.
    const other = await app
      .inject({
        method: 'PUT',
        url: `/web/engagements/op1/evidence/${hidden.uuid}`,
        headers: { ...WEB_HEADERS, cookie },
        payload: { title: 'Renamed' },
      })
      .then((r) => r.json());
    expect(other.excludeFromReport).toBe(true);
  });

  it('is omitted from the JSON export, which therefore carries no flagged evidence', async () => {
    const { eng, hidden, shown } = await seedExcluded();
    const exported = await buildFindingsExport(app, eng, new Date(), { includeAll: true });
    const uuids = exported.findings.flatMap((f) => f.evidence.map((e) => e.uuid));
    expect(uuids).toContain(shown.uuid);
    expect(uuids).not.toContain(hidden.uuid);
    expect(JSON.stringify(exported)).not.toContain('must-never-appear');

    // The default export carries the flag it read, and it read `false` for
    // everything — excluded evidence is simply absent. Getting it into a file at
    // all takes the explicit opt-in (see the backup-export suite below).
    await app.db.evidence.update({ where: { id: shown.id }, data: { excludeFromReport: true } });
    const withFlag = await buildFindingsExport(app, eng, new Date(), { includeAll: true });
    // `shown` is now excluded too, so nothing is left to export...
    expect(withFlag.findings.flatMap((f) => f.evidence)).toEqual([]);
  });

  it('is omitted from the supporting-files ZIP set', async () => {
    const { users, eng } = await setup();
    // `sha256`/`sizeBytes` are stored at upload for real evidence; without them the
    // gather would read the blob and skip the row, masking what this test asserts.
    const file = (title: string, blobKey: string, excludeFromReport: boolean) =>
      app.db.evidence.create({
        data: {
          engagementId: eng.id,
          operatorId: users.writer.id,
          contentType: 'codeblock',
          title,
          description: '',
          occurredAt: new Date(),
          fullBlobKey: blobKey,
          sha256: 'a'.repeat(64),
          sizeBytes: 12,
          excludeFromReport,
        },
      });
    await file('Kept file', 'blob/keep', false);
    await file('Excluded file', 'blob/secret', true);

    const files = await gatherSupportingFiles(app, eng);
    // Only the kept blob is bundled, hashed and listed in "Files Attached".
    expect(files.map((f) => f.blobKey)).toEqual(['blob/keep']);
  });

  it('never prints "No evidence attached." when evidence was filtered out', async () => {
    const { users, eng, cookie } = await setup();
    const hidden = await makeEvidence(eng.id, users.writer.id, {
      title: 'Secret evidence',
      description: 'must-never-appear',
      excludeFromReport: true,
    });
    const finding = await app
      .inject({
        method: 'POST',
        url: '/web/engagements/op1/findings',
        headers: { ...WEB_HEADERS, cookie },
        payload: { title: 'Lonely finding', description: '', category: null },
      })
      .then((r) => r.json());
    await app.inject({
      method: 'POST',
      url: `/web/engagements/op1/findings/${finding.uuid}/evidence`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { evidenceUuids: [hidden.uuid] },
    });

    const html = await buildReportHtml(app, eng, new Date(), { includeAll: true }, users.writer.id);
    expect(html).toContain('Lonely finding');
    // The excluded evidence leaks nowhere...
    expect(html).not.toContain('must-never-appear');
    expect(html).not.toContain('Secret evidence');
    // ...and the report stays silent rather than asserting something false in a
    // signed client deliverable: this finding does have evidence.
    expect(html).not.toContain('No evidence attached.');
  });

  it('renumbers attack path steps contiguously around an excluded step', async () => {
    const { users, eng, cookie } = await setup();
    const steps = [];
    for (const [i, excluded] of [false, true, false].entries()) {
      steps.push(
        await makeEvidence(eng.id, users.writer.id, {
          title: `Stage ${i + 1} capture`,
          description: `step-body-${i + 1}`,
          excludeFromReport: excluded,
        }),
      );
    }
    const finding = await app
      .inject({
        method: 'POST',
        url: '/web/engagements/op1/findings',
        headers: { ...WEB_HEADERS, cookie },
        payload: { title: 'Path finding', description: '', category: null },
      })
      .then((r) => r.json());
    await app.inject({
      method: 'POST',
      url: `/web/engagements/op1/findings/${finding.uuid}/evidence`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { evidenceUuids: steps.map((s) => s.uuid), inPath: true },
    });

    const html = await buildReportHtml(app, eng, new Date(), { includeAll: true }, users.writer.id);
    expect(html).not.toContain('step-body-2');
    // Two surviving steps, numbered 1 and 2 — a gap would advertise the omission.
    expect(html).toContain('Step 1');
    expect(html).toContain('Step 2');
    expect(html).not.toContain('Step 3');
  });

  it('leaves excluded evidence out of the report evidence count', async () => {
    const { users, eng } = await setup();
    await makeEvidence(eng.id, users.writer.id, { title: 'Counted' });
    await makeEvidence(eng.id, users.writer.id, { title: 'Uncounted', excludeFromReport: true });
    const html = await buildReportHtml(app, eng, new Date(), { includeAll: true }, users.writer.id);
    // Both print sites quote the count the report can actually show.
    expect(html).toContain('<div class="k">Evidence</div><div class="v mono">1</div>');
    expect(html).toContain('<div class="k">Total evidence</div><div class="v">1</div>');
  });
});

describe('a backup export can opt in to carrying report-excluded evidence', () => {
  /**
   * A finding with two evidence items, both with stored content, one of them
   * report-excluded. Content matters here: an import can only recreate evidence
   * from an embedded copy, so a backup is only a backup with `contentBase64`.
   */
  async function seedBackup() {
    const { users, eng, cookie } = await setup();
    const withContent = async (title: string, description: string, excludeFromReport: boolean) => {
      const body = Buffer.from(`${description}\n`);
      const blobKey = `backup/${title.replace(/\s+/g, '-').toLowerCase()}`;
      await app.blobs.put(blobKey, body);
      return app.db.evidence.create({
        data: {
          engagementId: eng.id,
          operatorId: users.writer.id,
          contentType: 'codeblock',
          title,
          description,
          occurredAt: new Date(),
          fullBlobKey: blobKey,
          // Stored at upload for real evidence; without them `gatherSupportingFiles`
          // would read the blob instead of trusting the row.
          sha256: 'b'.repeat(64),
          sizeBytes: body.length,
          excludeFromReport,
        },
      });
    };
    const shown = await withContent('Shown capture', 'visible-in-report', false);
    const hidden = await withContent('Secret capture', 'must-never-appear', true);
    const finding = await app
      .inject({
        method: 'POST',
        url: '/web/engagements/op1/findings',
        headers: { ...WEB_HEADERS, cookie },
        payload: { title: 'Backup finding', description: '', category: null },
      })
      .then((r) => r.json());
    await app.inject({
      method: 'POST',
      url: `/web/engagements/op1/findings/${finding.uuid}/evidence`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { evidenceUuids: [shown.uuid, hidden.uuid] },
    });
    return { users, eng, cookie, shown, hidden, finding };
  }

  /** The export route, with everything a backup needs except the opt-in. */
  const BACKUP_QUERY = 'includeAll=true&includeEvidenceContent=true';
  const exportJson = (cookie: string, query: string) =>
    app
      .inject({
        method: 'GET',
        url: `/web/engagements/op1/findings/export.json?${query}`,
        headers: { ...WEB_HEADERS, cookie },
      })
      .then((r) => r.json());

  it('omits excluded evidence by default, even from a content-embedding export', async () => {
    const { cookie, shown, hidden } = await seedBackup();
    const data = await exportJson(cookie, BACKUP_QUERY);
    const evidence = data.findings.flatMap((f: { evidence: unknown[] }) => f.evidence);
    expect(evidence.map((e: { uuid: string }) => e.uuid)).toEqual([shown.uuid]);
    // Neither the metadata nor the embedded bytes of the excluded item are present.
    expect(JSON.stringify(data)).not.toContain('must-never-appear');
    expect(JSON.stringify(data)).not.toContain('Secret capture');
    expect(evidence.every((e: { excludeFromReport: boolean }) => !e.excludeFromReport)).toBe(true);
    expect(hidden.excludeFromReport).toBe(true); // it really is flagged in the DB
  });

  it('includes it, flagged, when the caller explicitly asks for a backup', async () => {
    const { cookie, shown, hidden } = await seedBackup();
    const data = await exportJson(cookie, `${BACKUP_QUERY}&includeExcludedEvidence=true`);
    const evidence = data.findings.flatMap(
      (f: { evidence: { uuid: string; excludeFromReport: boolean; contentBase64?: string }[] }) =>
        f.evidence,
    );
    const byUuid = new Map(evidence.map((e: { uuid: string }) => [e.uuid, e]));
    expect([...byUuid.keys()].sort()).toEqual([shown.uuid, hidden.uuid].sort());
    // The flag states what the row says, which is the whole point of the mode.
    expect(byUuid.get(hidden.uuid)!.excludeFromReport).toBe(true);
    expect(byUuid.get(shown.uuid)!.excludeFromReport).toBe(false);
    // And it is a real backup: the bytes travel with it.
    expect(Buffer.from(byUuid.get(hidden.uuid)!.contentBase64!, 'base64').toString()).toBe(
      'must-never-appear\n',
    );
  });

  it('round-trips: importing a backup restores the evidence AND its exclusion', async () => {
    const { cookie, shown, hidden } = await seedBackup();
    const backup = await exportJson(cookie, `${BACKUP_QUERY}&includeExcludedEvidence=true`);

    // Import into a clean target, standing in for another server.
    await truncateAll(app);
    const { cookie: cookie2 } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/web/engagements/op1/findings/import',
      headers: { ...WEB_HEADERS, cookie: cookie2 },
      payload: backup,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ findingsCreated: 1, evidenceCreated: 2 });

    // The exclusion survived: without this the round trip would quietly re-admit
    // the evidence to every report output on the target server.
    const restored = await app.db.evidence.findUniqueOrThrow({ where: { uuid: hidden.uuid } });
    expect(restored.excludeFromReport).toBe(true);
    expect(restored.description).toBe('must-never-appear');
    const kept = await app.db.evidence.findUniqueOrThrow({ where: { uuid: shown.uuid } });
    expect(kept.excludeFromReport).toBe(false);

    // The restored flag is live, not just a stored column: the target server's own
    // default export leaves the evidence out again.
    const reexported = await exportJson(cookie2, BACKUP_QUERY);
    expect(JSON.stringify(reexported)).not.toContain('must-never-appear');
  });

  it('leaves an existing local row’s flag alone on import', async () => {
    const { cookie, hidden } = await seedBackup();
    const backup = await exportJson(cookie, `${BACKUP_QUERY}&includeExcludedEvidence=true`);
    // The operator un-excludes it locally, then re-imports the older backup.
    await app.db.evidence.update({
      where: { uuid: hidden.uuid },
      data: { excludeFromReport: false },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/web/engagements/op1/findings/import',
      headers: { ...WEB_HEADERS, cookie },
      payload: backup,
    });
    expect(res.statusCode).toBe(200);
    // Import only re-links evidence that already exists; the live decision about an
    // existing item belongs to the operator who made it, not to the file.
    const row = await app.db.evidence.findUniqueOrThrow({ where: { uuid: hidden.uuid } });
    expect(row.excludeFromReport).toBe(false);
  });

  it('is inert on the report-rendering paths, even when smuggled in as options', async () => {
    const { users, eng } = await seedBackup();
    // Typed as the JSON-export options and passed where report options are taken —
    // exactly the mistake the separate `gather` scope parameter exists to defuse.
    // `buildReportHtml` cannot read the field, so the PDF is unchanged.
    const smuggled: JsonExportOptions = { includeAll: true, includeExcludedEvidence: true };
    const html = await buildReportHtml(app, eng, new Date(), smuggled, users.writer.id);
    expect(html).toContain('Backup finding');
    expect(html).not.toContain('must-never-appear');
    expect(html).not.toContain('Secret capture');
    // ...and the ZIP's supporting files are gathered without options at all.
    const files = await gatherSupportingFiles(app, eng);
    expect(files.map((f) => f.blobKey)).toEqual(['backup/shown-capture']);
  });
});

describe('a report-filtered export cannot detach the links it was never allowed to describe', () => {
  /**
   * A finding with a two-step Attack Path whose second step is report-excluded.
   * Captions and positions matter here: for a path step the *link* is the content,
   * so losing it loses the step even though the evidence row survives.
   */
  async function seedPath() {
    const { users, eng, cookie } = await setup();
    const step = async (title: string, description: string, excludeFromReport: boolean) => {
      const body = Buffer.from(`${description}\n`);
      const blobKey = `path/${title.replace(/\s+/g, '-').toLowerCase()}`;
      await app.blobs.put(blobKey, body);
      return app.db.evidence.create({
        data: {
          engagementId: eng.id,
          operatorId: users.writer.id,
          contentType: 'codeblock',
          title,
          description,
          occurredAt: new Date(),
          fullBlobKey: blobKey,
          sha256: 'c'.repeat(64),
          sizeBytes: body.length,
          excludeFromReport,
        },
      });
    };
    const shown = await step('Shown step', 'visible-in-report', false);
    const hidden = await step('Secret step', 'must-never-appear', true);
    const finding = await app
      .inject({
        method: 'POST',
        url: '/web/engagements/op1/findings',
        headers: { ...WEB_HEADERS, cookie },
        payload: { title: 'Path finding', description: '', category: null },
      })
      .then((r) => r.json());
    await app.inject({
      method: 'POST',
      url: `/web/engagements/op1/findings/${finding.uuid}/evidence`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { evidenceUuids: [shown.uuid, hidden.uuid], inPath: true },
    });
    // Captions are authored per link; set them directly rather than driving the
    // caption route, which is not what these tests are about.
    await app.db.evidenceFinding.updateMany({
      where: { evidenceId: hidden.id },
      data: { caption: 'step two (secret)' },
    });
    return { users, eng, cookie, shown, hidden, finding };
  }

  const DEFAULT_QUERY = 'includeAll=true&includeEvidenceContent=true';
  const exportJson = (cookie: string, query: string) =>
    app
      .inject({
        method: 'GET',
        url: `/web/engagements/op1/findings/export.json?${query}`,
        headers: { ...WEB_HEADERS, cookie },
      })
      .then((r) => r.json());
  const importJson = (cookie: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/web/engagements/op1/findings/import',
      headers: { ...WEB_HEADERS, cookie },
      payload,
    });
  /** The finding's links, as `uuid inPath position caption`, path bucket first. */
  async function linksOf(findingUuid: string) {
    const rows = await app.db.evidenceFinding.findMany({
      where: { finding: { uuid: findingUuid } },
      include: { evidence: { select: { uuid: true } } },
      orderBy: [{ inPath: 'desc' }, { position: 'asc' }],
    });
    return rows.map((r) => `${r.evidence.uuid} ${r.inPath} ${r.position} ${r.caption}`);
  }

  it('keeps the excluded step attached when a default export is re-imported', async () => {
    const { cookie, shown, hidden, finding } = await seedPath();
    const before = await linksOf(finding.uuid);
    // The deliverable export: it cannot mention the excluded step at all.
    const filtered = await exportJson(cookie, DEFAULT_QUERY);
    expect(JSON.stringify(filtered)).not.toContain('must-never-appear');
    expect(filtered.includesExcludedEvidence).toBe(false);

    const res = await importJson(cookie, filtered);
    expect(res.statusCode).toBe(200);

    // Both links survive, with the hidden step's bucket, position and caption
    // intact: a file that could not describe the link does not get to delete it.
    expect(await linksOf(finding.uuid)).toEqual(before);
    expect(await linksOf(finding.uuid)).toEqual([
      `${shown.uuid} true 0 `,
      `${hidden.uuid} true 1 step two (secret)`,
    ]);
  });

  it('keeps them when every one of a finding’s evidence items is excluded', async () => {
    const { cookie, hidden, finding, shown } = await seedPath();
    // Now nothing on the finding is exportable, so the file lists no evidence —
    // the "delete every link" branch of the converge step.
    await app.db.evidence.update({ where: { id: shown.id }, data: { excludeFromReport: true } });
    const filtered = await exportJson(cookie, DEFAULT_QUERY);
    expect(filtered.findings.flatMap((f: { evidence: unknown[] }) => f.evidence)).toEqual([]);

    expect((await importJson(cookie, filtered)).statusCode).toBe(200);
    expect(await linksOf(finding.uuid)).toEqual([
      `${shown.uuid} true 0 `,
      `${hidden.uuid} true 1 step two (secret)`,
    ]);
  });

  it('still detaches report-visible evidence the file dropped', async () => {
    const { cookie, shown, hidden, finding } = await seedPath();
    const filtered = await exportJson(cookie, DEFAULT_QUERY);
    // The operator edits the export, removing the step they no longer want.
    filtered.findings[0].evidence = [];

    expect((await importJson(cookie, filtered)).statusCode).toBe(200);
    // Convergence still works — it is only the links the file *couldn't* describe
    // that are protected.
    const links = await linksOf(finding.uuid);
    expect(links.some((l) => l.startsWith(shown.uuid))).toBe(false);
    expect(links.some((l) => l.startsWith(hidden.uuid))).toBe(true);
  });

  it('lets a backup export detach excluded evidence, because it does describe it', async () => {
    const { cookie, shown, hidden, finding } = await seedPath();
    const backup = await exportJson(cookie, `${DEFAULT_QUERY}&includeExcludedEvidence=true`);
    expect(backup.includesExcludedEvidence).toBe(true);
    // Drop the excluded step from a file that was allowed to carry it: its removal
    // is a real removal.
    backup.findings[0].evidence = backup.findings[0].evidence.filter(
      (e: { uuid: string }) => e.uuid !== hidden.uuid,
    );

    expect((await importJson(cookie, backup)).statusCode).toBe(200);
    expect(await linksOf(finding.uuid)).toEqual([`${shown.uuid} true 0 `]);
  });

  it('stamps the newer schema version only on a file that carries excluded evidence', async () => {
    const { cookie } = await seedPath();
    // A pre-exclusion server accepts v3 and silently strips the flag, so only the
    // file that would actually be mishandled there gets the stamp it must reject.
    expect((await exportJson(cookie, DEFAULT_QUERY)).schemaVersion).toBe(3);
    expect(
      (await exportJson(cookie, `${DEFAULT_QUERY}&includeExcludedEvidence=true`)).schemaVersion,
    ).toBe(4);
  });

  it('implies evidence content when asked for excluded evidence', async () => {
    const { cookie, hidden } = await seedPath();
    // Without the bytes the file would leak the excluded item's metadata while
    // being unable to restore it — the sensitive half of the trade on its own.
    const data = await exportJson(cookie, 'includeAll=true&includeExcludedEvidence=true');
    const item = data.findings
      .flatMap((f: { evidence: { uuid: string; contentBase64?: string }[] }) => f.evidence)
      .find((e: { uuid: string }) => e.uuid === hidden.uuid);
    expect(Buffer.from(item.contentBase64, 'base64').toString()).toBe('must-never-appear\n');
  });
});

describe('report exclusion is inherited by linked evidence', () => {
  /**
   * An excluded parent capture with an unflagged follow-up (linked evidence) under
   * it, the follow-up attached to a finding. The report renders linked evidence
   * standalone, so without inheritance the child ships as a fragment of a capture
   * the operator withheld.
   */
  async function seedParentChild() {
    const { users, eng, cookie } = await setup();
    const capture = async (
      title: string,
      description: string,
      extra: { excludeFromReport?: boolean; parentEvidenceId?: number } = {},
    ) => {
      const body = Buffer.from(`${description}\n`);
      const blobKey = `inherit/${title.replace(/\s+/g, '-').toLowerCase()}`;
      await app.blobs.put(blobKey, body);
      return app.db.evidence.create({
        data: {
          engagementId: eng.id,
          operatorId: users.writer.id,
          contentType: 'codeblock',
          title,
          description,
          occurredAt: new Date(),
          fullBlobKey: blobKey,
          sha256: 'd'.repeat(64),
          sizeBytes: body.length,
          excludeFromReport: extra.excludeFromReport ?? false,
          parentEvidenceId: extra.parentEvidenceId,
        },
      });
    };
    const parent = await capture('Secret capture', 'parent-must-never-appear', {
      excludeFromReport: true,
    });
    const child = await capture('Follow-up capture', 'child-must-never-appear', {
      parentEvidenceId: parent.id,
    });
    const finding = await app
      .inject({
        method: 'POST',
        url: '/web/engagements/op1/findings',
        headers: { ...WEB_HEADERS, cookie },
        payload: { title: 'Inherit finding', description: '', category: null },
      })
      .then((r) => r.json());
    await app.inject({
      method: 'POST',
      url: `/web/engagements/op1/findings/${finding.uuid}/evidence`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { evidenceUuids: [child.uuid] },
    });
    return { users, eng, cookie, parent, child, finding };
  }

  it('keeps the child out of the supporting-files ZIP and the PDF', async () => {
    const { users, eng, child } = await seedParentChild();
    const files = await gatherSupportingFiles(app, eng);
    // Neither the parent's bytes nor the child's are bundled or hashed.
    expect(files).toEqual([]);

    const html = await buildReportHtml(app, eng, new Date(), { includeAll: true }, users.writer.id);
    expect(html).toContain('Inherit finding');
    expect(html).not.toContain('parent-must-never-appear');
    expect(html).not.toContain('child-must-never-appear');
    expect(html).not.toContain('Follow-up capture');
    // The finding does have evidence, so the report stays silent rather than
    // asserting it has none.
    expect(html).not.toContain('No evidence attached.');
    expect(child.excludeFromReport).toBe(false); // the child's own flag is clear
  });

  it('keeps the child out of a curated timeline subsection that includes comments', async () => {
    const { users, eng } = await seedParentChild();
    await app.db.engagement.update({
      where: { id: eng.id },
      data: {
        executionNarrative: [
          {
            kind: 'timeline',
            title: 'Execution timeline',
            body: '',
            evidence: [],
            // The subsection asks for linked evidence explicitly — the report
            // exclusion is layered on top of the author's filters, not expressed
            // through them.
            timeline: {
              tags: [],
              types: [],
              group: 'chronological',
              includeComments: true,
              starredOnly: false,
            },
          },
        ],
      },
    });
    const html = await buildReportHtml(app, eng, new Date(), { includeAll: true }, users.writer.id);
    expect(html).toContain('Execution timeline');
    expect(html).not.toContain('child-must-never-appear');
    expect(html).not.toContain('parent-must-never-appear');
  });

  it('leaves the child out of a goal’s report coverage count', async () => {
    const { users, eng, cookie, child } = await seedParentChild();
    const target = await app.db.engagementTarget.create({
      data: { engagementId: eng.id, name: 'Fleet API', description: '' },
    });
    const activity = await app.db.targetActivity.create({
      data: { targetId: target.id, name: 'REST API' },
    });
    const goal = await app.db.activityGoal.create({
      data: { activityId: activity.id, title: 'Authentication' },
    });
    await app.db.goalEvidence.create({ data: { goalId: goal.id, evidenceId: child.id } });

    // Scope & Objectives Coverage ships disabled, so turn it on for this report.
    const sections = DEFAULT_REPORT_SECTIONS.map((s) =>
      s.key === 'scopeCoverage' ? { ...s, enabled: true } : s,
    );
    const html = await buildReportHtml(
      app,
      eng,
      new Date(),
      { includeAll: true, sections },
      users.writer.id,
    );
    // Scope & Objectives prints "Findings / Evidence": counting the child would
    // point the reader at an item that appears nowhere in the document.
    expect(html).toContain('<td>Authentication</td>');
    expect(html).toContain('<td class="num">0 / 0</td>');
    // The interactive Goals page still shows the true total.
    const tree = await app
      .inject({
        method: 'GET',
        url: '/web/engagements/op1/goals',
        headers: { ...WEB_HEADERS, cookie },
      })
      .then((r) => r.json());
    expect(tree.targets[0].activities[0].goals[0].numEvidence).toBe(1);
  });

  it('omits the child from the default export and restores its exclusion from a backup', async () => {
    const { cookie, child } = await seedParentChild();
    const exportJson = (query: string) =>
      app
        .inject({
          method: 'GET',
          url: `/web/engagements/op1/findings/export.json?${query}`,
          headers: { ...WEB_HEADERS, cookie },
        })
        .then((r) => r.json());

    const filtered = await exportJson('includeAll=true&includeEvidenceContent=true');
    expect(JSON.stringify(filtered)).not.toContain('child-must-never-appear');

    const backup = await exportJson(
      'includeAll=true&includeEvidenceContent=true&includeExcludedEvidence=true',
    );
    const item = backup.findings
      .flatMap((f: { evidence: { uuid: string; excludeFromReport: boolean }[] }) => f.evidence)
      .find((e: { uuid: string }) => e.uuid === child.uuid);
    // The export carries no parent links, so it states the child's *effective*
    // exclusion — otherwise a restore would re-admit it to the target's reports.
    expect(item.excludeFromReport).toBe(true);

    await truncateAll(app);
    const { cookie: cookie2 } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/web/engagements/op1/findings/import',
      headers: { ...WEB_HEADERS, cookie: cookie2 },
      payload: backup,
    });
    expect(res.statusCode).toBe(200);
    const restored = await app.db.evidence.findUniqueOrThrow({ where: { uuid: child.uuid } });
    expect(restored.excludeFromReport).toBe(true);
  });
});
