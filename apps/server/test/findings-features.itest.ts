import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RecommendationItem } from '@reporter/shared';
import { WEB_HEADERS, buildTestApp, loginCookie, seedUsers, truncateAll } from './helpers.js';

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
  await app.db.engagement.create({
    data: {
      slug: 'op1',
      name: 'Op One',
      roles: { create: [{ userId: users.writer.id, role: 'write' }] },
    },
  });
  const cookie = await loginCookie(app, 'writer@test.local', 'password123');
  return { users, cookie };
}

function createFinding(cookie: string, title: string) {
  return app
    .inject({
      method: 'POST',
      url: '/web/engagements/op1/findings',
      headers: { ...WEB_HEADERS, cookie },
      payload: { title, description: '', category: null },
    })
    .then((r) => r.json());
}

function update(cookie: string, uuid: string, patch: Record<string, unknown>) {
  return app.inject({
    method: 'PUT',
    url: `/web/engagements/op1/findings/${uuid}`,
    headers: { ...WEB_HEADERS, cookie },
    payload: patch,
  });
}

describe('finding severity + CVSS', () => {
  it('derives score and severity from a CVSS vector (server is the source of truth)', async () => {
    const { cookie } = await setup();
    const f = await createFinding(cookie, 'RCE');
    const res = await update(cookie, f.uuid, {
      // Deliberately unordered metrics — the server normalizes.
      cvssVector: 'CVSS:3.1/S:U/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cvssScore).toBe(9.8);
    expect(body.severity).toBe('critical');
    expect(body.cvssVector).toBe('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
  });

  it('accepts a manual severity and clears a previously-set vector', async () => {
    const { cookie } = await setup();
    const f = await createFinding(cookie, 'Info leak');
    await update(cookie, f.uuid, { cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' });
    const res = await update(cookie, f.uuid, { severity: 'low', cvssVector: null });
    const body = res.json();
    expect(body.severity).toBe('low');
    expect(body.cvssVector).toBeNull();
    expect(body.cvssScore).toBeNull();
  });

  it('rejects an invalid CVSS vector', async () => {
    const { cookie } = await setup();
    const f = await createFinding(cookie, 'Bad');
    const res = await update(cookie, f.uuid, { cvssVector: 'not-a-vector' });
    expect(res.statusCode).toBe(400);
  });

  it('a bare severity update clears any stored CVSS vector and score', async () => {
    const { cookie } = await setup();
    const f = await createFinding(cookie, 'Drift');
    await update(cookie, f.uuid, { cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' });
    // Send ONLY severity (no cvssVector field) — must not leave a stale vector.
    const res = await update(cookie, f.uuid, { severity: 'low' });
    const body = res.json();
    expect(body.severity).toBe('low');
    expect(body.cvssVector).toBeNull();
    expect(body.cvssScore).toBeNull();
  });
});

describe('finding ordering', () => {
  it('appends new findings and reorders them', async () => {
    const { cookie } = await setup();
    const a = await createFinding(cookie, 'A');
    const b = await createFinding(cookie, 'B');
    const c = await createFinding(cookie, 'C');
    expect(b.position).toBeGreaterThan(a.position);
    expect(c.position).toBeGreaterThan(b.position);

    const res = await app.inject({
      method: 'PATCH',
      url: '/web/engagements/op1/findings/reorder',
      headers: { ...WEB_HEADERS, cookie },
      payload: { orderedUuids: [c.uuid, a.uuid, b.uuid] },
    });
    expect(res.statusCode).toBe(200);

    const list = (
      await app.inject({ method: 'GET', url: '/web/engagements/op1/findings', headers: { cookie } })
    ).json();
    expect(list.map((f: { title: string }) => f.title)).toEqual(['C', 'A', 'B']);
  });

  it('rejects a reorder that references a foreign finding', async () => {
    const { cookie } = await setup();
    const a = await createFinding(cookie, 'A');
    await createFinding(cookie, 'B');
    const res = await app.inject({
      method: 'PATCH',
      url: '/web/engagements/op1/findings/reorder',
      headers: { ...WEB_HEADERS, cookie },
      payload: { orderedUuids: [a.uuid, '00000000-0000-0000-0000-000000000000'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a reorder that omits some findings (would collide positions)', async () => {
    const { cookie } = await setup();
    const a = await createFinding(cookie, 'A');
    await createFinding(cookie, 'B');
    const res = await app.inject({
      method: 'PATCH',
      url: '/web/engagements/op1/findings/reorder',
      headers: { ...WEB_HEADERS, cookie },
      payload: { orderedUuids: [a.uuid] }, // omits B
    });
    expect(res.statusCode).toBe(400);
  });

  it('reorders evidence attached to a finding', async () => {
    const { users, cookie } = await setup();
    const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug: 'op1' } });
    const mkEvidence = (desc: string) =>
      app.db.evidence.create({
        data: {
          engagementId: eng.id,
          operatorId: users.writer.id,
          contentType: 'none',
          description: desc,
          occurredAt: new Date(),
        },
      });
    const e1 = await mkEvidence('first');
    const e2 = await mkEvidence('second');
    const f = await createFinding(cookie, 'F');
    await app.inject({
      method: 'POST',
      url: `/web/engagements/op1/findings/${f.uuid}/evidence`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { evidenceUuids: [e1.uuid, e2.uuid] },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/web/engagements/op1/findings/${f.uuid}/evidence/reorder`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { orderedUuids: [e2.uuid, e1.uuid] },
    });
    expect(res.statusCode).toBe(200);

    const detail = (
      await app.inject({
        method: 'GET',
        url: `/web/engagements/op1/findings/${f.uuid}`,
        headers: { cookie },
      })
    ).json();
    expect(detail.evidence.map((e: { description: string }) => e.description)).toEqual([
      'second',
      'first',
    ]);
  });
});

describe('finding evidence buckets (attack path + attached evidence)', () => {
  async function seedEvidence(n: number) {
    const { users, cookie } = await setup();
    const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug: 'op1' } });
    const evidence = [];
    for (let i = 0; i < n; i++) {
      evidence.push(
        await app.db.evidence.create({
          data: {
            engagementId: eng.id,
            operatorId: users.writer.id,
            contentType: 'none',
            description: `ev${i}`,
            occurredAt: new Date(),
          },
        }),
      );
    }
    return { cookie, evidence };
  }

  const attach = (
    cookie: string,
    fUuid: string,
    evidenceUuids: string[],
    inPath?: boolean,
  ) =>
    app.inject({
      method: 'POST',
      url: `/web/engagements/op1/findings/${fUuid}/evidence`,
      headers: { ...WEB_HEADERS, cookie },
      payload: inPath === undefined ? { evidenceUuids } : { evidenceUuids, inPath },
    });

  const getDetail = (cookie: string, fUuid: string) =>
    app
      .inject({
        method: 'GET',
        url: `/web/engagements/op1/findings/${fUuid}`,
        headers: { cookie },
      })
      .then((r) => r.json());

  it('defaults new evidence to the attached bucket (inPath=false) and exposes caption+inPath in detail', async () => {
    const { cookie, evidence } = await seedEvidence(2);
    const f = await createFinding(cookie, 'F');
    await attach(cookie, f.uuid, [evidence[0]!.uuid, evidence[1]!.uuid]);

    const detail = await getDetail(cookie, f.uuid);
    expect(detail.evidence).toHaveLength(2);
    for (const e of detail.evidence) {
      expect(e).toHaveProperty('caption', '');
      expect(e).toHaveProperty('inPath', false);
    }
  });

  it('attaches into the attack-path bucket when inPath=true; detail lists attack path first', async () => {
    const { cookie, evidence } = await seedEvidence(3);
    const f = await createFinding(cookie, 'F');
    // ev0 attached (default), ev1 + ev2 into the path.
    await attach(cookie, f.uuid, [evidence[0]!.uuid], false);
    await attach(cookie, f.uuid, [evidence[1]!.uuid, evidence[2]!.uuid], true);

    const detail = await getDetail(cookie, f.uuid);
    // Attack path (inPath=true) comes first, then attached, each in its own order.
    expect(detail.evidence.map((e: { description: string }) => e.description)).toEqual([
      'ev1',
      'ev2',
      'ev0',
    ]);
    expect(detail.evidence.map((e: { inPath: boolean }) => e.inPath)).toEqual([true, true, false]);

    // Positions are per-bucket: the path bucket starts at 0.
    const pathLinks = await app.db.evidenceFinding.findMany({
      where: { finding: { uuid: f.uuid }, inPath: true },
      orderBy: { position: 'asc' },
    });
    expect(pathLinks.map((l) => l.position)).toEqual([0, 1]);
  });

  it('PATCH sets a caption on an evidence link', async () => {
    const { cookie, evidence } = await seedEvidence(1);
    const f = await createFinding(cookie, 'F');
    await attach(cookie, f.uuid, [evidence[0]!.uuid], true);

    const res = await app.inject({
      method: 'PATCH',
      url: `/web/engagements/op1/findings/${f.uuid}/evidence/${evidence[0]!.uuid}`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { caption: 'Gained a foothold via SSRF' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ caption: 'Gained a foothold via SSRF', inPath: true });

    const detail = await getDetail(cookie, f.uuid);
    expect(detail.evidence[0].caption).toBe('Gained a foothold via SSRF');
  });

  it('PATCH moves an evidence link between buckets, appending to the end of the target', async () => {
    const { cookie, evidence } = await seedEvidence(3);
    const f = await createFinding(cookie, 'F');
    // Two already in the path (positions 0,1), one attached.
    await attach(cookie, f.uuid, [evidence[0]!.uuid, evidence[1]!.uuid], true);
    await attach(cookie, f.uuid, [evidence[2]!.uuid], false);

    // Move ev2 into the path — it should land at position 2 (end of the path).
    const res = await app.inject({
      method: 'PATCH',
      url: `/web/engagements/op1/findings/${f.uuid}/evidence/${evidence[2]!.uuid}`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { inPath: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inPath: true });

    const moved = await app.db.evidenceFinding.findFirstOrThrow({
      where: { finding: { uuid: f.uuid }, evidence: { uuid: evidence[2]!.uuid } },
    });
    expect(moved.inPath).toBe(true);
    expect(moved.position).toBe(2);

    const detail = await getDetail(cookie, f.uuid);
    // All three now in the path, ev2 last.
    expect(detail.evidence.map((e: { description: string }) => e.description)).toEqual([
      'ev0',
      'ev1',
      'ev2',
    ]);
  });

  it('PATCH 404s for evidence not linked to the finding', async () => {
    const { cookie, evidence } = await seedEvidence(1);
    const f = await createFinding(cookie, 'F');
    // evidence[0] exists but is not attached to f.
    const res = await app.inject({
      method: 'PATCH',
      url: `/web/engagements/op1/findings/${f.uuid}/evidence/${evidence[0]!.uuid}`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { caption: 'nope' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('reorders within a single bucket without requiring the whole finding set', async () => {
    const { cookie, evidence } = await seedEvidence(4);
    const f = await createFinding(cookie, 'F');
    // Two in the path, two attached.
    await attach(cookie, f.uuid, [evidence[0]!.uuid, evidence[1]!.uuid], true);
    await attach(cookie, f.uuid, [evidence[2]!.uuid, evidence[3]!.uuid], false);

    // Reorder ONLY the attached bucket (a partial set relative to all links).
    const res = await app.inject({
      method: 'PATCH',
      url: `/web/engagements/op1/findings/${f.uuid}/evidence/reorder`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { orderedUuids: [evidence[3]!.uuid, evidence[2]!.uuid] },
    });
    expect(res.statusCode).toBe(200);

    const detail = await getDetail(cookie, f.uuid);
    // Path bucket unchanged (ev0, ev1); attached bucket flipped (ev3, ev2).
    expect(detail.evidence.map((e: { description: string }) => e.description)).toEqual([
      'ev0',
      'ev1',
      'ev3',
      'ev2',
    ]);
  });

  it('rejects a reorder referencing evidence not attached to the finding', async () => {
    const { cookie, evidence } = await seedEvidence(1);
    const f = await createFinding(cookie, 'F');
    await attach(cookie, f.uuid, [evidence[0]!.uuid], false);
    const res = await app.inject({
      method: 'PATCH',
      url: `/web/engagements/op1/findings/${f.uuid}/evidence/reorder`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { orderedUuids: [evidence[0]!.uuid, '00000000-0000-0000-0000-000000000000'] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('finding delete', () => {
  it('deletes a finding but keeps its evidence', async () => {
    const { users, cookie } = await setup();
    const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug: 'op1' } });
    const ev = await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'none',
        description: 'keep me',
        occurredAt: new Date(),
      },
    });
    const f = await createFinding(cookie, 'Doomed');
    await app.inject({
      method: 'POST',
      url: `/web/engagements/op1/findings/${f.uuid}/evidence`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { evidenceUuids: [ev.uuid] },
    });

    const del = await app.inject({
      method: 'DELETE',
      url: `/web/engagements/op1/findings/${f.uuid}`,
      headers: { ...WEB_HEADERS, cookie },
    });
    expect(del.statusCode).toBe(200);

    const list = (
      await app.inject({ method: 'GET', url: '/web/engagements/op1/findings', headers: { cookie } })
    ).json();
    expect(list).toHaveLength(0);
    // Evidence survives the finding delete.
    expect(await app.db.evidence.findUnique({ where: { uuid: ev.uuid } })).not.toBeNull();
  });
});

describe('findings JSON export', () => {
  it('exports ready findings by default and all findings on request, with embedded evidence', async () => {
    const { users, cookie } = await setup();
    const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug: 'op1' } });

    // An image evidence with a real blob so we can test content embedding.
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const blobKey = 'export-test-blob';
    await app.blobs.put(blobKey, PNG);
    const ev = await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'image',
        description: 'shot',
        occurredAt: new Date(),
        fullBlobKey: blobKey,
      },
    });

    const ready = await createFinding(cookie, 'Ready one');
    await update(cookie, ready.uuid, { readyToReport: true, severity: 'high' });
    await app.inject({
      method: 'POST',
      url: `/web/engagements/op1/findings/${ready.uuid}/evidence`,
      headers: { ...WEB_HEADERS, cookie },
      payload: { evidenceUuids: [ev.uuid] },
    });
    await createFinding(cookie, 'Draft two'); // not ready

    // Default: only ready findings, no embedded content.
    const def = await app.inject({
      method: 'GET',
      url: '/web/engagements/op1/findings/export.json',
      headers: { cookie },
    });
    expect(def.statusCode).toBe(200);
    expect(def.headers['content-disposition']).toContain('attachment');
    const defBody = def.json();
    expect(defBody.schemaVersion).toBe(3);
    expect(defBody.findings).toHaveLength(1);
    expect(defBody.findings[0].title).toBe('Ready one');
    expect(defBody.findings[0].severity).toBe('high');
    expect(defBody.findings[0].evidence[0].contentBase64).toBeUndefined();

    // includeAll + includeEvidenceContent.
    const full = (
      await app.inject({
        method: 'GET',
        url: '/web/engagements/op1/findings/export.json?includeAll=true&includeEvidenceContent=true',
        headers: { cookie },
      })
    ).json();
    expect(full.findings).toHaveLength(2);
    expect(full.includesEvidenceContent).toBe(true);
    const readyExport = full.findings.find((f: { title: string }) => f.title === 'Ready one');
    expect(readyExport.evidence[0].contentBase64).toBe(PNG.toString('base64'));
  });
});

describe('findings import', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );

  const post = (url: string, cookie: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: { ...WEB_HEADERS, cookie }, payload });
  const get = (url: string, cookie: string) =>
    app.inject({ method: 'GET', url, headers: { cookie } });

  it('round-trips: export with content → import recreates findings and evidence, idempotently', async () => {
    const { users, cookie } = await setup();
    const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug: 'op1' } });
    await app.blobs.put('imp-blob', PNG);
    const ev = await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'image',
        description: 'shot',
        occurredAt: new Date(),
        fullBlobKey: 'imp-blob',
      },
    });
    const f = await createFinding(cookie, 'Imported RCE');
    await update(cookie, f.uuid, {
      readyToReport: true,
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    });
    await post(`/web/engagements/op1/findings/${f.uuid}/evidence`, cookie, {
      evidenceUuids: [ev.uuid],
    });

    const exportBody = (
      await get(
        '/web/engagements/op1/findings/export.json?includeAll=true&includeEvidenceContent=true',
        cookie,
      )
    ).json();

    // Simulate importing into a clean target (another server/engagement).
    await truncateAll(app);
    const { cookie: cookie2 } = await setup();

    const res = await post('/web/engagements/op1/findings/import', cookie2, exportBody);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      findingsCreated: 1,
      findingsUpdated: 0,
      evidenceCreated: 1,
      evidenceLinked: 0,
    });

    const list = (await get('/web/engagements/op1/findings', cookie2)).json();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Imported RCE');
    expect(list[0].severity).toBe('critical');
    expect(list[0].cvssScore).toBe(9.8);

    const detail = (await get(`/web/engagements/op1/findings/${list[0].uuid}`, cookie2)).json();
    expect(detail.evidence).toHaveLength(1);

    // Recreated evidence keeps its uuid and its exact bytes.
    const content = await get(`/web/engagements/op1/evidence/${ev.uuid}/content`, cookie2);
    expect(content.statusCode).toBe(200);
    expect(Buffer.from(content.rawPayload)).toEqual(PNG);

    // Re-importing the same file updates in place — no duplicates.
    const again = (await post('/web/engagements/op1/findings/import', cookie2, exportBody)).json();
    expect(again).toMatchObject({ findingsCreated: 0, findingsUpdated: 1, evidenceLinked: 1 });
    expect((await get('/web/engagements/op1/findings', cookie2)).json()).toHaveLength(1);
  });

  it('round-trips attack-path buckets and captions through export → import', async () => {
    const { users, cookie } = await setup();
    const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug: 'op1' } });
    const mk = (desc: string) =>
      app.db.evidence.create({
        data: {
          engagementId: eng.id,
          operatorId: users.writer.id,
          contentType: 'none',
          description: desc,
          occurredAt: new Date(),
        },
      });
    const step1 = await mk('step1');
    const step2 = await mk('step2');
    const supporting = await mk('supporting');
    const f = await createFinding(cookie, 'Path finding');
    await update(cookie, f.uuid, { readyToReport: true });
    // Two path steps + one attached.
    await post(`/web/engagements/op1/findings/${f.uuid}/evidence`, cookie, {
      evidenceUuids: [step1.uuid, step2.uuid],
      inPath: true,
    });
    await post(`/web/engagements/op1/findings/${f.uuid}/evidence`, cookie, {
      evidenceUuids: [supporting.uuid],
    });
    // Caption the path steps.
    const patch = (evUuid: string, caption: string) =>
      app.inject({
        method: 'PATCH',
        url: `/web/engagements/op1/findings/${f.uuid}/evidence/${evUuid}`,
        headers: { ...WEB_HEADERS, cookie },
        payload: { caption },
      });
    await patch(step1.uuid, 'Initial access');
    await patch(step2.uuid, 'Privilege escalation');

    const exportBody = (
      await get('/web/engagements/op1/findings/export.json?includeAll=true', cookie)
    ).json();
    const exported = exportBody.findings[0].evidence;
    // Export orders attack path first (with captions/inPath), then attached.
    expect(exported).toMatchObject([
      { uuid: step1.uuid, caption: 'Initial access', inPath: true },
      { uuid: step2.uuid, caption: 'Privilege escalation', inPath: true },
      { uuid: supporting.uuid, caption: '', inPath: false },
    ]);

    // Import into a clean engagement (reference-only; evidence recreated as none-type is skipped,
    // so use the same-engagement re-import to assert link buckets/captions persist).
    const summary = (await post('/web/engagements/op1/findings/import', cookie, exportBody)).json();
    expect(summary.findingsUpdated).toBe(1);

    const links = await app.db.evidenceFinding.findMany({
      where: { finding: { uuid: f.uuid } },
      include: { evidence: { select: { uuid: true, description: true } } },
      orderBy: [{ inPath: 'desc' }, { position: 'asc' }],
    });
    expect(
      links.map((l) => ({
        description: l.evidence.description,
        caption: l.caption,
        inPath: l.inPath,
        position: l.position,
      })),
    ).toEqual([
      { description: 'step1', caption: 'Initial access', inPath: true, position: 0 },
      { description: 'step2', caption: 'Privilege escalation', inPath: true, position: 1 },
      { description: 'supporting', caption: '', inPath: false, position: 0 },
    ]);
  });

  it('reference-only export skips evidence that has no local copy', async () => {
    const { users, cookie } = await setup();
    const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug: 'op1' } });
    const ev = await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'none',
        description: 'note',
        occurredAt: new Date(),
      },
    });
    const f = await createFinding(cookie, 'Ref only');
    await post(`/web/engagements/op1/findings/${f.uuid}/evidence`, cookie, {
      evidenceUuids: [ev.uuid],
    });
    const exportBody = (
      await get('/web/engagements/op1/findings/export.json?includeAll=true', cookie)
    ).json();

    await truncateAll(app);
    const { cookie: cookie2 } = await setup();
    const summary = (
      await post('/web/engagements/op1/findings/import', cookie2, exportBody)
    ).json();
    expect(summary).toMatchObject({
      findingsCreated: 1,
      evidenceCreated: 0,
      evidenceLinked: 0,
      evidenceSkipped: 1,
    });
    const detail = (await get(`/web/engagements/op1/findings/${f.uuid}`, cookie2)).json();
    expect(detail.evidence).toHaveLength(0);
  });

  it('re-importing an edited export detaches evidence removed from the file', async () => {
    const { users, cookie } = await setup();
    const eng = await app.db.engagement.findUniqueOrThrow({ where: { slug: 'op1' } });
    const mk = (desc: string) =>
      app.db.evidence.create({
        data: {
          engagementId: eng.id,
          operatorId: users.writer.id,
          contentType: 'none',
          description: desc,
          occurredAt: new Date(),
        },
      });
    const a = await mk('A');
    const b = await mk('B');
    const f = await createFinding(cookie, 'Converge');
    await post(`/web/engagements/op1/findings/${f.uuid}/evidence`, cookie, {
      evidenceUuids: [a.uuid, b.uuid],
    });

    const exportBody = (
      await get('/web/engagements/op1/findings/export.json?includeAll=true', cookie)
    ).json();
    // Edit the export to drop evidence B, then re-import into the same engagement.
    exportBody.findings[0].evidence = exportBody.findings[0].evidence.filter(
      (e: { uuid: string }) => e.uuid === a.uuid,
    );
    const summary = (await post('/web/engagements/op1/findings/import', cookie, exportBody)).json();
    expect(summary.findingsUpdated).toBe(1);

    const detail = (await get(`/web/engagements/op1/findings/${f.uuid}`, cookie)).json();
    expect(detail.evidence.map((e: { description: string }) => e.description)).toEqual(['A']);
  });

  it('skips a finding whose uuid belongs to another engagement', async () => {
    const { users, cookie } = await setup();
    await app.db.engagement.create({
      data: {
        slug: 'op2',
        name: 'Op Two',
        roles: { create: [{ userId: users.writer.id, role: 'write' }] },
      },
    });
    await createFinding(cookie, 'Belongs to op1');
    const exportBody = (
      await get('/web/engagements/op1/findings/export.json?includeAll=true', cookie)
    ).json();

    const summary = (await post('/web/engagements/op2/findings/import', cookie, exportBody)).json();
    expect(summary).toMatchObject({ findingsCreated: 0, findingsSkipped: 1 });
    expect((await get('/web/engagements/op2/findings', cookie)).json()).toHaveLength(0);
  });

  it('rejects a body that is not a valid export', async () => {
    const { cookie } = await setup();
    const res = await post('/web/engagements/op1/findings/import', cookie, { nope: true });
    expect(res.statusCode).toBe(400);
  });
});

describe('finding strategic-recommendation counts', () => {
  // `strategicRecommendations` is a JSON column on the engagement, not a relation,
  // so these write it directly — including shapes the editor would reject (a uuid
  // for a finding that no longer exists), which is exactly what the read must survive.
  const setRecommendations = (recs: RecommendationItem[]) =>
    app.db.engagement.update({ where: { slug: 'op1' }, data: { strategicRecommendations: recs } });

  const rec = (title: string, findingUuids: string[]): RecommendationItem => ({
    title,
    description: '',
    findingUuids,
  });

  const list = (cookie: string) =>
    app
      .inject({ method: 'GET', url: '/web/engagements/op1/findings', headers: { cookie } })
      .then((r) => r.json() as { uuid: string; numRecommendations: number }[]);

  const detail = (cookie: string, uuid: string) =>
    app
      .inject({ method: 'GET', url: `/web/engagements/op1/findings/${uuid}`, headers: { cookie } })
      .then((r) => r.json() as { numRecommendations: number });

  const countFor = (findings: { uuid: string; numRecommendations: number }[], uuid: string) =>
    findings.find((f) => f.uuid === uuid)!.numRecommendations;

  it('reports 0 for every finding when the engagement has no recommendations', async () => {
    const { cookie } = await setup();
    const a = await createFinding(cookie, 'A');
    const b = await createFinding(cookie, 'B');
    // The column defaults to `[]` and nothing has written it — no throw, just zeros.
    const findings = await list(cookie);
    expect(findings.map((f) => f.numRecommendations)).toEqual([0, 0]);
    expect((await detail(cookie, a.uuid)).numRecommendations).toBe(0);
    expect((await detail(cookie, b.uuid)).numRecommendations).toBe(0);
  });

  it('counts only the recommendations whose findingUuids include the finding', async () => {
    const { cookie } = await setup();
    const a = await createFinding(cookie, 'A');
    const b = await createFinding(cookie, 'B');
    await setRecommendations([
      rec('Harden the gateway', [a.uuid]),
      rec('Rotate the keys', [a.uuid]),
      rec('Unrelated housekeeping', []),
    ]);

    const findings = await list(cookie);
    expect(countFor(findings, a.uuid)).toBe(2);
    expect(countFor(findings, b.uuid)).toBe(0);
  });

  it('counts a recommendation that addresses two findings for both of them', async () => {
    const { cookie } = await setup();
    const a = await createFinding(cookie, 'A');
    const b = await createFinding(cookie, 'B');
    await setRecommendations([rec('Segment the network', [a.uuid, b.uuid])]);

    const findings = await list(cookie);
    // One recommendation, two findings crediting it: the counts sum to more than
    // the number of recommendations, which is correct.
    expect(countFor(findings, a.uuid)).toBe(1);
    expect(countFor(findings, b.uuid)).toBe(1);
  });

  it('ignores a findingUuids entry pointing at a deleted or unknown finding', async () => {
    const { cookie } = await setup();
    const a = await createFinding(cookie, 'A');
    const doomed = await createFinding(cookie, 'Doomed');
    await setRecommendations([
      rec('Addresses a survivor and a ghost', [a.uuid, doomed.uuid]),
      rec('Addresses only a stranger', ['00000000-0000-0000-0000-000000000000']),
    ]);
    await app.inject({
      method: 'DELETE',
      url: `/web/engagements/op1/findings/${doomed.uuid}`,
      headers: { ...WEB_HEADERS, cookie },
    });

    const findings = await list(cookie);
    expect(findings).toHaveLength(1);
    // The dangling uuids are counted nowhere — they don't inflate the survivor.
    expect(countFor(findings, a.uuid)).toBe(1);
  });

  it('counts a recommendation once even if it names the same finding twice', async () => {
    const { cookie } = await setup();
    const a = await createFinding(cookie, 'A');
    await setRecommendations([rec('Says it twice', [a.uuid, a.uuid])]);

    // The count is "how many recommendations address this finding", so one
    // recommendation is one, however many times its findingUuids repeat the uuid.
    expect(countFor(await list(cookie), a.uuid)).toBe(1);
  });

  it('degrades to zeros rather than failing when the column holds an unparseable shape', async () => {
    const { cookie } = await setup();
    const a = await createFinding(cookie, 'A');
    // Not an array of recommendations at all — the read must survive it.
    await app.db.engagement.update({
      where: { slug: 'op1' },
      data: { strategicRecommendations: { nope: true } },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/web/engagements/op1/findings',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(countFor(res.json(), a.uuid)).toBe(0);
  });

  it('serves the count on the list and the detail response alike', async () => {
    const { cookie } = await setup();
    const a = await createFinding(cookie, 'A');
    await setRecommendations([rec('One', [a.uuid]), rec('Two', [a.uuid]), rec('Three', [a.uuid])]);

    expect(countFor(await list(cookie), a.uuid)).toBe(3);
    expect((await detail(cookie, a.uuid)).numRecommendations).toBe(3);
    // And on the write responses, so a client never has to refetch to catch up.
    const updated = (await update(cookie, a.uuid, { title: 'A renamed' })).json();
    expect(updated.numRecommendations).toBe(3);
    const created = await createFinding(cookie, 'Fresh');
    expect(created.numRecommendations).toBe(0);
  });
});
