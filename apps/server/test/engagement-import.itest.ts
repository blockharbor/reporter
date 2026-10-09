import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import archiver from 'archiver';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import yauzl from 'yauzl';
import { buildMultipart } from '@reporter/api-client';
import {
  ENGAGEMENT_EXPORT_BLOB_PREFIX,
  ENGAGEMENT_EXPORT_DATA_ENTRY,
  ENGAGEMENT_EXPORT_MANIFEST_ENTRY,
  ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS,
  SCRIPT_NOT_TEXT_REASON,
  slugSchema,
  type EngagementImportResult,
  type ExecutionSubsection,
  type RecommendationItem,
} from '@reporter/shared';
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

/** A 1×1 PNG, so image evidence has real bytes (and a thumbnail blob). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const EXCLUDED_CONTENT = Buffer.from('must-never-reach-a-report\n');
const ARTIFACT = Buffer.from('%PDF-1.7 pretend deliverable\n');

const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Read every entry of a ZIP into memory, in central-directory order. */
async function readZip(zip: Buffer): Promise<{ names: string[]; files: Map<string, Buffer> }> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, file) => {
      if (err || !file) return reject(err ?? new Error('not a zip'));
      const names: string[] = [];
      const files = new Map<string, Buffer>();
      file.on('entry', (entry) => {
        names.push(entry.fileName);
        file.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            file.readEntry();
          });
          stream.on('error', reject);
        });
      });
      file.on('end', () => resolve({ names, files }));
      file.on('error', reject);
      file.readEntry();
    });
  });
}

/**
 * Rebuild an archive after editing its entries — how the "corrupt file" cases are
 * produced: tamper with a blob, bump the manifest's version, drop an entry.
 * `names` keeps the export's own entry order.
 */
async function rewriteZip(
  original: Buffer,
  mutate: (files: Map<string, Buffer>, names: string[]) => string[],
): Promise<Buffer> {
  const { names, files } = await readZip(original);
  const keep = mutate(files, [...names]);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('error', reject);
  });
  for (const name of keep) archive.append(files.get(name)!, { name });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** Every file currently in the test blob store, so orphans are detectable. */
