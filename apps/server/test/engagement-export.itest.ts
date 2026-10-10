import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import yauzl from 'yauzl';
import {
  ENGAGEMENT_EXPORT_BLOB_PREFIX,
  ENGAGEMENT_EXPORT_DATA_ENTRY,
  ENGAGEMENT_EXPORT_FORMAT,
  ENGAGEMENT_EXPORT_MANIFEST_ENTRY,
  ENGAGEMENT_EXPORT_VERSION,
  ENGAGEMENT_EXPORT_VERSION_WITHOUT_AUDIT_LOG,
  ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS,
  MAX_ENGAGEMENT_EXPORT_AUDIT_ENTRIES,
  engagementExportManifestSchema,
  engagementExportSchema,
  type EngagementExport,
  type EngagementExportManifest,
} from '@reporter/shared';
import {
  WEB_HEADERS,
  buildTestApp,
  loginCookie,
  seedUsers,
  truncateAll,
  truncateAuditLog,
} from './helpers.js';

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

/** A 1×1 PNG, so image evidence has real bytes (and a thumbnail blob key). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

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
 * One engagement containing every shape the export has to cover: a three-level
 * goal tree, evidence with a parent→child link, tags, an excluded capture, a
 * discussion comment, two findings with categories and standards refs, goal↔
 * evidence and goal↔finding links, a saved query, and report content carrying both
 * kinds of uuid cross-reference.
 */
async function seedEngagement() {
  const users = await seedUsers(app);
  const eng = await app.db.engagement.create({
    data: {
      slug: 'op1',
      name: 'Op One',
      // The writer holds `admin` on the engagement (the export's bar); the reader
      // holds `read`, which must not be enough.
      roles: {
        create: [
          { userId: users.writer.id, role: 'admin' },
          { userId: users.reader.id, role: 'read' },
        ],
      },
      clientName: 'Acme',
      scopeTargets: [{ name: 'Head unit', subsystems: ['CAN'] }],
      scopeExclusions: ['Production keys'],
      providerContacts: [{ name: 'Wendy Writer', title: 'Assessor', email: 'writer@test.local' }],
      softwareTested: [{ name: 'fw', version: '1.2' }],
    },
  });

  const tag = await app.db.tag.create({
    data: { engagementId: eng.id, name: 'can', colorName: 'blue' },
  });

  // Evidence with a real blob + thumbnail, a tagged child comment, and an
  // excluded capture.
  const fullKey = 'engexport/full';
  const thumbKey = 'engexport/thumb';
  await app.blobs.put(fullKey, PNG);
  await app.blobs.put(thumbKey, PNG);
  const parent = await app.db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: users.writer.id,
      contentType: 'image',
      title: 'Screenshot',
      description: 'the bus',
      occurredAt: new Date('2026-01-01T10:00:00Z'),
      fullBlobKey: fullKey,
      thumbBlobKey: thumbKey,
      // Deliberately wrong, as a stale row would be: the export must name entries
      // by the hash of the bytes it actually read, not by this column.
      sha256: 'b'.repeat(64),
      sizeBytes: 1,
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
  const excludedKey = 'engexport/excluded';
  await app.blobs.put(excludedKey, Buffer.from('must-never-reach-a-report\n'));
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
  const finding = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      categoryId: category.id,
      title: 'Open diagnostic session',
      description: 'unauthenticated',
      severity: 'high',
      iso21434Refs: ['RQ-05-01'],
      unr155Refs: ['7.3.3'],
      readyToReport: true,
      position: 0,
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

  // Target → Activity → Goal, with links in both directions.
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
                { title: 'Retest W1-01', isRetest: true, position: 1 },
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

  // Both uuid cross-references the importer has to remap: a recommendation
  // pointing at a finding, and an execution subsection embedding evidence.
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

  // The backstop recorded every fixture write above as an audit entry, and an
  // export carries the log — so each case starts from an empty log and seeds
  // exactly the entries it means to assert on.
  await truncateAuditLog(app);
  return { users, eng, tag, parent, child, excluded, comment, finding, strength, goal, target };
}

