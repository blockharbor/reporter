import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIT_ENTRY_MAX_BYTES, AUDIT_VALUE_MAX_CHARS, MAX_AUDIT_CHANGES } from '@reporter/shared';
import type { AuditChange } from '@reporter/shared';
import {
  auditContext,
  bindAuditActor,
  getAuditContext,
  isSuppressed,
  newAuditContext,
  runAsSystem,
  tallyWrite,
  withImporter,
} from '../audit/context.js';
import { REDACTED_FIELDS, redactedValue, refOf, threatDiagramRefOf } from '../audit/models.js';
import type { AuthedUser } from '../types.js';
import {
  AUDIT_COALESCE_LOCK_NS,
  capChanges,
  coalesceOrInsert,
  diffEngagement,
  diffEvidence,
  diffFields,
  diffFinding,
  diffList,
  diffReportConfig,
  fieldLabel,
  inTx,
  n,
  planUpdateEntries,
  q,
  recordAudit,
  recordUpdate,
  withIntent,
  type AuditCtx,
  type EngagementAuditRow,
  type EvidenceAuditRow,
  type FindingAuditRow,
} from './audit.js';

// Everything the writer does that does not need Postgres is pinned here: the
// diff helpers (what a change looks like), the wording helpers (what a summary
// says), the caps (what the log refuses to hold), the per-field split, and —
// through fake clients — the shape of the fold SQL and the write-path policy.
// The fold's behaviour against real rows, the advisory lock and the trigger are
// the coalescing itest's job.

const actor: AuthedUser = {
  id: 7,
  slug: 'wendy-writer',
  email: 'writer@test.local',
  firstName: 'Wendy',
  lastName: 'Writer',
  admin: false,
  via: 'session',
};

function fakeLog() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

function ctxWith(
  db: unknown,
  over: Partial<AuditCtx> = {},
): AuditCtx & { log: ReturnType<typeof fakeLog> } {
  const log = fakeLog();
  return {
    actor,
    via: 'session',
    engagement: { id: 3, slug: 'acme-2026', name: 'Acme 2026' },
    db: db as AuditCtx['db'],
    inTransaction: false,
    log: log as unknown as FastifyBaseLogger,
    ...over,
  } as AuditCtx & { log: ReturnType<typeof fakeLog> };
}

/**
 * A transaction client that answers the advisory lock, the savepoints and the
 * fold. `foldResults` is consumed one per fold attempt (a number is affected
 * rows; an Error is thrown), so a test can script hits, misses and failures.
 */
function fakeTx(foldResults: Array<number | Error> = []) {
  const calls: { raw: string[]; folds: Prisma.Sql[] } = { raw: [], folds: [] };
  const tx = {
    $executeRaw: vi.fn(async (query: unknown) => {
      if (isSql(query)) {
        calls.folds.push(query);
        const next = foldResults.shift() ?? 0;
        if (next instanceof Error) throw next;
        return next;
      }
      // The tagged-template form: the advisory lock.
      calls.raw.push((query as TemplateStringsArray).join('?'));
      return 0;
    }),
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      calls.raw.push(sql);
      return 0;
    }),
    auditEntry: {
      create: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return { tx, calls };
}

/** A base client whose `$transaction` hands the fake tx to the callback. */
function fakeDb(foldResults: Array<number | Error> = []) {
  const inner = fakeTx(foldResults);
  const db = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(inner.tx)),
    auditEntry: inner.tx.auditEntry,
  };
  return { db, ...inner };
}

function foldText(sql: Prisma.Sql): string {
  return sql.strings.join('?').replace(/\s+/g, ' ');
}

/**
 * `Prisma.Sql` is a type at runtime, so a `Prisma.sql` object is told apart from
 * a tagged-template call by shape: a `Sql` carries `strings` and `values`, a
 * `TemplateStringsArray` carries `raw`.
 */