async function blobFiles(): Promise<string[]> {
  const entries = await readdir(app.config.BLOB_DIR, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

/**
 * The same rich engagement the export test seeds — every shape a round trip has to
 * reproduce: a three-level goal tree, evidence with a parent→child link, tags, an
 * excluded capture, a discussion comment, two findings with categories and
 * standards refs, goal↔evidence and goal↔finding links, a saved query, report
 * history with its artifact bytes, and report content carrying both kinds of uuid
 * cross-reference.
 */
async function seedEngagement() {
  const users = await seedUsers(app);
  const eng = await app.db.engagement.create({
    data: {
      slug: 'op1',
      name: 'Op One',
      roles: {
        create: [
          { userId: users.writer.id, role: 'admin' },
          { userId: users.reader.id, role: 'read' },
        ],
      },
      clientName: 'Acme',
      assessmentType: 'Penetration test',
      scope: 'the head unit',
      executiveSummary: 'all good',
      scopeTargets: [{ name: 'Head unit', subsystems: ['CAN'] }],
      scopeExclusions: ['Production keys'],
      providerContacts: [{ name: 'Wendy Writer', title: 'Assessor', email: 'writer@test.local' }],
      softwareTested: [{ name: 'fw', version: '1.2' }],
      watermarkText: 'DRAFT',
      proposalImport: { devices: [{ name: 'Head unit' }] },
    },
  });

  const tag = await app.db.tag.create({
    data: { engagementId: eng.id, name: 'can', colorName: 'blue' },
  });
  // A second tag, so the weakness below can carry two: the finding join draws on
  // the same pool evidence does, and the round trip has to bring both names back
  // without minting a third tag row.
  const uds = await app.db.tag.create({
    data: { engagementId: eng.id, name: 'uds', colorName: 'green' },
  });

  // The screenshot and its thumbnail are byte-identical, so the export collapses
  // them into ONE archive entry — the import must still give them separate keys.
  const fullKey = 'engimport/full';
  const thumbKey = 'engimport/thumb';
  await app.blobs.put(fullKey, PNG);
  await app.blobs.put(thumbKey, PNG);
  const parent = await app.db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: users.writer.id,
      contentType: 'image',
      title: 'Screenshot',
      description: 'the bus',
      originalFilename: 'bus.png',
      occurredAt: new Date('2026-01-01T10:00:00Z'),
      fullBlobKey: fullKey,
      thumbBlobKey: thumbKey,
      sha256: sha(PNG),
      sizeBytes: PNG.length,
      tags: { create: [{ tagId: tag.id }] },
    },
  });
  const child = await app.db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: users.writer.id,
      contentType: 'none',
      title: 'Follow-up',
      description: 'linked evidence',
      occurredAt: new Date('2026-01-01T11:00:00Z'),
      parentEvidenceId: parent.id,
      lastEditedById: users.admin.id,
    },
  });
  const excludedKey = 'engimport/excluded';
  await app.blobs.put(excludedKey, EXCLUDED_CONTENT);
  const excluded = await app.db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: users.writer.id,
      contentType: 'codeblock',
      title: 'Secret capture',
      description: 'withheld',
      occurredAt: new Date('2026-01-01T12:00:00Z'),
      fullBlobKey: excludedKey,
      excludeFromReport: true,
    },
  });
  const comment = await app.db.evidenceComment.create({
    data: { evidenceId: parent.id, authorId: users.writer.id, body: 'worth a retest' },
  });

  const category = await app.db.findingCategory.create({
    data: { engagementId: eng.id, category: 'Network' },
  });
  // A category nothing uses, and soft-deleted: it must survive the round trip
  // *and* stay hidden.
  await app.db.findingCategory.create({
    data: {
      engagementId: eng.id,
      category: 'Retired',
      deletedAt: new Date('2026-02-02T00:00:00Z'),
    },
  });
  const finding = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      categoryId: category.id,
      title: 'Open diagnostic session',
      description: 'unauthenticated',
      severity: 'high',
      fixEffort: 'medium',
      impact: 'full control',
      remediation: 'require auth',
      iso21434Refs: ['RQ-05-01'],
      unr155Refs: ['7.3.3'],
      readyToReport: true,
      position: 0,
      tags: { create: [{ tagId: tag.id }, { tagId: uds.id }] },
      evidence: {
        create: [
          { evidenceId: parent.id, position: 0, caption: 'step one', inPath: true },
          { evidenceId: excluded.id, position: 0, inPath: false },
        ],
      },
    },
  });
  const strength = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      categoryId: category.id,
      title: 'Secure boot enforced',
      kind: 'strength',
      position: 1,
    },
  });

  const target = await app.db.engagementTarget.create({
    data: {
      engagementId: eng.id,
      name: 'Head unit',
      description: 'IVI',
      activities: {
        create: [
          {
            name: 'CAN fuzzing',
            category: 'Network',
            tagId: tag.id,
            goals: {
              create: [
                { title: 'Enumerate services', status: 'in_progress', position: 0 },
                { title: 'Retest W1-01', isRetest: true, notes: 'from v1', position: 1 },
              ],
            },
          },
        ],
      },
    },
    include: { activities: { include: { goals: true } } },
  });
  const goal = target.activities[0]!.goals[0]!;
  await app.db.goalEvidence.create({ data: { goalId: goal.id, evidenceId: parent.id } });
  await app.db.goalFinding.create({ data: { goalId: goal.id, findingId: finding.id } });

  await app.db.savedQuery.create({
    data: { engagementId: eng.id, name: 'Tagged CAN', query: 'tag:can', type: 'evidence' },
  });

  const artifactKey = `reports/${eng.id}/artifact.pdf`;
  await app.blobs.put(artifactKey, ARTIFACT);
  const report = await app.db.generatedReport.create({
    data: {
      engagementId: eng.id,
      preset: 'full',
      label: 'Full report',
      version: 'v1.0',
      format: 'pdf',
      summary: {
        findingsTotal: 2,
        weaknessesTotal: 1,
        strengthsTotal: 1,
        bySeverity: { critical: 0, high: 1, medium: 0, low: 0, none: 0 },
        highestCvss: null,
        highestSeverity: 'high',
        overallRisk: 'high',
      },
      blobKey: artifactKey,
      filename: 'op1-full-report.pdf',
      sizeBytes: ARTIFACT.length,
      contentType: 'application/pdf',
      sha256: sha(ARTIFACT),
      generatedById: users.writer.id,
    },
  });

  // Both uuid cross-references the importer has to remap.
  await app.db.engagement.update({
    where: { id: eng.id },
    data: {
      strategicRecommendations: [
        { title: 'Lock the diagnostic session', description: '', findingUuids: [finding.uuid] },
      ],
      executionNarrative: [
        {
          kind: 'narrative',
          title: 'CAN bus',
          body: 'what we did',
          evidence: [{ evidenceUuid: parent.uuid, caption: 'the bus' }],
        },
        {
          kind: 'timeline',
          title: 'Evidence log',
          body: '',
          evidence: [],
          timeline: {
            tags: ['can'],
            types: [],
            group: 'chronological',
            includeComments: false,
            starredOnly: false,
          },
        },
      ],
    },
  });

  return {
    users,
    eng,
    tag,
    uds,
    parent,
    child,
    excluded,
    comment,
    finding,
    strength,
    goal,
    report,
  };
}