/** Download the export and decode it. */
async function fetchExport(cookie: string, query = '') {
  const res = await app.inject({
    method: 'GET',
    url: `/web/engagements/op1/export.zip${query}`,
    headers: { ...WEB_HEADERS, cookie },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/zip');
  const zip = await readZip(res.rawPayload);
  const manifest: EngagementExportManifest = engagementExportManifestSchema.parse(
    JSON.parse(zip.files.get(ENGAGEMENT_EXPORT_MANIFEST_ENTRY)!.toString('utf8')),
  );
  const data: EngagementExport = engagementExportSchema.parse(
    JSON.parse(zip.files.get(ENGAGEMENT_EXPORT_DATA_ENTRY)!.toString('utf8')),
  );
  return { res, zip, manifest, data };
}

describe('full engagement export', () => {
  it('writes the manifest first, then the records, then content-addressed blobs', async () => {
    const seeded = await seedEngagement();
    const cookie = await loginCookie(app, 'writer@test.local', 'password123');
    const { zip, manifest, data } = await fetchExport(cookie);

    // Entry order is part of the format: a reader validates version + counts
    // before inflating a blob.
    expect(zip.names[0]).toBe(ENGAGEMENT_EXPORT_MANIFEST_ENTRY);
    expect(zip.names[1]).toBe(ENGAGEMENT_EXPORT_DATA_ENTRY);
    expect(zip.names.slice(2).every((n) => n.startsWith(ENGAGEMENT_EXPORT_BLOB_PREFIX))).toBe(true);

    expect(manifest.format).toBe(ENGAGEMENT_EXPORT_FORMAT);
    expect(manifest.schemaVersion).toBe(ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS);
    expect(manifest.engagement).toEqual({ slug: 'op1', name: 'Op One' });
    expect(manifest.counts).toMatchObject({
      targets: 1,
      activities: 1,
      goals: 2,
      tags: 1,
      evidence: 3,
      evidenceComments: 1,
      findingCategories: 1,
      findings: 2,
      savedQueries: 1,
      generatedReports: 0,
      // Three distinct blobs: the screenshot and its thumbnail are byte-identical
      // here, so content addressing collapses them into one entry.
      blobs: 2,
    });
    expect(manifest.counts.blobBytes).toBe(PNG.length + 'must-never-reach-a-report\n'.length);
    expect(data.schemaVersion).toBe(ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS);

    // Every blob reference in the records resolves to an entry whose bytes hash to
    // exactly that name — including the capture whose stored `sha256` column lies.
    const referenced = new Set<string>();
    for (const ev of data.evidence) {
      if (ev.fullBlobHash) referenced.add(ev.fullBlobHash);
      if (ev.thumbBlobHash) referenced.add(ev.thumbBlobHash);
    }
    for (const r of data.generatedReports) {
      if (r.artifactBlobHash) referenced.add(r.artifactBlobHash);
    }
    expect(referenced.size).toBe(manifest.counts.blobs);
    for (const hash of referenced) {
      const bytes = zip.files.get(`${ENGAGEMENT_EXPORT_BLOB_PREFIX}${hash}`);
      expect(bytes, `missing blobs/${hash}`).toBeDefined();
      expect(sha(bytes!)).toBe(hash);
    }
    const screenshot = data.evidence.find((e) => e.uuid === seeded.parent.uuid)!;
    expect(screenshot.fullBlobHash).toBe(sha(PNG));
    expect(screenshot.thumbBlobHash).toBe(sha(PNG));
  });

  it('covers the goal tree, evidence graph, findings and report cross-references', async () => {
    const seeded = await seedEngagement();
    const cookie = await loginCookie(app, 'writer@test.local', 'password123');
    const { data } = await fetchExport(cookie);

    // Three levels deep, keyed file-locally (no uuid column on these models).
    const target = data.targets[0]!;
    const activity = target.activities[0]!;
    expect([target.key, activity.key, activity.goals[0]!.key]).toEqual(['t0', 't0.a0', 't0.a0.g0']);
    // The activity's correlation tag travels by name.
    expect(activity.tagName).toBe('can');
    expect(activity.goals[1]!.isRetest).toBe(true);
    // Goal links name rows by uuid.
    expect(activity.goals[0]!.evidenceUuids).toEqual([seeded.parent.uuid]);
    expect(activity.goals[0]!.findingUuids).toEqual([seeded.finding.uuid]);

    // Evidence: tags by name, the parent→child link, authorship by email, and the
    // excluded capture with its flag intact (a backup is not a deliverable).
    const parent = data.evidence.find((e) => e.uuid === seeded.parent.uuid)!;
    const child = data.evidence.find((e) => e.uuid === seeded.child.uuid)!;
    const excluded = data.evidence.find((e) => e.uuid === seeded.excluded.uuid)!;
    expect(parent.tagNames).toEqual(['can']);
    expect(parent.operatorEmail).toBe('writer@test.local');
    expect(child.parentEvidenceUuid).toBe(seeded.parent.uuid);
    expect(child.lastEditedByEmail).toBe('admin@test.local');
    expect(excluded.excludeFromReport).toBe(true);

    expect(data.evidenceComments).toHaveLength(1);
    expect(data.evidenceComments[0]).toMatchObject({
      uuid: seeded.comment.uuid,
      evidenceUuid: seeded.parent.uuid,
      authorEmail: 'writer@test.local',
      body: 'worth a retest',
    });

    // Findings: category by name, standards refs, and the evidence links with
    // their bucket + caption. The excluded capture is linked here too.
    expect(data.findingCategories).toEqual([{ category: 'Network', deletedAt: null }]);
    const finding = data.findings.find((f) => f.uuid === seeded.finding.uuid)!;
    expect(finding).toMatchObject({
      category: 'Network',
      severity: 'high',
      iso21434Refs: ['RQ-05-01'],
      unr155Refs: ['7.3.3'],
    });
    expect(finding.evidenceLinks).toEqual([
      { evidenceUuid: seeded.parent.uuid, position: 0, caption: 'step one', inPath: true },
      { evidenceUuid: seeded.excluded.uuid, position: 0, caption: '', inPath: false },
    ]);
    expect(data.findings.find((f) => f.uuid === seeded.strength.uuid)!.kind).toBe('strength');

    expect(data.savedQueries).toEqual([{ name: 'Tagged CAN', query: 'tag:can', type: 'evidence' }]);

    // The engagement's JSON columns, including BOTH uuid cross-references that an
    // import has to remap: a dangling one is skipped silently at render time, so a
    // missed remap would quietly gut the report.
    expect(data.engagement).toMatchObject({
      slug: 'op1',
      clientName: 'Acme',
      scopeExclusions: ['Production keys'],
    });
    expect(data.engagement.scopeTargets).toEqual([{ name: 'Head unit', subsystems: ['CAN'] }]);
    expect(data.engagement.softwareTested).toEqual([{ name: 'fw', version: '1.2' }]);
    expect(data.engagement.strategicRecommendations[0]!.findingUuids).toEqual([
      seeded.finding.uuid,
    ]);
    expect(data.engagement.executionNarrative[0]!.evidence[0]!.evidenceUuid).toBe(
      seeded.parent.uuid,
    );
    // A timeline subsection references tags by name, which an import preserves.
    expect(data.engagement.executionNarrative[1]!.timeline?.tags).toEqual(['can']);
    // The report config is normalized to the canonical default, never left as `{}`.
    expect(data.engagement.reportConfig.sections.length).toBeGreaterThan(0);
  });

  it('carries report history with its stored artifact bytes', async () => {
    const seeded = await seedEngagement();
    const artifact = Buffer.from('%PDF-1.7 pretend deliverable\n');
    const key = `reports/${seeded.eng.id}/artifact.pdf`;
    await app.blobs.put(key, artifact);
    const row = await app.db.generatedReport.create({
      data: {
        engagementId: seeded.eng.id,
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
        blobKey: key,
        filename: 'op1-full-report.pdf',
        sizeBytes: artifact.length,
        contentType: 'application/pdf',
        sha256: sha(artifact),
        generatedById: seeded.users.writer.id,
      },
    });

    const cookie = await loginCookie(app, 'writer@test.local', 'password123');
    const { zip, manifest, data } = await fetchExport(cookie);

    expect(manifest.counts.generatedReports).toBe(1);
    const exported = data.generatedReports[0]!;
    expect(exported).toMatchObject({
      uuid: row.uuid,
      preset: 'full',
      version: 'v1.0',
      format: 'pdf',
      generatedByEmail: 'writer@test.local',
      filename: 'op1-full-report.pdf',
      artifactBlobHash: sha(artifact),
    });
    expect(exported.summary.highestSeverity).toBe('high');
    // The delivered bytes travel, so the restored history entry is still
    // downloadable rather than becoming a row that claims a file it lost.
    expect(zip.files.get(`${ENGAGEMENT_EXPORT_BLOB_PREFIX}${sha(artifact)}`)).toEqual(artifact);
  });

  it('exports an engagement whose blob has gone missing, without its content', async () => {
    const seeded = await seedEngagement();
    await app.blobs.delete('engexport/excluded');

    const cookie = await loginCookie(app, 'writer@test.local', 'password123');
    const { manifest, data } = await fetchExport(cookie);

    expect(manifest.counts.evidence).toBe(3);
    expect(manifest.counts.blobs).toBe(1);
    const excluded = data.evidence.find((e) => e.uuid === seeded.excluded.uuid)!;
    expect(excluded.fullBlobHash).toBeNull();
  });

  it('requires the engagement admin role, not read', async () => {
    await seedEngagement();
    const readerCookie = await loginCookie(app, 'reader@test.local', 'password123');
    const denied = await app.inject({
      method: 'GET',
      url: '/web/engagements/op1/export.zip',
      headers: { ...WEB_HEADERS, cookie: readerCookie },
    });
    expect(denied.statusCode).toBe(403);

    // A site admin reaches every engagement, as everywhere else.
    const adminCookie = await loginCookie(app, 'admin@test.local', 'password123');
    const allowed = await app.inject({
      method: 'GET',
      url: '/web/engagements/op1/export.zip',
      headers: { ...WEB_HEADERS, cookie: adminCookie },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

/*
 * The stamp is conditional on purpose. `tagNames` on a finding is a new FIELD, and
 * a server that predates it strips an unknown field without a word — so a tagged
 * backup carrying the old version number would import there with every label
 * silently gone. Bumping every backup instead would make a tag-free one, which
 * that server could restore perfectly, refuse to import. So: the older stamp when
 * nothing in the file needs the newer reader, the newer one the moment anything
 * does. Both the manifest and the records carry it, and the importer gates on
 * each, so the two must agree.
 */
describe('schema version stamp', () => {
  it('keeps the pre-finding-tags stamp when no finding carries a tag', async () => {
    await seedEngagement();
    const cookie = await loginCookie(app, 'writer@test.local', 'password123');
    const { manifest, data } = await fetchExport(cookie);

    // The engagement HAS a tag, applied to evidence and to an activity — neither
    // of which is what the bump is about. Only a finding's tag needs the v2 reader.
    expect(data.evidence.some((e) => e.tagNames.length > 0)).toBe(true);
    expect(data.findings.every((f) => f.tagNames.length === 0)).toBe(true);
    expect(manifest.schemaVersion).toBe(ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS);
    expect(data.schemaVersion).toBe(ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS);
  });

  it('stamps the finding-tags version in both places once a single finding is tagged', async () => {
    const seeded = await seedEngagement();
    await app.db.findingTag.create({
      data: { findingId: seeded.finding.id, tagId: seeded.tag.id },
    });
    await truncateAuditLog(app);
    const cookie = await loginCookie(app, 'writer@test.local', 'password123');
    const { manifest, data } = await fetchExport(cookie);

    // v2, not v3: a tagged finding needs the finding-tags reader, and with no
    // audit entry in the file nothing needs the v3 one.
    expect(manifest.schemaVersion).toBe(ENGAGEMENT_EXPORT_VERSION_WITHOUT_AUDIT_LOG);
    expect(data.schemaVersion).toBe(ENGAGEMENT_EXPORT_VERSION_WITHOUT_AUDIT_LOG);
    expect(manifest.schemaVersion).not.toBe(ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS);
    // And the field the bump exists to protect is actually in the records.
    const finding = data.findings.find((f) => f.uuid === seeded.finding.uuid)!;
    expect(finding.tagNames).toEqual(['can']);
    expect(data.findings.find((f) => f.uuid === seeded.strength.uuid)!.tagNames).toEqual([]);
  });
});

/**
 * The audit log is the one collection that is content on one server and a
 * record on this one: live entries travel, removed ones do not, the export is
 * itself an entry, and an oversized log truncates rather than failing.
 */
describe('the audit log in the export', () => {
  const EXPORTED_ENTRY_KEYS = [
    'action',
    'actorEmail',
    'actorName',
    'changes',
    'coalescedCount',
    'createdAt',
    'entityId',
    'entityLabel',
    'entityType',
    'lastAt',
    'summary',
    'uuid',
    'via',
  ];

  function liveRow(
    eng: { id: number; slug: string; name: string },
    actor: { id: number; email: string },
    createdAt: string,
    summary: string,
  ) {
    return {
      engagementId: eng.id,
      engagementSlug: eng.slug,
      engagementName: eng.name,
      actorId: actor.id,
      actorName: 'Wendy Writer',
      actorEmail: actor.email,
      via: 'session',
      action: 'update',
      entityType: 'evidence',
      entityId: 'e0a1b2c3-0000-4000-8000-000000000001',
      entityLabel: 'Screenshot',
      summary,
      changes: [{ kind: 'field', field: 'description', from: 'a', to: 'b' }],
      coalesceKey: 'description',
      coalescedCount: 2,
      source: 'intent',
      createdAt: new Date(createdAt),
      lastAt: new Date(createdAt),
    };
  }

  it('carries live entries oldest-first, stamps v3, and records the export itself', async () => {
    const { eng, users } = await seedEngagement();
    // Inserted newest-first, so the order in the file is the exporter's doing.
    const newer = await app.db.auditEntry.create({
      data: liveRow(eng, users.writer, '2026-02-01T10:00:00Z', 'second'),
    });
    const older = await app.db.auditEntry.create({
      data: liveRow(eng, users.writer, '2026-01-01T10:00:00Z', 'first'),
    });
    const removed = await app.db.auditEntry.create({
      data: liveRow(eng, users.writer, '2026-01-15T10:00:00Z', 'gone'),
    });
    await app.db.auditEntry.updateMany({
      where: { id: removed.id },
      data: {
        deletedAt: new Date(),
        deletedById: users.admin.id,
        deletedByName: 'Ada Admin',
        deletedByEmail: users.admin.email,
        deletedReason: 'Pasted a credential.',
        summary: '',
        entityLabel: '',
        changes: [],
      },
    });
    const cookie = await loginCookie(app, 'writer@test.local', 'password123');
    const { manifest, data } = await fetchExport(cookie);

    // Entries in the file need the v3 reader, whatever the findings carry.
    expect(data.findings.every((f) => f.tagNames.length === 0)).toBe(true);
    expect(manifest.schemaVersion).toBe(ENGAGEMENT_EXPORT_VERSION);
    expect(data.schemaVersion).toBe(ENGAGEMENT_EXPORT_VERSION);
    expect(manifest.counts).toMatchObject({ auditEntries: 2, auditEntriesTotal: 2 });

    expect(data.auditEntries.map((a) => a.summary)).toEqual(['first', 'second']);
    expect(data.auditEntries.map((a) => a.uuid)).toEqual([older.uuid, newer.uuid]);
    expect(data.auditEntries[0]).toEqual({
      uuid: older.uuid,
      actorName: 'Wendy Writer',
      actorEmail: 'writer@test.local',
      via: 'session',
      action: 'update',
      entityType: 'evidence',
      entityId: 'e0a1b2c3-0000-4000-8000-000000000001',
      entityLabel: 'Screenshot',
      summary: 'first',
      changes: [{ kind: 'field', field: 'description', from: 'a', to: 'b' }],
      coalescedCount: 2,
      createdAt: '2026-01-01T10:00:00.000Z',
      lastAt: '2026-01-01T10:00:00.000Z',
    });
    // Exactly these keys: no engagement snapshot (re-stamped on import), no
    // `source` (every restored row is `import`), nothing of a removal.
    expect(Object.keys(data.auditEntries[0]!).sort()).toEqual(EXPORTED_ENTRY_KEYS);

    // The download is an event: recorded after the archive was finalized, by
    // the writer, on this engagement, with the manifest's counts — and
    // therefore not inside the archive it describes.
    const own = await app.db.auditEntry.findMany({ where: { action: 'export' } });
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      entityType: 'engagement',
      entityId: String(eng.id),
      engagementId: eng.id,
      engagementSlug: 'op1',
      actorEmail: 'writer@test.local',
      via: 'session',
    });
    expect(own[0]!.summary).toContain('2 of 2 audit entries');
    expect(own[0]!.changes).toEqual(
      expect.arrayContaining([
        { kind: 'count', label: 'Audit entries written', count: 2 },
        { kind: 'count', label: 'Audit entries total', count: 2 },
        { kind: 'count', label: 'Findings', count: 2 },
      ]),
    );
    expect(data.auditEntries.map((a) => a.uuid)).not.toContain(own[0]!.uuid);
  });

  it('leaves the log out on ?includeAuditLog=0, and the stamp falls back', async () => {
    const seeded = await seedEngagement();
    await app.db.findingTag.create({
      data: { findingId: seeded.finding.id, tagId: seeded.tag.id },
    });
    await truncateAuditLog(app);
    await app.db.auditEntry.create({
      data: liveRow(seeded.eng, seeded.users.writer, '2026-01-01T10:00:00Z', 'first'),
    });
    const cookie = await loginCookie(app, 'writer@test.local', 'password123');
    const { manifest, data } = await fetchExport(cookie, '?includeAuditLog=0');

    expect(data.auditEntries).toEqual([]);
    expect(manifest.counts).toMatchObject({ auditEntries: 0, auditEntriesTotal: 0 });
    // The tagged finding still needs v2; nothing needs v3.
    expect(manifest.schemaVersion).toBe(ENGAGEMENT_EXPORT_VERSION_WITHOUT_AUDIT_LOG);
    expect(data.schemaVersion).toBe(ENGAGEMENT_EXPORT_VERSION_WITHOUT_AUDIT_LOG);
    // The export is still recorded, and says the log was left out.
    const own = await app.db.auditEntry.findFirstOrThrow({ where: { action: 'export' } });
    expect(own.summary).toContain('audit log left out');
  });

  it('keeps the newest entries when the log outgrows the bound, and says how many it lacks', async () => {
    const { eng, users } = await seedEngagement();
    const total = MAX_ENGAGEMENT_EXPORT_AUDIT_ENTRIES + 1;
    // Row n is n seconds into 2026: the highest n is the newest, and row 1 —
    // the oldest — is the one that must not make it into the file.
    await app.db.$executeRaw`
        INSERT INTO "audit_entries"
          (uuid, engagement_id, engagement_slug, engagement_name, actor_id, actor_name,
           actor_email, via, action, entity_type, entity_label, summary, changes,
           coalesced_count, source, created_at, last_at)
        SELECT gen_random_uuid()::text, ${eng.id}, 'op1', 'Op One', ${users.writer.id},
               'Wendy Writer', 'writer@test.local', 'session', 'update', 'evidence', 'bulk',
               'row ' || n, '[]'::jsonb, 1, 'intent', ts, ts
          FROM (SELECT n, timestamp '2026-01-01 00:00:00' + (n * interval '1 second') AS ts
                  FROM generate_series(1, ${total}) AS n) AS rows`;
    expect(await app.db.auditEntry.count()).toBe(total);

    const cookie = await loginCookie(app, 'writer@test.local', 'password123');
    const res = await app.inject({
      method: 'GET',
      url: '/web/engagements/op1/export.zip',
      headers: { ...WEB_HEADERS, cookie },
    });
    expect(res.statusCode).toBe(200);
    const zip = await readZip(res.rawPayload);
    const manifest = engagementExportManifestSchema.parse(
      JSON.parse(zip.files.get(ENGAGEMENT_EXPORT_MANIFEST_ENTRY)!.toString('utf8')),
    );
    // Not zod-parsed: a hundred thousand entries through the schema is the
    // importer's job, and the assertions here are about which rows travelled.
    const data = JSON.parse(zip.files.get(ENGAGEMENT_EXPORT_DATA_ENTRY)!.toString('utf8')) as {
      auditEntries: { summary: string }[];
    };
    expect(manifest.counts).toMatchObject({
      auditEntries: MAX_ENGAGEMENT_EXPORT_AUDIT_ENTRIES,
      auditEntriesTotal: total,
    });
    expect(data.auditEntries).toHaveLength(MAX_ENGAGEMENT_EXPORT_AUDIT_ENTRIES);
    expect(data.auditEntries[0]!.summary).toBe('row 2');
    expect(data.auditEntries[data.auditEntries.length - 1]!.summary).toBe(`row ${total}`);
    // The export entry reports the gap too.
    const own = await app.db.auditEntry.findFirstOrThrow({ where: { action: 'export' } });
    expect(own.summary).toContain(
      `${MAX_ENGAGEMENT_EXPORT_AUDIT_ENTRIES} of ${total} audit entries`,
    );
  }, 180_000);
});