function isSql(query: unknown): query is Prisma.Sql {
  return (
    typeof query === 'object' &&
    query !== null &&
    Array.isArray((query as { strings?: unknown }).strings) &&
    Array.isArray((query as { values?: unknown }).values)
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('wording helpers', () => {
  it('q() wraps in typographic quotes and truncates long labels with an ellipsis', () => {
    expect(q('Weak TLS')).toBe('“Weak TLS”');
    expect(q('  padded  ')).toBe('“padded”');
    const long = q('x'.repeat(200));
    expect(long.startsWith('“')).toBe(true);
    expect(long.endsWith('…”')).toBe(true);
    // 120 chars of label at most: 119 kept + the ellipsis, inside the quotes.
    expect(long.length).toBe(122);
  });

  it('n() pluralizes, with the glossary uncountable evidence', () => {
    expect(n(1, 'finding')).toBe('1 finding');
    expect(n(2, 'finding')).toBe('2 findings');
    expect(n(0, 'finding')).toBe('0 findings');
    expect(n(3, 'evidence', 'evidence')).toBe('3 evidence');
    expect(n(2, 'activity', 'activities')).toBe('2 activities');
  });

  it('fieldLabel() uses the shared label and falls back to a de-camel-cased name', () => {
    expect(fieldLabel('engagement', 'executiveSummary')).toBe('Executive summary');
    expect(fieldLabel('engagement', 'reportConfig.sections')).toBe('Report sections');
    // Pinned in @reporter/shared: an Evidence note's body reads "Note", not "Body".
    expect(fieldLabel('evidence_comment', 'body')).toBe('Note');
    expect(fieldLabel('engagement', 'someNewColumnName')).toBe('Some new column name');
    expect(fieldLabel('engagement', 'reportConfig.brandNewFlag')).toBe('Brand new flag');
  });
});

// ---------------------------------------------------------------------------

describe('diffFields', () => {
  it('omits equal fields, stores Dates as ISO and collapses "" and undefined to null', () => {
    const before = {
      a: 'x',
      when: new Date('2026-01-02T03:04:05.000Z'),
      blank: '',
      missing: undefined,
    };
    const after = {
      a: 'x',
      when: new Date('2026-02-02T03:04:05.000Z'),
      blank: null,
      missing: null,
    };
    const changes = diffFields(before, after, ['a', 'when', 'blank', 'missing']);
    expect(changes).toEqual([
      {
        kind: 'field',
        field: 'when',
        from: '2026-01-02T03:04:05.000Z',
        to: '2026-02-02T03:04:05.000Z',
      },
    ]);
  });

  it('reads through an accessor spec', () => {
    const before = { category: { category: 'Crypto' } as { category: string } | null };
    const after = { category: null as { category: string } | null };
    expect(
      diffFields(before, after, [
        { field: 'category', value: (r) => r.category?.category ?? null },
      ]),
    ).toEqual([{ kind: 'field', field: 'category', from: 'Crypto', to: null }]);
  });

  it('detects a change to a redacted column but stores only the opaque stand-in', () => {
    const before = { passwordHash: '$argon2id$old', logoDataUri: 'data:image/png;base64,AAAA' };
    const after = { passwordHash: '$argon2id$new', logoDataUri: 'data:image/png;base64,BBBBBBBB' };
    const changes = diffFields(before, after, ['passwordHash', 'logoDataUri']);
    expect(changes).toEqual([
      {
        kind: 'field',
        field: 'passwordHash',
        from: { $opaque: 'secret' },
        to: { $opaque: 'secret' },
      },
      {
        kind: 'field',
        field: 'logoDataUri',
        from: { $opaque: 'blob', chars: 26 },
        to: { $opaque: 'blob', chars: 30 },
      },
    ]);
    expect(JSON.stringify(changes)).not.toContain('argon2');
    expect(JSON.stringify(changes)).not.toContain('base64');
  });

  it('shows a cleared redacted column as null, since there is nothing to hide', () => {
    expect(diffFields({ logoDataUri: 'data:x' }, { logoDataUri: null }, ['logoDataUri'])).toEqual([
      { kind: 'field', field: 'logoDataUri', from: { $opaque: 'blob', chars: 6 }, to: null },
    ]);
  });

  it('the redaction table covers every credential and inline-binary column', () => {
    for (const col of [
      'passwordHash',
      'totpSecret',
      'secretKey',
      'codeHash',
      'credentialId',
      'publicKey',
    ]) {
      expect(REDACTED_FIELDS.get(col)).toBe('secret');
    }
    for (const col of ['logoDataUri', 'imageDataUri', 'proposalImport']) {
      expect(REDACTED_FIELDS.get(col)).toBe('blob');
    }
    expect(redactedValue('title', 'anything')).toBeUndefined();
    expect(redactedValue('secretKey', Buffer.from('abc'))).toEqual({ $opaque: 'secret' });
  });
});

// ---------------------------------------------------------------------------

describe('diffList', () => {
  const byName = refOf((t: { name: string }) => t.name);

  it('returns nothing for identical lists and refs for changed ones', () => {
    const a = { items: [{ name: 'ECU', subsystems: ['CAN'] }] };
    expect(
      diffList(
        a,
        { items: [{ name: 'ECU', subsystems: ['CAN'] }] },
        { field: 'x', items: (r) => r.items, ref: byName },
      ),
    ).toEqual([]);
    const changes = diffList(
      a,
      {
        items: [
          { name: 'ECU', subsystems: ['CAN'] },
          { name: 'TCU', subsystems: [] },
        ],
      },
      {
        field: 'scopeTargets',
        items: (r) => r.items,
        ref: byName,
      },
    );
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    if (change.kind !== 'list') throw new Error('expected a list change');
    expect(change.field).toBe('scopeTargets');
    expect(change.from.map((r) => r.label)).toEqual(['ECU']);
    expect(change.to.map((r) => r.label)).toEqual(['ECU', 'TCU']);
    expect(change.to[0]!.hash).toBe(change.from[0]!.hash);
    expect(change.to[1]!.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('detects an in-place body edit as the same label with a new hash', () => {
    const before = { items: [{ name: 'ECU', subsystems: ['CAN'] }] };
    const after = { items: [{ name: 'ECU', subsystems: ['CAN', 'LIN'] }] };
    const [change] = diffList(before, after, { field: 'x', items: (r) => r.items, ref: byName });
    if (change?.kind !== 'list') throw new Error('expected a list change');
    expect(change.from[0]!.label).toBe(change.to[0]!.label);
    expect(change.from[0]!.hash).not.toBe(change.to[0]!.hash);
  });

  it('treats a non-array column as empty', () => {
    expect(
      diffList({ v: null }, { v: [{ name: 'a' }] }, { field: 'x', items: (r) => r.v, ref: byName }),
    ).toHaveLength(1);
    expect(
      diffList({ v: null }, { v: 'junk' }, { field: 'x', items: (r) => r.v, ref: byName }),
    ).toEqual([]);
  });

  it('the threat-diagram ref detects a replaced image without ever carrying the body', () => {
    const png = (fill: string) => `data:image/png;base64,${fill.repeat(10_000)}`;
    const before = { d: [{ caption: 'Attack surface', imageDataUri: png('A') }] };
    const same = { d: [{ caption: 'Attack surface', imageDataUri: png('A') }] };
    const replaced = { d: [{ caption: 'Attack surface', imageDataUri: png('B') }] };
    const spec = {
      field: 'threatModelDiagrams',
      items: (r: typeof before) => r.d,
      ref: threatDiagramRefOf,
    };
    expect(diffList(before, same, spec)).toEqual([]);
    const [change] = diffList(before, replaced, spec);
    if (change?.kind !== 'list') throw new Error('expected a list change');
    expect(change.from[0]!.label).toBe('Attack surface');
    expect(change.from[0]!.hash).not.toBe(change.to[0]!.hash);
    const json = JSON.stringify(change);
    expect(json).not.toContain('base64');
    expect(json.length).toBeLessThan(400);
    // An uncaptioned diagram gets a positional label.
    expect(threatDiagramRefOf({ imageDataUri: png('A') }, 2).label).toBe('Diagram 3');
  });
});

// ---------------------------------------------------------------------------

function engagement(over: Partial<EngagementAuditRow> = {}): EngagementAuditRow {
  return {
    name: 'Acme 2026',
    status: 'active',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    projectedEndAt: null,
    actualEndAt: null,
    clientName: null,
    assessmentType: null,
    testApproach: null,
    location: null,
    scope: null,
    executiveSummary: null,
    methodology: null,
    objectivesNarrative: null,
    threatModelNarrative: null,
    watermarkEnabled: true,
    watermarkText: null,
    watermarkColor: null,
    watermarkOpacity: 'medium',
    watermarkLayer: 'behind',
    scopeTargets: [],
    scopeExclusions: [],
    strategicRecommendations: [],
    threatModelDiagrams: [],
    executionNarrative: [],
    providerContacts: [],
    clientContacts: [],
    softwareTested: [],
    thirdPartySoftware: [],
    reportConfig: {},
    ...over,
  };
}

describe('diffEngagement', () => {
  it('yields exactly the changed columns across scalars, lists and the report config', () => {
    const before = engagement({
      executiveSummary: 'Old summary',
      scopeTargets: [{ name: 'ECU', subsystems: [] }],
      providerContacts: [{ name: '', title: '', email: 'ops@provider.test' }],
      softwareTested: [{ name: 'Firmware', version: '1.0' }],
    });
    const after = engagement({
      executiveSummary: 'New summary',
      status: 'complete',
      actualEndAt: new Date('2026-03-01T00:00:00.000Z'),
      scopeTargets: [
        { name: 'ECU', subsystems: [] },
        { name: 'TCU', subsystems: ['LTE'] },
      ],
      providerContacts: [{ name: '', title: '', email: 'ops@provider.test' }],
      softwareTested: [{ name: 'Firmware', version: '1.1' }],
      reportConfig: { includeAllFindings: true },
    });
    const changes = diffEngagement(before, after);
    const fields = changes.map((c) => ('field' in c ? c.field : c.label));
    expect(fields).toEqual([
      'status',
      'actualEndAt',
      'executiveSummary',
      'scopeTargets',
      'softwareTested',
      'reportConfig.includeAllFindings',
    ]);
    expect(changes[0]).toEqual({ kind: 'field', field: 'status', from: 'active', to: 'complete' });
    expect(changes[1]).toMatchObject({ from: null, to: '2026-03-01T00:00:00.000Z' });
    const software = changes[4];
    if (software?.kind !== 'list') throw new Error('expected a list change');
    expect(software.from[0]!.label).toBe('Firmware 1.0');
    expect(software.to[0]!.label).toBe('Firmware 1.1');
  });

  it('labels contacts by name, then email, then position', () => {
    const [change] = diffEngagement(
      engagement(),
      engagement({
        clientContacts: [
          { name: 'Ada', title: '', email: 'ada@acme.test' },
          { name: '', title: '', email: 'cto@acme.test' },
          { name: '', title: 'CISO', email: '' },
        ],
      }),
    );
    if (change?.kind !== 'list') throw new Error('expected a list change');
    expect(change.to.map((r) => r.label)).toEqual(['Ada', 'cto@acme.test', 'Contact 3']);
  });

  it('canonicalizes an unconfigured {} reportConfig so the first save does not diff as everything-added', () => {
    const canonical = {
      sections: [
        { key: 'executiveSummary', enabled: true },
        { key: 'assessmentFindings', enabled: true },
        { key: 'methodology', enabled: true },
        { key: 'threatModel', enabled: true },
        { key: 'assessmentExecution', enabled: true },
        { key: 'scopeCoverage', enabled: false },
        { key: 'detailedFindings', enabled: true },
        { key: 'supportingInformation', enabled: true },
        { key: 'appendix', enabled: true },
      ],
      customSections: [],
      includeAllFindings: false,
      includeEvidenceTimeline: false,
      evidenceGroup: 'chronological',
      numberExecutionSubsections: false,
      showEvidenceTimestamps: false,
      showEvidenceOperators: false,
      findingGroup: 'severity',
      showFindingLinkedGoals: true,
      showStrengthDetailCards: false,
      readinessNa: [],
    };
    expect(
      diffEngagement(engagement({ reportConfig: {} }), engagement({ reportConfig: canonical })),
    ).toEqual([]);
    expect(diffReportConfig(null, {})).toEqual([]);
    expect(diffReportConfig(undefined, canonical)).toEqual([]);
  });

  it('never diffs proposalImport (a redacted blob with its own entry)', () => {
    const before = {
      ...engagement(),
      proposalImport: { huge: 'x'.repeat(1000) },
    } as EngagementAuditRow;
    const after = {
      ...engagement(),
      proposalImport: { huge: 'y'.repeat(1000) },
    } as EngagementAuditRow;
    expect(diffEngagement(before, after)).toEqual([]);
  });
});

describe('diffReportConfig', () => {
  it('reports leaf flags by dotted field and sections as refs labelled with their state', () => {
    const before = {};
    const after = {
      sections: [
        { key: 'executiveSummary', enabled: false },
        { key: 'detailedFindings', enabled: true, options: { steps: false } },
      ],
      customSections: [{ id: 'c1', title: 'Disclaimer', body: 'Text' }],
      readinessNa: ['scope-defined'],
      showFindingLinkedGoals: false,
    };
    const changes = diffReportConfig(before, after);
    const byField = new Map(changes.map((c) => ['field' in c ? c.field : c.label, c]));
    expect([...byField.keys()]).toEqual([
      'reportConfig.showFindingLinkedGoals',
      'reportConfig.sections',
      'reportConfig.customSections',
      'reportConfig.readinessNa',
    ]);
    expect(byField.get('reportConfig.showFindingLinkedGoals')).toEqual({
      kind: 'field',
      field: 'reportConfig.showFindingLinkedGoals',
      from: true,
      to: false,
    });
    const sections = byField.get('reportConfig.sections');
    if (sections?.kind !== 'list') throw new Error('expected a list change');
    expect(sections.from).toHaveLength(9);
    expect(sections.from[5]!.label).toBe('scopeCoverage (off)');
    expect(sections.to.map((r) => r.label)).toEqual(['executiveSummary (off)', 'detailedFindings']);
    const custom = byField.get('reportConfig.customSections');
    if (custom?.kind !== 'list') throw new Error('expected a list change');
    expect(custom.to[0]!.label).toBe('Disclaimer');
    expect(JSON.stringify(custom)).not.toContain('Text');
    const na = byField.get('reportConfig.readinessNa');
    if (na?.kind !== 'list') throw new Error('expected a list change');
    expect(na.to[0]!.label).toBe('scope-defined');
  });
});

// ---------------------------------------------------------------------------

function finding(over: Partial<FindingAuditRow> = {}): FindingAuditRow {
  return {
    title: 'Weak TLS',
    description: '',
    kind: 'weakness',
    affectedTarget: '',
    impact: '',
    fixEffort: 'none',
    remediation: '',
    readyToReport: false,
    severity: null,
    cvssVector: null,
    iso21434Refs: [],
    unr155Refs: [],
    category: null,
    tags: [],
    ...over,
  };
}

describe('diffFinding', () => {
  it('diffs scalars, the category through its relation, the refs and the tag names, skipping cvssScore', () => {
    const before = { ...finding({ severity: 'low', cvssVector: 'CVSS:3.1/AV:N' }), cvssScore: 3.1 };
    const after = {
      ...finding({
        severity: 'high',
        cvssVector: 'CVSS:3.1/AV:N/AC:L',
        readyToReport: true,
        category: { category: 'Cryptography' },
        iso21434Refs: ['WP-09-01'],
        tags: [{ tag: { name: 'tls' } }, { tag: { name: 'network' } }],
      }),
      cvssScore: 7.5,
    };
    const changes = diffFinding(before, after);
    expect(changes.map((c) => ('field' in c ? c.field : c.label))).toEqual([
      'readyToReport',
      'severity',
      'cvssVector',
      'category',
      'iso21434Refs',
      'tags',
    ]);
    expect(changes).toContainEqual({
      kind: 'field',
      field: 'category',
      from: null,
      to: 'Cryptography',
    });
    const tags = changes.at(-1);
    if (tags?.kind !== 'list') throw new Error('expected a list change');
    expect(tags.to.map((r) => r.label)).toEqual(['tls', 'network']);
  });

  it('writes nothing for an unchanged finding', () => {
    expect(diffFinding(finding(), finding())).toEqual([]);
  });
});

function evidence(over: Partial<EvidenceAuditRow> = {}): EvidenceAuditRow {
  return {
    title: 'SQLi on login',
    description: '',
    occurredAt: new Date('2026-01-05T10:00:00.000Z'),
    contentType: 'codeblock',
    contentSubtype: 'bash',
    excludeFromReport: false,
    sha256: 'abc',
    sizeBytes: 12,
    parent: null,
    tags: [],
    ...over,
  };
}

describe('diffEvidence', () => {
  it('diffs the parent link as a uuid, the content as hash+size, and the tags as names', () => {
    const changes = diffEvidence(
      evidence(),
      evidence({
        occurredAt: new Date('2026-01-06T10:00:00.000Z'),
        excludeFromReport: true,
        parent: { uuid: 'p-uuid' },
        sha256: 'def',
        sizeBytes: 40,
        tags: [{ tag: { name: 'web' } }],
      }),
    );
    expect(changes.map((c) => ('field' in c ? c.field : c.label))).toEqual([
      'occurredAt',
      'excludeFromReport',
      'parent',
      'content',
      'tags',
    ]);
    expect(changes).toContainEqual({ kind: 'field', field: 'parent', from: null, to: 'p-uuid' });
    expect(changes).toContainEqual({
      kind: 'field',
      field: 'content',
      from: { sha256: 'abc', sizeBytes: 12 },
      to: { sha256: 'def', sizeBytes: 40 },
    });
  });

  it('reads a never-stored blob as null content', () => {
    expect(
      diffEvidence(
        evidence({ sha256: null, sizeBytes: null }),
        evidence({ sha256: null, sizeBytes: null }),
      ),
    ).toEqual([]);
    expect(diffEvidence(evidence({ sha256: null, sizeBytes: null }), evidence())).toEqual([
      { kind: 'field', field: 'content', from: null, to: { sha256: 'abc', sizeBytes: 12 } },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('capChanges', () => {
  it('passes small change lists through untouched', () => {
    const changes: AuditChange[] = [
      { kind: 'field', field: 'title', from: 'a', to: 'b' },
      { kind: 'count', label: 'Evidence', count: 3 },
    ];
    expect(capChanges(changes)).toEqual(changes);
  });

  it('drops changes past MAX_AUDIT_CHANGES', () => {
    const many: AuditChange[] = Array.from({ length: MAX_AUDIT_CHANGES + 20 }, (_, i) => ({
      kind: 'count',
      label: `c${i}`,
      count: i,
    }));
    const log = fakeLog();
    const out = capChanges(many, log as unknown as FastifyBaseLogger);
    expect(out).toHaveLength(MAX_AUDIT_CHANGES);
    expect(log.warn).toHaveBeenCalledWith({ dropped: 20 }, expect.stringContaining('truncated'));
  });

  it('replaces an oversize value with an opaque marker carrying its length', () => {
    const big = 'x'.repeat(AUDIT_VALUE_MAX_CHARS + 1);
    const [change] = capChanges([
      { kind: 'field', field: 'executiveSummary', from: 'short', to: big },
    ]);
    expect(change).toEqual({
      kind: 'field',
      field: 'executiveSummary',
      from: 'short',
      to: { $opaque: 'oversize', chars: AUDIT_VALUE_MAX_CHARS + 1 },
    });
    const bigObject = { body: 'y'.repeat(AUDIT_VALUE_MAX_CHARS) };
    const [objChange] = capChanges([
      { kind: 'field', field: 'content', from: null, to: bigObject },
    ]);
    expect(objChange).toMatchObject({ to: { $opaque: 'oversize' } });
    // Exactly at the cap is stored verbatim.
    const [edge] = capChanges([
      { kind: 'field', field: 'f', from: null, to: 'z'.repeat(AUDIT_VALUE_MAX_CHARS) },
    ]);
    expect(typeof (edge as { to: unknown }).to).toBe('string');
  });

  it('elides the largest changes first until the entry fits, keeping the small ones', () => {
    const wide = (field: string): AuditChange => ({
      kind: 'field',
      field,
      from: 'a'.repeat(15_000),
      to: 'b'.repeat(15_000),
    });
    const changes: AuditChange[] = [
      { kind: 'field', field: 'title', from: 'a', to: 'b' },
      wide('executiveSummary'),
      wide('methodology'),
      { kind: 'items', label: 'Tags', items: ['one', 'two'] },
      wide('scope'),
      wide('objectivesNarrative'),
      wide('threatModelNarrative'),
    ];
    const log = fakeLog();
    const out = capChanges(changes, log as unknown as FastifyBaseLogger);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(AUDIT_ENTRY_MAX_BYTES);
    expect(out[0]).toEqual(changes[0]);
    expect(out[3]).toEqual(changes[3]);
    const elided = out.filter((c) => c.kind === 'elided');
    expect(elided).toHaveLength(3);
    expect(
      out.filter(
        (c) => c.kind === 'field' && typeof c.from === 'string' && c.from.length === 15_000,
      ),
    ).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bytes: expect.any(Number) }),
      expect.stringContaining('elided'),
    );
  });

  it('names an elided items/count change by its label', () => {
    const changes: AuditChange[] = [
      {
        kind: 'items',
        label: 'Comments deleted',
        items: Array.from({ length: 300 }, () => 'c'.repeat(250)),
      },
    ];
    expect(capChanges(changes)).toEqual([{ kind: 'elided', field: 'Comments deleted' }]);
  });
});

// ---------------------------------------------------------------------------

describe('planUpdateEntries', () => {
  it('splits a change list into one coalescable entry per field with a fixed summary', () => {
    const entries = planUpdateEntries({
      entityType: 'engagement',
      entity: { id: '3', label: 'Acme 2026' },
      noun: 'engagement',
      changes: [
        { kind: 'field', field: 'executiveSummary', from: 'a', to: 'b' },
        { kind: 'list', field: 'scopeTargets', from: [], to: [{ label: 'ECU', hash: 'h' }] },
      ],
      source: 'backstop',
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      action: 'update',
      entityType: 'engagement',
      entity: { id: '3', label: 'Acme 2026' },
      summary: 'Edited engagement “Acme 2026”: Executive summary',
      coalesceKey: 'executiveSummary',
      source: 'backstop',
    });
    expect(entries[0]!.changes).toEqual([
      { kind: 'field', field: 'executiveSummary', from: 'a', to: 'b' },
    ]);
    expect(entries[1]).toMatchObject({
      summary: 'Edited engagement “Acme 2026”: Scope targets',
      coalesceKey: 'scopeTargets',
    });
    // The summary never embeds the `to` value — it would go stale on fold.
    expect(entries[0]!.summary).not.toContain('b');
  });

  it('leaves out kinds that cannot fold', () => {
    const entries = planUpdateEntries({
      entityType: 'finding',
      entity: { id: 'u', label: 'Weak TLS' },
      noun: 'finding',
      changes: [
        { kind: 'count', label: 'Evidence', count: 1 },
        { kind: 'field', field: 'severity', from: 'low', to: 'high' },
        { kind: 'order', field: 'evidence', from: ['a'], to: ['b'] },
      ],
    });
    expect(entries.map((e) => e.coalesceKey)).toEqual(['severity']);
  });
});

// ---------------------------------------------------------------------------

describe('recordAudit', () => {
  const input = {
    action: 'delete' as const,
    entityType: 'finding' as const,
    entity: { id: 'f-uuid', label: 'Weak TLS' },
    summary: 'Deleted finding “Weak TLS”',
    changes: [{ kind: 'count' as const, label: 'Evidence links', count: 2 }],
  };

  it('stamps the actor snapshot, via, engagement snapshot and the intent source', async () => {
    const create = vi.fn(async () => ({}));
    const ctx = ctxWith({ auditEntry: { create } });
    await recordAudit(ctx, input);
    expect(create).toHaveBeenCalledTimes(1);
    const { data } = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
    expect(data).toMatchObject({
      engagementId: 3,
      engagementSlug: 'acme-2026',
      engagementName: 'Acme 2026',
      actorId: 7,
      actorName: 'Wendy Writer',
      actorEmail: 'writer@test.local',
      via: 'session',
      action: 'delete',
      entityType: 'finding',
      entityId: 'f-uuid',
      entityLabel: 'Weak TLS',
      summary: 'Deleted finding “Weak TLS”',
      changes: [{ kind: 'count', label: 'Evidence links', count: 2 }],
      coalesceKey: null,
      source: 'intent',
    });
  });

  it('writes a null actor as a system row and honours an explicit null engagement', async () => {
    const create = vi.fn(async () => ({}));
    const ctx = ctxWith({ auditEntry: { create } }, { actor: null, via: 'system' });
    await recordAudit(ctx, { ...input, engagement: null, source: 'backstop' });
    const { data } = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
    expect(data).toMatchObject({
      engagementId: null,
      engagementSlug: null,
      actorId: null,
      actorName: null,
      actorEmail: null,
      via: 'system',
      source: 'backstop',
    });
  });

  it('drops a malformed change, logs it, and still writes the entry', async () => {
    const create = vi.fn(async () => ({}));
    const ctx = ctxWith({ auditEntry: { create } });
    await recordAudit(ctx, {
      ...input,
      changes: [
        { kind: 'count', label: '', count: 1 } as AuditChange,
        { kind: 'field', field: 'severity', from: 'low', to: null },
      ],
    });
    const { data } = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
    expect(data.changes).toEqual([{ kind: 'field', field: 'severity', from: 'low', to: null }]);
    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'count' }),
      expect.stringContaining('malformed'),
    );
  });

  it('is best-effort outside a transaction and atomic inside one', async () => {
    const boom = new Error('db down');
    const create = vi.fn(async () => {
      throw boom;
    });
    const ctx = ctxWith({ auditEntry: { create } });
    await expect(recordAudit(ctx, input)).resolves.toBeUndefined();
    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom }),
      expect.any(String),
    );

    const tx = { auditEntry: { create } } as unknown as Prisma.TransactionClient;
    await expect(recordAudit(inTx(ctx, tx), input)).rejects.toBe(boom);
  });
});

// ---------------------------------------------------------------------------

describe('recordUpdate and the fold', () => {
  const update = {
    entityType: 'engagement' as const,
    entity: { id: '3', label: 'Acme 2026' },
    noun: 'engagement',
    changes: [
      { kind: 'field' as const, field: 'scope', from: 'old', to: 'new' },
      { kind: 'field' as const, field: 'executiveSummary', from: 'a', to: 'b' },
      { kind: 'list' as const, field: 'scopeTargets', from: [], to: [{ label: 'ECU', hash: 'h' }] },
    ],
  };

  it('writes nothing for an empty change list', async () => {
    const { db, tx } = fakeDb();
    await recordUpdate(ctxWith(db), { ...update, changes: [] });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.auditEntry.createMany).not.toHaveBeenCalled();
  });

  it('locks each key in sorted order, folds, and batches the misses into one createMany', async () => {
    // executiveSummary folds; scope and scopeTargets miss.
    const { db, tx, calls } = fakeDb([1, 0, 0]);
    const ctx = ctxWith(db);
    await recordUpdate(ctx, update);

    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 15_000,
      timeout: 120_000,
    });
    expect(calls.folds).toHaveLength(3);
    // Sorted by key: executiveSummary < scope < scopeTargets.
    const lockValues = (tx.$executeRaw.mock.calls as unknown[][])
      .filter(([q]) => !isSql(q))
      .map(([, ns, key]) => [ns, key]);
    expect(lockValues).toEqual([
      [AUDIT_COALESCE_LOCK_NS, '7|engagement|3|executiveSummary'],
      [AUDIT_COALESCE_LOCK_NS, '7|engagement|3|scope'],
      [AUDIT_COALESCE_LOCK_NS, '7|engagement|3|scopeTargets'],
    ]);
    expect(calls.raw.filter((s) => s.includes('pg_advisory_xact_lock'))).toHaveLength(3);
    // Every fold ran under its own savepoint and released it.
    expect(calls.raw.filter((s) => s === 'SAVEPOINT audit_fold')).toHaveLength(3);
    expect(calls.raw.filter((s) => s === 'RELEASE SAVEPOINT audit_fold')).toHaveLength(3);

    expect(tx.auditEntry.create).not.toHaveBeenCalled();
    expect(tx.auditEntry.createMany).toHaveBeenCalledTimes(1);
    const { data } = (
      tx.auditEntry.createMany.mock.calls[0] as unknown as [
        { data: Array<Record<string, unknown>> },
      ]
    )[0];
    expect(data.map((r) => r.coalesceKey)).toEqual(['scope', 'scopeTargets']);
    expect(data[0]).toMatchObject({
      summary: 'Edited engagement “Acme 2026”: Scope',
      changes: [{ kind: 'field', field: 'scope', from: 'old', to: 'new' }],
      actorName: 'Wendy Writer',
    });
    expect(ctx.log.error).not.toHaveBeenCalled();
  });

  it('uses a single create for a single miss', async () => {
    const { db, tx } = fakeDb([0]);
    await recordUpdate(ctxWith(db), { ...update, changes: [update.changes[0]!] });
    expect(tx.auditEntry.create).toHaveBeenCalledTimes(1);
    expect(tx.auditEntry.createMany).not.toHaveBeenCalled();
  });

  it('the fold SET list names only the three columns the trigger allows, with deleted_at IS NULL in both WHEREs and no action predicate', async () => {
    const { db, calls } = fakeDb([1]);
    await recordUpdate(ctxWith(db), { ...update, changes: [update.changes[0]!] });
    const text = foldText(calls.folds[0]!);
    const setList = text.slice(text.indexOf('SET') + 3, text.indexOf('WHERE'));
    expect(setList).toContain('changes = jsonb_set(e.changes');
    expect(setList).toContain('coalesced_count = e.coalesced_count + 1');
    expect(setList).toContain('last_at =');
    expect(setList).not.toMatch(/summary|actor|entity|created_at|source|coalesce_key|engagement/);
    expect(text.match(/deleted_at IS NULL/g)).toHaveLength(2);
    expect(text).toMatch(/WHERE e\.deleted_at IS NULL AND e\.id = \(/);
    expect(text).not.toContain('action');
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('s.actor_id IS DISTINCT FROM c.actor_id');
    expect(text).toContain("'{0,to}'");
    expect(calls.folds[0]!.values).toContain(JSON.stringify('new'));
    expect(calls.folds[0]!.values).toContain(7);
    expect(calls.folds[0]!.values).toContain('scope');
  });

  it('skips jsonb_set for a change-less coalescable entry', async () => {
    const { db, calls, tx } = fakeDb([1]);
    await coalesceOrInsert(ctxWith(db, { engagement: null }), {
      action: 'api_key_auth',
      entityType: 'user',
      entity: { id: 'wendy-writer', label: 'Wendy Writer' },
      summary: 'Authenticated with an API key',
      coalesceKey: 'auth',
    });
    const text = foldText(calls.folds[0]!);
    expect(text).not.toContain('jsonb_set');
    expect(text).toContain('SET coalesced_count = e.coalesced_count + 1');
    expect(calls.folds[0]!.values).toContain('auth');
    expect(tx.auditEntry.create).not.toHaveBeenCalled();
  });

  it('retries a failed fold once under the savepoint, then inserts, never failing the caller', async () => {
    const boom = new Error('restrict_violation');
    const { tx, calls } = fakeTx([boom, boom]);
    const ctx = inTx(ctxWith({}), tx as unknown as Prisma.TransactionClient);
    await expect(
      recordUpdate(ctx, { ...update, changes: [update.changes[0]!] }),
    ).resolves.toBeUndefined();
    expect(calls.folds).toHaveLength(2);
    expect(calls.raw.filter((s) => s === 'ROLLBACK TO SAVEPOINT audit_fold')).toHaveLength(2);
    expect(tx.auditEntry.create).toHaveBeenCalledTimes(1);

    // One failure then a hit: folded, nothing inserted.
    const second = fakeTx([boom, 1]);
    await recordUpdate(inTx(ctxWith({}), second.tx as unknown as Prisma.TransactionClient), {
      ...update,
      changes: [update.changes[0]!],
    });
    expect(second.calls.folds).toHaveLength(2);
    expect(second.tx.auditEntry.create).not.toHaveBeenCalled();
  });

  it('inside a transaction a failed INSERT propagates; outside it is logged and swallowed', async () => {
    const boom = new Error('insert failed');
    const { tx } = fakeTx([0]);
    tx.auditEntry.create.mockRejectedValueOnce(boom);
    const ctx = ctxWith({});
    await expect(
      recordUpdate(inTx(ctx, tx as unknown as Prisma.TransactionClient), {
        ...update,
        changes: [update.changes[0]!],
      }),
    ).rejects.toBe(boom);

    const { db, tx: tx2 } = fakeDb([0]);
    tx2.auditEntry.create.mockRejectedValueOnce(boom);
    const outer = ctxWith(db);
    await expect(
      recordUpdate(outer, { ...update, changes: [update.changes[0]!] }),
    ).resolves.toBeUndefined();
    expect(outer.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom }),
      'audit: failed to record update',
    );
  });
});