/** Download the export as bytes (as a site admin, who reaches every engagement). */
async function exportArchive(cookie: string, slug = 'op1'): Promise<Buffer> {
  const res = await app.inject({
    method: 'GET',
    url: `/web/engagements/${slug}/export.zip`,
    headers: { ...WEB_HEADERS, cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.rawPayload;
}

/** POST an archive to the import route, as the upload the web UI would send. */
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

/** The imported engagement, with everything the assertions need loaded. */
function loadCopy(slug: string) {
  return app.db.engagement.findUniqueOrThrow({
    where: { slug },
    include: {
      roles: { include: { user: { select: { email: true } } } },
      tags: true,
      categories: { orderBy: { category: 'asc' } },
      savedQueries: true,
      generatedReports: true,
      evidence: {
        orderBy: { occurredAt: 'asc' },
        include: {
          tags: { include: { tag: { select: { name: true } } } },
          commentThread: { include: { author: { select: { email: true } } } },
        },
      },
      findings: {
        orderBy: { position: 'asc' },
        include: {
          category: true,
          tags: { include: { tag: { select: { name: true } } }, orderBy: { tag: { name: 'asc' } } },
          evidence: { orderBy: [{ inPath: 'desc' }, { position: 'asc' }] },
        },
      },
      targets: {
        orderBy: { position: 'asc' },
        include: {
          activities: {
            orderBy: { position: 'asc' },
            include: {
              tag: true,
              goals: {
                orderBy: { position: 'asc' },
                include: { evidence: true, findings: true },
              },
            },
          },
        },
      },
    },
  });
}

describe('full engagement import', () => {
  it('round-trips a whole engagement into a new one, remapping every reference', async () => {
    const seeded = await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);

    const res = await importArchive(cookie, archive);
    expect(res.statusCode).toBe(200);
    const result = res.json<EngagementImportResult>();

    // A same-server import lands beside the original: the file's slug is
    // provenance, and `uniqueSlug` does the rest.
    expect(result.engagement).toEqual({ slug: 'op1-2', name: 'Op One' });
    expect(result.source).toMatchObject({ slug: 'op1', name: 'Op One' });
    expect(result.created).toMatchObject({
      targets: 1,
      activities: 1,
      goals: 2,
      // Two tag rows — the finding's join adds applications, never tags.
      tags: 2,
      evidence: 3,
      evidenceComments: 1,
      // The unused, soft-deleted category travels too.
      findingCategories: 2,
      findings: 2,
      evidenceLinks: 2,
      goalEvidenceLinks: 1,
      goalFindingLinks: 1,
      savedQueries: 1,
      generatedReports: 1,
      // Three blob references over two distinct archive entries: the PNG (shared
      // by the screenshot and its thumbnail), the excluded capture, the artifact.
      blobs: 4,
    });
    expect(result.created.blobBytes).toBe(
      PNG.length * 2 + EXCLUDED_CONTENT.length + ARTIFACT.length,
    );
    expect(result.remapped).toEqual({ recommendationFindingRefs: 1, narrativeEvidenceRefs: 1 });
    expect(result.dropped).toMatchObject({
      unmatchedAuthorEmails: [],
      unmatchedAuthorRefs: 0,
      unknownTagRefs: 0,
      danglingEvidenceRefs: 0,
      danglingFindingRefs: 0,
      duplicates: 0,
    });

    const copy = await loadCopy(result.engagement.slug);

    // The importing user owns the copy, and nobody else is a member: membership is
    // never exported, so the source's `read` member does not come along.
    expect(copy.roles).toHaveLength(1);
    expect(copy.roles[0]!.role).toBe('admin');
    expect(copy.roles[0]!.user.email).toBe('admin@test.local');

    // Engagement scalars + JSON columns.
    expect(copy).toMatchObject({
      name: 'Op One',
      clientName: 'Acme',
      assessmentType: 'Penetration test',
      scope: 'the head unit',
      executiveSummary: 'all good',
      watermarkText: 'DRAFT',
    });
    expect(copy.createdAt.toISOString()).toBe(seeded.eng.createdAt.toISOString());
    expect(copy.scopeTargets).toEqual([{ name: 'Head unit', subsystems: ['CAN'] }]);
    expect(copy.scopeExclusions).toEqual(['Production keys']);
    expect(copy.softwareTested).toEqual([{ name: 'fw', version: '1.2' }]);
    expect(copy.proposalImport).toEqual({ devices: [{ name: 'Head unit' }] });

    // Tags: fresh rows for the new engagement, same names and colors.
    expect(copy.tags).toHaveLength(2);
    const can = copy.tags.find((t) => t.name === 'can')!;
    expect(can).toMatchObject({ name: 'can', colorName: 'blue' });
    expect(can.id).not.toBe(seeded.tag.id);
    expect(copy.tags.find((t) => t.name === 'uds')).toMatchObject({ colorName: 'green' });

    // Evidence: fresh uuids, the parent→child link rebuilt, tags re-attached,
    // authorship matched by email, and the exclusion restored.
    const screenshot = copy.evidence.find((e) => e.title === 'Screenshot')!;
    const followUp = copy.evidence.find((e) => e.title === 'Follow-up')!;
    const excluded = copy.evidence.find((e) => e.title === 'Secret capture')!;
    expect(copy.evidence).toHaveLength(3);
    expect(screenshot.uuid).not.toBe(seeded.parent.uuid);
    expect(screenshot.occurredAt.toISOString()).toBe(seeded.parent.occurredAt.toISOString());
    expect(screenshot.originalFilename).toBe('bus.png');
    expect(screenshot.operatorId).toBe(seeded.users.writer.id);
    expect(screenshot.tags.map((t) => t.tag.name)).toEqual(['can']);
    expect(followUp.parentEvidenceId).toBe(screenshot.id);
    expect(followUp.lastEditedById).toBe(seeded.users.admin.id);
    // `updatedAt` survives the second pass that sets the parent link.
    expect(followUp.updatedAt.toISOString()).toBe(seeded.child.updatedAt.toISOString());
    expect(excluded.excludeFromReport).toBe(true);
    // Hash + size are derived from the bytes that were actually inflated.
    expect(screenshot.sha256).toBe(sha(PNG));
    expect(screenshot.sizeBytes).toBe(PNG.length);

    // The discussion thread, with its author matched by email.
    expect(screenshot.commentThread).toHaveLength(1);
    expect(screenshot.commentThread[0]).toMatchObject({ body: 'worth a retest' });
    expect(screenshot.commentThread[0]!.author?.email).toBe('writer@test.local');
    expect(screenshot.commentThread[0]!.uuid).not.toBe(seeded.comment.uuid);

    // Findings: categories by name (including the soft-deleted one, still hidden),
    // standards refs, and the evidence links with bucket, order and caption.
    expect(copy.categories.map((c) => [c.category, c.deletedAt !== null])).toEqual([
      ['Network', false],
      ['Retired', true],
    ]);
    const weakness = copy.findings.find((f) => f.title === 'Open diagnostic session')!;
    const strength = copy.findings.find((f) => f.title === 'Secure boot enforced')!;
    expect(weakness).toMatchObject({
      severity: 'high',
      fixEffort: 'medium',
      impact: 'full control',
      remediation: 'require auth',
      readyToReport: true,
      position: 0,
    });
    expect(weakness.uuid).not.toBe(seeded.finding.uuid);
    expect(weakness.category?.category).toBe('Network');
    expect(weakness.iso21434Refs).toEqual(['RQ-05-01']);
    expect(weakness.unr155Refs).toEqual(['7.3.3']);
    expect(
      weakness.evidence.map((l) => [l.evidenceId === screenshot.id, l.inPath, l.caption]),
    ).toEqual([
      [true, true, 'step one'],
      [false, false, ''],
    ]);
    expect(strength.kind).toBe('strength');
    // The finding's tags travel by name and resolve against the copy's own tag
    // rows — the same two names, pointing at the new ids, and nothing on the
    // strength, which had none.
    expect(weakness.tags.map((t) => t.tag.name)).toEqual(['can', 'uds']);
    expect(weakness.tags.map((t) => t.tagId)).toContain(can.id);
    expect(weakness.tags.map((t) => t.tagId)).not.toContain(seeded.tag.id);
    expect(strength.tags).toEqual([]);

    // The goal tree, rebuilt level by level, with links in both directions.
    const target = copy.targets[0]!;
    const activity = target.activities[0]!;
    expect(target).toMatchObject({ name: 'Head unit', description: 'IVI' });
    expect(activity).toMatchObject({ name: 'CAN fuzzing', category: 'Network' });
    expect(activity.tag?.id).toBe(can.id);
    expect(activity.goals.map((g) => [g.title, g.status, g.isRetest, g.notes])).toEqual([
      ['Enumerate services', 'in_progress', false, ''],
      ['Retest W1-01', 'not_started', true, 'from v1'],
    ]);
    expect(activity.goals[0]!.evidence.map((l) => l.evidenceId)).toEqual([screenshot.id]);
    expect(activity.goals[0]!.findings.map((l) => l.findingId)).toEqual([weakness.id]);

    expect(copy.savedQueries).toHaveLength(1);
    expect(copy.savedQueries[0]).toMatchObject({
      name: 'Tagged CAN',
      query: 'tag:can',
      type: 'evidence',
    });

    // Report history keeps its label and version, gets a fresh uuid and key, and
    // its artifact bytes come back byte-for-byte (so it stays downloadable).
    const report = copy.generatedReports[0]!;
    expect(report).toMatchObject({
      preset: 'full',
      label: 'Full report',
      version: 'v1.0',
      format: 'pdf',
      filename: 'op1-full-report.pdf',
      sizeBytes: ARTIFACT.length,
      sha256: sha(ARTIFACT),
      generatedById: seeded.users.writer.id,
    });
    expect(report.uuid).not.toBe(seeded.report.uuid);
    expect(report.blobKey).not.toBe(seeded.report.blobKey);
    expect(await app.blobs.getBuffer(report.blobKey!)).toEqual(ARTIFACT);

    // THE cross-references. Both skip dangling refs silently at render time, so a
    // missed remap would leave a report that is quietly empty here.
    const recommendations = copy.strategicRecommendations as unknown as RecommendationItem[];
    expect(recommendations[0]!.findingUuids).toEqual([weakness.uuid]);
    expect(recommendations[0]!.findingUuids).not.toContain(seeded.finding.uuid);
    const narrative = copy.executionNarrative as unknown as ExecutionSubsection[];
    expect(narrative[0]!.evidence[0]).toEqual({
      evidenceUuid: screenshot.uuid,
      caption: 'the bus',
    });
    expect(narrative[0]!.evidence[0]!.evidenceUuid).not.toBe(seeded.parent.uuid);
    // Tag references inside a timeline subsection are names, which survive as-is.
    expect(narrative[1]!.timeline?.tags).toEqual(['can']);
  });

  it('leaves the source engagement completely untouched', async () => {
    const seeded = await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const before = await loadCopy('op1');
    const archive = await exportArchive(cookie);

    const res = await importArchive(cookie, archive);
    expect(res.statusCode).toBe(200);

    const after = await loadCopy('op1');
    expect(after).toEqual(before);
    // Its recommendation still points at its own finding, not the copy's.
    const recommendations = after.strategicRecommendations as unknown as RecommendationItem[];
    expect(recommendations[0]!.findingUuids).toEqual([seeded.finding.uuid]);
    // Membership, tags and evidence are all still exactly one engagement's worth.
    expect(await app.db.evidence.count({ where: { engagementId: seeded.eng.id } })).toBe(3);
  });

  it('gives the copy its own blobs, so deleting it cannot destroy the original', async () => {
    const seeded = await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);
    const result = (await importArchive(cookie, archive)).json<EngagementImportResult>();
    const copy = await loadCopy(result.engagement.slug);

    const sourceScreenshot = await app.db.evidence.findUniqueOrThrow({
      where: { uuid: seeded.parent.uuid },
    });
    const copyScreenshot = copy.evidence.find((e) => e.title === 'Screenshot')!;

    // Same content, different keys — the file carries hashes, never keys.
    expect(copyScreenshot.fullBlobKey).not.toBe(sourceScreenshot.fullBlobKey);
    expect(copyScreenshot.thumbBlobKey).not.toBe(sourceScreenshot.thumbBlobKey);
    expect(await app.blobs.getBuffer(copyScreenshot.fullBlobKey!)).toEqual(PNG);
    expect(await app.blobs.getBuffer(copyScreenshot.thumbBlobKey!)).toEqual(PNG);
    // The screenshot and its thumbnail are byte-identical, so they shared ONE
    // archive entry — but each reference gets its own key, or deleting one row
    // would reclaim the other's bytes.
    expect(copyScreenshot.fullBlobKey).not.toBe(copyScreenshot.thumbBlobKey);

    // Deleting the imported engagement reclaims its blobs unconditionally; the
    // original's must still be readable afterwards.
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/web/engagements/${result.engagement.slug}`,
      headers: { ...WEB_HEADERS, cookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(await app.blobs.exists(copyScreenshot.fullBlobKey!)).toBe(false);
    expect(await app.blobs.exists(sourceScreenshot.fullBlobKey!)).toBe(true);
    expect(await app.blobs.exists(sourceScreenshot.thumbBlobKey!)).toBe(true);
    expect(await app.blobs.getBuffer(sourceScreenshot.fullBlobKey!)).toEqual(PNG);
    expect(await app.blobs.exists(seeded.report.blobKey!)).toBe(true);
  });

  it('leaves authors with no local account null, and reports them', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);

    // The archive names writer@test.local as the operator and comment author.
    // Remove that account: the import must not recreate it.
    const writer = await app.db.user.findUniqueOrThrow({ where: { email: 'writer@test.local' } });
    await app.db.user.delete({ where: { id: writer.id } });
    const usersBefore = await app.db.user.count();

    const result = (await importArchive(cookie, archive)).json<EngagementImportResult>();
    expect(result.dropped.unmatchedAuthorEmails).toEqual(['writer@test.local']);
    // Three evidence operators, one comment author, one report generator.
    expect(result.dropped.unmatchedAuthorRefs).toBe(5);
    expect(await app.db.user.count()).toBe(usersBefore);

    const copy = await loadCopy(result.engagement.slug);
    const screenshot = copy.evidence.find((e) => e.title === 'Screenshot')!;
    expect(screenshot.operatorId).toBeNull();
    expect(screenshot.commentThread[0]!.authorId).toBeNull();
    // A matched author still resolves, so this is a per-email decision.
    expect(copy.evidence.find((e) => e.title === 'Follow-up')!.lastEditedById).not.toBeNull();
  });

  it('drops a finding tag the file never defines, counts it, and still imports', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);

    // A hand-edited file: the weakness names a tag that is in nobody's `tags`
    // list. The export can't produce this, but a restore from a file someone
    // trimmed by hand can, and the loss is invisible at render time — so it has
    // to be counted rather than failed or silently zeroed.
    const edited = await rewriteZip(archive, (files, names) => {
      const data = JSON.parse(files.get(ENGAGEMENT_EXPORT_DATA_ENTRY)!.toString('utf8'));
      const weakness = data.findings.find(
        (f: { title: string }) => f.title === 'Open diagnostic session',
      );
      weakness.tagNames = ['ghost'];
      files.set(ENGAGEMENT_EXPORT_DATA_ENTRY, Buffer.from(JSON.stringify(data)));
      return names;
    });

    const res = await importArchive(cookie, edited);
    expect(res.statusCode).toBe(200);
    const result = res.json<EngagementImportResult>();
    expect(result.dropped.unknownTagRefs).toBe(1);
    // No tag row was minted for the unknown name.
    expect(result.created.tags).toBe(2);

    const copy = await loadCopy(result.engagement.slug);
    expect(copy.tags.map((t) => t.name).sort()).toEqual(['can', 'uds']);
    const weakness = copy.findings.find((f) => f.title === 'Open diagnostic session')!;
    expect(weakness.tags).toEqual([]);
  });

  it('imports a backup taken before findings had tags', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);

    // The shape every backup on disk had before this feature: no `tagNames` key
    // on any finding, and the older version stamp in both the records and the
    // manifest. This is the file the `.default([])` on `tagNames` and the
    // conditional export stamp exist to keep importable — so it is asserted
    // directly rather than inferred from a fresh export, which always writes the
    // key.
    const legacy = await rewriteZip(archive, (files, names) => {
      const data = JSON.parse(files.get(ENGAGEMENT_EXPORT_DATA_ENTRY)!.toString('utf8'));
      for (const f of data.findings) delete f.tagNames;
      data.schemaVersion = ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS;
      files.set(ENGAGEMENT_EXPORT_DATA_ENTRY, Buffer.from(JSON.stringify(data)));
      const manifest = JSON.parse(files.get(ENGAGEMENT_EXPORT_MANIFEST_ENTRY)!.toString('utf8'));
      manifest.schemaVersion = ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS;
      files.set(ENGAGEMENT_EXPORT_MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest)));
      return names;
    });

    const res = await importArchive(cookie, legacy);
    expect(res.statusCode).toBe(200);
    const result = res.json<EngagementImportResult>();
    // Nothing was dropped: a missing key is "no tags", not a reference to one.
    expect(result.dropped.unknownTagRefs).toBe(0);

    const copy = await loadCopy(result.engagement.slug);
    // Every finding comes back untagged — the weakness included, which the source
    // had tagged. Evidence tags are a different field and still travel.
    expect(copy.findings.every((f) => f.tags.length === 0)).toBe(true);
    expect(copy.evidence.find((e) => e.title === 'Screenshot')!.tags).toHaveLength(1);
  });

  it('dedupes a tag named twice on one finding instead of failing the import', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);

    // The export can't write this, but a hand-edited file can; without the
    // importer's per-finding dedup the bulk insert would violate the join's
    // composite primary key and roll back the entire engagement.
    const edited = await rewriteZip(archive, (files, names) => {
      const data = JSON.parse(files.get(ENGAGEMENT_EXPORT_DATA_ENTRY)!.toString('utf8'));
      const weakness = data.findings.find(
        (f: { title: string }) => f.title === 'Open diagnostic session',
      );
      weakness.tagNames = ['can', 'can', 'uds'];
      files.set(ENGAGEMENT_EXPORT_DATA_ENTRY, Buffer.from(JSON.stringify(data)));
      return names;
    });

    const res = await importArchive(cookie, edited);
    expect(res.statusCode).toBe(200);
    const result = res.json<EngagementImportResult>();
    expect(result.dropped.duplicates).toBe(1);

    const copy = await loadCopy(result.engagement.slug);
    const weakness = copy.findings.find((f) => f.title === 'Open diagnostic session')!;
    expect(weakness.tags.map((t) => t.tag.name).sort()).toEqual(['can', 'uds']);
  });

  it('rejects a blob whose bytes do not match its entry name', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);
    const blobsBefore = await blobFiles();

    const tampered = await rewriteZip(archive, (files, names) => {
      const blobName = names.find((n) => n.startsWith(ENGAGEMENT_EXPORT_BLOB_PREFIX))!;
      files.set(blobName, Buffer.from('swapped for something else entirely\n'));
      return names;
    });

    const res = await importArchive(cookie, tampered);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not match its content hash/);
    // Nothing committed, and nothing left in the blob store either.
    expect(await app.db.engagement.count()).toBe(1);
    expect(await blobFiles()).toEqual(blobsBefore);
  });

  it('rejects an archive that is missing a referenced blob', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);

    const truncated = await rewriteZip(archive, (_files, names) =>
      names.filter((n) => !n.startsWith(ENGAGEMENT_EXPORT_BLOB_PREFIX)),
    );

    const res = await importArchive(cookie, truncated);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/missing \d+ referenced blob/);
    expect(await app.db.engagement.count()).toBe(1);
  });

  it('rejects an unsupported schema version before reading anything else', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);

    const future = await rewriteZip(archive, (files, names) => {
      const manifest = JSON.parse(files.get(ENGAGEMENT_EXPORT_MANIFEST_ENTRY)!.toString('utf8'));
      manifest.schemaVersion = 99;
      files.set(ENGAGEMENT_EXPORT_MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest)));
      return names;
    });

    const res = await importArchive(cookie, future);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unsupported export schema version 99/);
    expect(await app.db.engagement.count()).toBe(1);
  });

  it('rejects a file that is not an engagement export', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');

    const notAZip = await importArchive(cookie, Buffer.from('definitely not a zip'));
    expect(notAZip.statusCode).toBe(400);
    expect(notAZip.json().error).toMatch(/not a readable ZIP archive/);

    const archive = await exportArchive(cookie);
    const noManifest = await rewriteZip(archive, (_files, names) =>
      names.filter((n) => n !== ENGAGEMENT_EXPORT_MANIFEST_ENTRY),
    );
    const res = await importArchive(cookie, noManifest);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/has no manifest\.json entry/);

    // A validation failure names the offending path instead of dumping zod.
    const corrupt = await rewriteZip(archive, (files, names) => {
      const data = JSON.parse(files.get(ENGAGEMENT_EXPORT_DATA_ENTRY)!.toString('utf8'));
      data.engagement.status = 'retired';
      files.set(ENGAGEMENT_EXPORT_DATA_ENTRY, Buffer.from(JSON.stringify(data)));
      return names;
    });
    const invalid = await importArchive(cookie, corrupt);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(
      /engagement\.json in the archive is not valid: engagement\.status/,
    );
  });

  it('rolls back everything when the transaction fails, leaving no orphans', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);
    const blobsBefore = await blobFiles();

    // An explicit slug that is already taken fails *inside* the transaction —
    // after the blobs have been written, which is exactly what the compensating
    // delete exists for.
    const res = await importArchive(cookie, archive, { slug: 'op1' });
    expect(res.statusCode).toBe(409);

    expect(await app.db.engagement.count()).toBe(1);
    expect(await app.db.evidence.count()).toBe(3);
    expect(await blobFiles()).toEqual(blobsBefore);
  });

  it('accepts a name and slug for the new engagement', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);

    const res = await importArchive(cookie, archive, {
      name: 'Op One (restored)',
      slug: 'op1-restored',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<EngagementImportResult>().engagement).toEqual({
      slug: 'op1-restored',
      name: 'Op One (restored)',
    });
  });

  it('is restricted to site admins and needs a file part', async () => {
    await seedEngagement();
    const adminCookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(adminCookie);

    // The engagement's own admin is not enough: there is no engagement to hold a
    // role on, and an import writes rows attributed to other accounts.
    const writerCookie = await loginCookie(app, 'writer@test.local', 'password123');
    const denied = await importArchive(writerCookie, archive);
    expect(denied.statusCode).toBe(403);
    expect(await app.db.engagement.count()).toBe(1);

    const noFile = await app.inject({
      method: 'POST',
      url: '/web/engagements/import',
      headers: { ...WEB_HEADERS, cookie: adminCookie },
      payload: { slug: 'nope' },
    });
    expect(noFile.statusCode).toBe(415);
  });

  /**
   * A 64-character slug is legal — `slugSchema` caps there — so a backup can carry
   * one, and a same-server restore then has to suffix it. The suffix must not push
   * the result past that cap: an over-long slug fails `engagementImportResultSchema`
   * *after* the transaction has committed, and anything thrown past the commit must
   * not reach the compensating delete, which would strip a live engagement of its
   * evidence bytes.
   */
  it('restores an engagement whose slug is already at the length limit', async () => {
    const users = await seedUsers(app);
    const longSlug = 'a'.repeat(64);
    const eng = await app.db.engagement.create({
      data: {
        slug: longSlug,
        name: 'Long slug',
        roles: { create: { userId: users.admin.id, role: 'admin' } },
      },
    });
    const sourceKey = 'engimport/long-slug-full';
    await app.blobs.put(sourceKey, PNG);
    await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.admin.id,
        contentType: 'image',
        title: 'Screenshot',
        occurredAt: new Date('2026-01-01T10:00:00Z'),
        fullBlobKey: sourceKey,
        sha256: sha(PNG),
        sizeBytes: PNG.length,
      },
    });

    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie, longSlug);
    const res = await importArchive(cookie, archive);
    expect(res.statusCode).toBe(200);

    const slug = res.json<EngagementImportResult>().engagement.slug;
    expect(slug).not.toBe(longSlug);
    expect(slugSchema.safeParse(slug).success).toBe(true);

    // The copy owns its own bytes, and both copies are still readable: nothing ran
    // a compensating delete over a committed import.
    const copy = await loadCopy(slug);
    const copied = copy.evidence[0]!;
    expect(copied.fullBlobKey).not.toBe(sourceKey);
    expect(await app.blobs.getBuffer(copied.fullBlobKey!)).toEqual(PNG);
    expect(await app.blobs.getBuffer(sourceKey)).toEqual(PNG);
  });

  /**
   * The structural half of the same bug: *nothing* after the commit may reach the
   * compensating delete. The failure is injected at the last post-commit statement —
   * the success log line — because any throw there (a response that fails
   * validation, a logger problem) used to delete every blob the import had just
   * written, leaving a committed engagement whose evidence pointed at bytes that no
   * longer existed while the caller was told nothing was created.
   */
  it('never deletes the blobs it wrote once the transaction has committed', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);

    const logger = app.log as unknown as { info: (...args: unknown[]) => void };
    const original = logger.info.bind(app.log);
    logger.info = (...args: unknown[]) => {
      if (args.includes('engagement import')) throw new Error('simulated post-commit failure');
      original(...args);
    };

    let res;
    try {
      res = await importArchive(cookie, archive);
    } finally {
      logger.info = original;
    }
    expect(res.statusCode).toBe(500);

    // The engagement committed, so its content has to still be there.
    const copy = await loadCopy('op1-2');
    const screenshot = copy.evidence.find((e) => e.title === 'Screenshot')!;
    expect(await app.blobs.getBuffer(screenshot.fullBlobKey!)).toEqual(PNG);
    expect(await app.blobs.getBuffer(screenshot.thumbBlobKey!)).toEqual(PNG);
    expect(await app.blobs.getBuffer(copy.generatedReports[0]!.blobKey!)).toEqual(ARTIFACT);
  });

  /**
   * The export re-validates stored rows, so a bound it imposes that the write path
   * does not makes a legal engagement un-backupable. `Evidence.contentSubtype` (a
   * language hint) and a finding's category name are both free text on the way in.
   */
  it('carries free-text values that the write path does not bound', async () => {
    const users = await seedUsers(app);
    const eng = await app.db.engagement.create({
      data: {
        slug: 'freetext',
        name: 'Free text',
        roles: { create: { userId: users.admin.id, role: 'admin' } },
      },
    });
    const subtype = 'x'.repeat(300);
    const categoryName = 'y'.repeat(300);
    await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.admin.id,
        contentType: 'codeblock',
        title: 'Snippet',
        contentSubtype: subtype,
        occurredAt: new Date('2026-01-01T10:00:00Z'),
      },
    });
    const category = await app.db.findingCategory.create({
      data: { engagementId: eng.id, category: categoryName },
    });
    await app.db.finding.create({
      data: { engagementId: eng.id, categoryId: category.id, title: 'Long category' },
    });

    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie, 'freetext');
    const res = await importArchive(cookie, archive);
    expect(res.statusCode).toBe(200);

    const copy = await loadCopy(res.json<EngagementImportResult>().engagement.slug);
    expect(copy.evidence[0]!.contentSubtype).toBe(subtype);
    expect(copy.findings[0]!.category!.category).toBe(categoryName);
  });
});

/*
 * An engagement import is the one way script bytes reach the `script` content type
 * without passing through `createEvidence`: rows go in with `createMany` and blobs
 * are written directly. The report reads a script body back with
 * `buf.toString('utf8')` and prints it verbatim, so an archive carrying non-UTF-8
 * script content would put a screenful of U+FFFD into a client PDF. A legitimate
 * export cannot contain one — create refuses it — so the archive is refused with
 * the same finality as a failed content-hash check.
 */
describe('script evidence in an archive is validated, not trusted', () => {
  it('refuses an archive whose script content is not UTF-8 text', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const archive = await exportArchive(cookie);
    const blobsBefore = await blobFiles();

    // Re-label the screenshot as a script. Its blob is a PNG, whose first byte
    // (0x89) is an invalid UTF-8 lead — and the content hash still matches, so this
    // gets past the integrity check and lands squarely on the script decode.
    const mislabelled = await rewriteZip(archive, (files, names) => {
      const data = JSON.parse(files.get(ENGAGEMENT_EXPORT_DATA_ENTRY)!.toString('utf8'));
      const ev = data.evidence.find((e: { contentType: string }) => e.contentType === 'image');
      ev.contentType = 'script';
      ev.contentSubtype = 'bash';
      files.set(ENGAGEMENT_EXPORT_DATA_ENTRY, Buffer.from(JSON.stringify(data)));
      return names;
    });

    const res = await importArchive(cookie, mislabelled);
    expect(res.statusCode).toBe(400);
    // Names the evidence, then quotes the shared reason the create path uses.
    expect(res.json().error).toMatch(/Script evidence “Screenshot” can't be imported\./);
    expect(res.json().error).toContain(SCRIPT_NOT_TEXT_REASON);
    // Refused before the transaction, and the compensating delete left no orphans.
    expect(await app.db.engagement.count()).toBe(1);
    expect(await blobFiles()).toEqual(blobsBefore);
  });

  it('imports a well-formed script, and it stays editable afterwards', async () => {
    const { users, eng } = await seedEngagement();
    const scriptKey = 'engimport/script';
    const body = Buffer.from('#!/bin/bash\nset -euo pipefail\necho ok\n');
    await app.blobs.put(scriptKey, body);
    await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'script',
        contentSubtype: 'bash',
        title: 'Deploy script',
        description: '',
        occurredAt: new Date('2026-01-01T13:00:00Z'),
        fullBlobKey: scriptKey,
        sha256: sha(body),
        sizeBytes: body.length,
      },
    });

    const cookie = await loginCookie(app, 'admin@test.local', 'password123');
    const res = await importArchive(cookie, await exportArchive(cookie));
    expect(res.statusCode).toBe(200);

    const imported = await app.db.evidence.findFirstOrThrow({
      where: { contentType: 'script', engagement: { slug: res.json().slug } },
    });
    expect(imported.contentSubtype).toBe('bash');
    expect(await app.blobs.getBuffer(imported.fullBlobKey!)).toEqual(body);
  });
});
