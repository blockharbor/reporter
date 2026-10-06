import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { reportTemplateConfigSchema } from '@reporter/shared';
import { buildTestApp, loginCookie, seedUsers, truncateAll, WEB_HEADERS } from './helpers.js';
import { getReportTemplateConfig } from '../src/services/report-templates.js';
import { listReportHistory } from '../src/services/report-history.js';

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
 * A configuration a template would plausibly carry: a trimmed section list, a
 * custom section the sections reference, a different finding grouping, and both
 * sanitize toggles ON (the case the UI has to warn about).
 */
const TEMPLATE_CONFIG = {
  sections: [
    { key: 'executiveSummary', enabled: true },
    { key: 'detailedFindings', enabled: true },
    { key: 'custom:intro', enabled: true },
  ],
  customSections: [{ id: 'intro', title: 'How to read this report', body: 'Start here.' }],
  findingGroup: 'category',
  showEvidenceTimestamps: true,
  showEvidenceOperators: true,
};

/**
 * One engagement with a *configured* report: Wendy writes on it, Ravi only reads,
 * and Ada is a site admin who is not a member at all. The engagement's own
 * `reportConfig` is deliberately unlike `TEMPLATE_CONFIG` and carries a readiness
 * waiver, so anything that leaked from a template into the engagement would show.
 */
async function setup() {
  const users = await seedUsers(app);
  const eng = await app.db.engagement.create({
    data: {
      slug: 'acme',
      name: 'Acme Fleet Assessment',
      reportConfig: {
        sections: [{ key: 'methodology', enabled: true }],
        findingGroup: 'severity',
        readinessNa: ['watermark', 'threatModel'],
      },
      roles: {
        create: [
          { userId: users.writer.id, role: 'write' },
          { userId: users.reader.id, role: 'read' },
        ],
      },
    },
  });
  await app.db.finding.create({
    data: { engagementId: eng.id, title: 'W1', severity: 'high', readyToReport: true },
  });
  const writer = await loginCookie(app, 'writer@test.local', 'password123');
  const reader = await loginCookie(app, 'reader@test.local', 'password123');
  const admin = await loginCookie(app, 'admin@test.local', 'password123');
  return { users, eng, writer, reader, admin };
}

/** POST a template as the given user; returns the raw reply. */
function createTemplate(
  cookie: string,
  body: Record<string, unknown>,
): ReturnType<FastifyInstance['inject']> {
  return app.inject({
    method: 'POST',
    url: '/web/report-templates',
    headers: { ...WEB_HEADERS, cookie },
    payload: body,
  });
}