// ---------------------------------------------------------------------------

describe('withIntent', () => {
  it('runs under a fresh system store when there is none', async () => {
    expect(getAuditContext()).toBeUndefined();
    const seen = await withIntent(['tag'], async () => {
      const store = getAuditContext()!;
      return {
        via: store.via,
        suppressed: isSuppressed(store, 'tag'),
        other: isSuppressed(store, 'evidence'),
      };
    });
    expect(seen).toEqual({ via: 'system', suppressed: true, other: false });
  });

  it('suppresses only the named models for the scope and restores the set afterwards, even on throw', async () => {
    await runAsSystem(async () => {
      const store = getAuditContext()!;
      await expect(
        withIntent(['tag', 'evidenceTag'], async () => {
          expect([...store.suppress]).toEqual(['tag', 'evidenceTag']);
          throw new Error('handler failed');
        }),
      ).rejects.toThrow('handler failed');
      expect(store.suppress.size).toBe(0);
    });
  });

  it('leaves a model suppressed by an outer scope to that scope when nested', async () => {
    await runAsSystem(async () => {
      const store = getAuditContext()!;
      await withIntent(['tag'], async () => {
        await withIntent(['tag', 'findingTag'], async () => {
          expect(store.suppress.has('findingTag')).toBe(true);
        });
        expect(store.suppress.has('tag')).toBe(true);
        expect(store.suppress.has('findingTag')).toBe(false);
      });
      expect(store.suppress.size).toBe(0);
    });
  });

  it('throws under NODE_ENV=test when a listed model was written and nothing was recorded', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    await runAsSystem(async () => {
      const store = getAuditContext()!;
      await expect(
        withIntent(['tag'], async () => {
          tallyWrite(store, 'tag');
        }),
      ).rejects.toThrow('wrote tag but recorded nothing');
    });
  });

  it('logs instead of throwing outside tests', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const log = fakeLog();
    await runAsSystem(
      async () => {
        const store = getAuditContext()!;
        await withIntent(['tag'], async () => {
          tallyWrite(store, 'tag');
        });
        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({ models: ['tag'] }),
          expect.stringContaining('recorded nothing'),
        );
      },
      log as unknown as FastifyBaseLogger,
    );
  });

  it('is satisfied by an entry recorded inside the scope, and ignores unlisted writes', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    await runAsSystem(async () => {
      const store = getAuditContext()!;
      const create = vi.fn(async () => ({}));
      await withIntent(['tag'], async () => {
        tallyWrite(store, 'tag');
        tallyWrite(store, 'activityGoal'); // not listed: the backstop's business
        await recordAudit(ctxWith({ auditEntry: { create } }), {
          action: 'merge',
          entityType: 'tag',
          entity: { id: '1', label: 'web' },
          summary: 'Merged tag “old” into “web”',
        });
      });
      expect(store.recorded.get('tag')).toBe(1);
      expect(store.recorded.get('activityGoal')).toBeUndefined();
    });
  });

  it('does not run the check when the scope threw (its writes rolled back)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    await runAsSystem(async () => {
      const store = getAuditContext()!;
      await expect(
        withIntent(['tag'], async () => {
          tallyWrite(store, 'tag');
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
    });
  });
});