describe('report template CRUD', () => {
  it('round-trips create → list → update → delete', async () => {
    const { writer, users } = await setup();

    const created = await createTemplate(writer, {
      // Padded on purpose: the input schema trims the name.
      name: '  Client deliverable  ',
      description: 'Sections we hand to a client.',
      config: TEMPLATE_CONFIG,
    });
    expect(created.statusCode).toBe(201);
    const tpl = created.json();
    expect(tpl.name).toBe('Client deliverable');
    expect(tpl.description).toBe('Sections we hand to a client.');
    expect(tpl.createdBy).toMatchObject({ slug: users.writer.slug, firstName: 'Wendy' });
    // The custom section travels with the template — without it `custom:intro` in
    // the section list would reference nothing.
    expect(tpl.config.customSections).toEqual([
      { id: 'intro', title: 'How to read this report', body: 'Start here.' },
    ]);
    expect(tpl.config.findingGroup).toBe('category');
    expect(tpl.config.showEvidenceTimestamps).toBe(true);
    expect(tpl.config.showEvidenceOperators).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: '/web/report-templates',
      headers: { cookie: writer },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].uuid).toBe(tpl.uuid);

    const updated = await app.inject({
      method: 'PUT',
      url: `/web/report-templates/${tpl.uuid}`,
      headers: { ...WEB_HEADERS, cookie: writer },
      payload: { name: 'Client deliverable v2', config: { findingGroup: 'target' } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().name).toBe('Client deliverable v2');
    // Overwriting the config replaces it wholesale, with schema defaults filling in
    // whatever the caller didn't send.
    expect(updated.json().config.findingGroup).toBe('target');
    expect(updated.json().config.customSections).toEqual([]);
    // Description untouched by a partial update.
    expect(updated.json().description).toBe('Sections we hand to a client.');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/web/report-templates/${tpl.uuid}`,
      headers: { ...WEB_HEADERS, cookie: writer },
    });
    expect(removed.statusCode).toBe(200);
    expect(await app.db.reportTemplate.count()).toBe(0);
  });

  it('409s on a duplicate name, on create and on rename', async () => {
    const { writer } = await setup();
    const first = await createTemplate(writer, { name: 'House style', config: {} });
    expect(first.statusCode).toBe(201);

    const dupe = await createTemplate(writer, { name: 'House style', config: {} });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error).toBe('A report template with that name already exists');

    const second = await createTemplate(writer, { name: 'Internal debrief', config: {} });
    const rename = await app.inject({
      method: 'PUT',
      url: `/web/report-templates/${second.json().uuid}`,
      headers: { ...WEB_HEADERS, cookie: writer },
      payload: { name: 'House style' },
    });
    expect(rename.statusCode).toBe(409);
  });

  it('404s for an unknown uuid on update and delete', async () => {
    const { writer } = await setup();
    const unknown = '00000000-0000-0000-0000-000000000000';
    const put = await app.inject({
      method: 'PUT',
      url: `/web/report-templates/${unknown}`,
      headers: { ...WEB_HEADERS, cookie: writer },
      payload: { name: 'Nope' },
    });
    expect(put.statusCode).toBe(404);
    const del = await app.inject({
      method: 'DELETE',
      url: `/web/report-templates/${unknown}`,
      headers: { ...WEB_HEADERS, cookie: writer },
    });
    expect(del.statusCode).toBe(404);
  });

  it('never stores readinessNa in a template', async () => {
    const { writer } = await setup();
    const created = await createTemplate(writer, {
      name: 'With a waiver attached',
      // A client that sends the whole engagement config, waivers and all.
      config: { ...TEMPLATE_CONFIG, readinessNa: ['watermark'] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().config).not.toHaveProperty('readinessNa');

    // Not just absent from the response — absent from the stored JSON, so it can't
    // reappear when the template is applied or generated with.
    const row = await app.db.reportTemplate.findFirstOrThrow();
    expect(Object.keys(row.config as Record<string, unknown>)).not.toContain('readinessNa');
    const resolved = await getReportTemplateConfig(app, row.uuid);
    expect(resolved.config).not.toHaveProperty('readinessNa');
  });
});

describe('report template permissions', () => {
  it('lets a read-only user list but not manage', async () => {
    const { writer, reader } = await setup();
    const existing = await createTemplate(writer, { name: 'House style', config: {} });
    expect(existing.statusCode).toBe(201);

    // Using the library is an ordinary reporting action: read access is enough.
    const list = await app.inject({
      method: 'GET',
      url: '/web/report-templates',
      headers: { cookie: reader },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const post = await createTemplate(reader, { name: 'Mine', config: {} });
    expect(post.statusCode).toBe(403);
    const put = await app.inject({
      method: 'PUT',
      url: `/web/report-templates/${existing.json().uuid}`,
      headers: { ...WEB_HEADERS, cookie: reader },
      payload: { name: 'Renamed' },
    });
    expect(put.statusCode).toBe(403);
    const del = await app.inject({
      method: 'DELETE',
      url: `/web/report-templates/${existing.json().uuid}`,
      headers: { ...WEB_HEADERS, cookie: reader },
    });
    expect(del.statusCode).toBe(403);
    expect(await app.db.reportTemplate.count()).toBe(1);
  });

  it('lets a site admin with no engagement membership manage', async () => {
    const { admin } = await setup();
    const created = await createTemplate(admin, { name: 'Admin-made', config: {} });
    expect(created.statusCode).toBe(201);
  });

  it('refuses an unauthenticated caller outright', async () => {
    await setup();
    const list = await app.inject({ method: 'GET', url: '/web/report-templates' });
    expect(list.statusCode).toBe(401);
    const post = await app.inject({
      method: 'POST',
      url: '/web/report-templates',
      headers: WEB_HEADERS,
      payload: { name: 'Nope', config: {} },
    });
    expect(post.statusCode).toBe(401);
  });
});

describe('generating with a report template', () => {
  it('renders from the template and leaves the engagement reportConfig untouched', async () => {
    const { writer, eng } = await setup();
    const before = await app.db.engagement.findUniqueOrThrow({ where: { id: eng.id } });
    const tpl = (
      await createTemplate(writer, { name: 'Client deliverable', config: TEMPLATE_CONFIG })
    ).json();

    const gen = await app.inject({
      method: 'GET',
      url: `/web/engagements/acme/report.json?templateUuid=${tpl.uuid}`,
      headers: { ...WEB_HEADERS, cookie: writer },
    });
    expect(gen.statusCode).toBe(200);
    // The download is named after the template, not after a preset.
    expect(gen.headers['content-disposition']).toContain('acme-client-deliverable-');

    // History says which template produced it, rather than implying the
    // engagement's own configured sections did.
    const history = await listReportHistory(app, eng.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.label).toBe('Report template: Client deliverable');
    expect(history[0]!.preset).toBe('custom');

    // The whole point: generating with a template is a per-run choice. The
    // engagement's stored configuration — readiness waivers included — is
    // byte-identical afterwards.
    const after = await app.db.engagement.findUniqueOrThrow({ where: { id: eng.id } });
    expect(JSON.stringify(after.reportConfig)).toBe(JSON.stringify(before.reportConfig));
    expect((after.reportConfig as { readinessNa: string[] }).readinessNa).toEqual([
      'watermark',
      'threatModel',
    ]);
  });

  it('404s an unknown templateUuid instead of falling back to the engagement config', async () => {
    const { writer, eng } = await setup();
    const gen = await app.inject({
      method: 'GET',
      url: '/web/engagements/acme/report.json?templateUuid=00000000-0000-0000-0000-000000000000',
      headers: { ...WEB_HEADERS, cookie: writer },
    });
    expect(gen.statusCode).toBe(404);
    expect(gen.json().error).toBe('Report template not found');
    // Nothing was generated, so nothing was recorded.
    expect(await listReportHistory(app, eng.id)).toHaveLength(0);
  });

  /**
   * The three config-driven generation routes all resolve through one helper
   * (`reportForRun`), so a template must be honoured identically on each. The PDF and
   * ZIP routes render with headless Chromium, which these tests don't run, but the
   * template is resolved *before* any rendering — so an unknown uuid is a 404 from
   * every one of them, which is exactly the shared resolution step being asserted. A
   * route that quietly ignored `templateUuid` would 200 here off the engagement's own
   * configuration instead.
   */
  it.each(['pdf', 'zip', 'json'] as const)(
    'resolves templateUuid on report.%s rather than ignoring it',
    async (format) => {
      const { writer, eng } = await setup();
      const gen = await app.inject({
        method: 'GET',
        url: `/web/engagements/acme/report.${format}?templateUuid=00000000-0000-0000-0000-000000000000&preset=full`,
        headers: { ...WEB_HEADERS, cookie: writer },
      });
      expect(gen.statusCode).toBe(404);
      expect(gen.json().error).toBe('Report template not found');
      expect(await listReportHistory(app, eng.id)).toHaveLength(0);
    },
  );

  it('still records a preset label when no template is named', async () => {
    const { writer, eng } = await setup();
    const gen = await app.inject({
      method: 'GET',
      url: '/web/engagements/acme/report.json?preset=findings',
      headers: { ...WEB_HEADERS, cookie: writer },
    });
    expect(gen.statusCode).toBe(200);
    const history = await listReportHistory(app, eng.id);
    expect(history[0]!.preset).toBe('findings');
    expect(history[0]!.label).toBe('Findings only');
  });
});

describe('reportTemplateConfigSchema', () => {
  it('defaults every field exactly like the engagement report config, minus readinessNa', () => {
    const parsed = reportTemplateConfigSchema.parse({});
    expect(parsed).not.toHaveProperty('readinessNa');
    expect(parsed.customSections).toEqual([]);
    expect(parsed.findingGroup).toBe('severity');
    // Both sanitize toggles default OFF — a template only turns them on if its
    // author deliberately saved them on (which the UI then warns about).
    expect(parsed.showEvidenceTimestamps).toBe(false);
    expect(parsed.showEvidenceOperators).toBe(false);
    expect(parsed.sections.length).toBeGreaterThan(0);
  });
});