// ---------------------------------------------------------------------------

describe('audit context', () => {
  it('starts as a system store with nothing suppressed', () => {
    const store = newAuditContext('req-1');
    expect(store).toMatchObject({
      requestId: 'req-1',
      actor: null,
      via: 'system',
      suppressAll: 0,
      importer: null,
      log: null,
    });
    expect(store.suppress.size).toBe(0);
    expect(store.writes.size).toBe(0);
  });

  it('bindAuditActor mutates the live store and is a no-op without one', async () => {
    bindAuditActor(actor); // no store: nothing to do, nothing thrown
    await auditContext.run(newAuditContext('req-2'), async () => {
      bindAuditActor({ ...actor, via: 'apikey' });
      expect(getAuditContext()).toMatchObject({ actor: { id: 7 }, via: 'apikey' });
    });
  });

  it('withImporter runs on a copy: suppressAll and the tag never leak back', async () => {
    await runAsSystem(async () => {
      const parent = getAuditContext()!;
      const inside = await withImporter('engagement-import', async (counts) => {
        counts['tag'] = 3;
        const store = getAuditContext()!;
        return {
          suppressAll: store.suppressAll,
          tag: store.importer?.tag,
          allSuppressed: isSuppressed(store, 'user'),
        };
      });
      expect(inside).toEqual({ suppressAll: 1, tag: 'engagement-import', allSuppressed: true });
      expect(parent.suppressAll).toBe(0);
      expect(parent.importer).toBeNull();
      expect(isSuppressed(parent, 'user')).toBe(false);
    });
    // And with no store at all it still provides one.
    const tag = await withImporter('seed', async () => getAuditContext()!.importer!.tag);
    expect(tag).toBe('seed');
  });

  it('tallyWrite counts per model', () => {
    const store = newAuditContext(null);
    tallyWrite(store, 'tag');
    tallyWrite(store, 'tag');
    tallyWrite(store, 'user');
    expect([...store.writes]).toEqual([
      ['tag', 2],
      ['user', 1],
    ]);
  });
});
