import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_TYPES,
  AUDIT_ENTITY_TYPE_LABELS,
  AUDIT_FIELD_LABELS,
  AUDIT_SOURCES,
  AUDIT_SOURCE_LABELS,
  AUDIT_VIAS,
  AUDIT_VIA_LABELS,
  MAX_AUDIT_CHANGES,
} from './enums.js';
import {
  ENGAGEMENT_EXPORT_VERSION,
  ENGAGEMENT_EXPORT_VERSION_WITHOUT_AUDIT_LOG,
  ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS,
  auditChangeSchema,
  auditChangesSchema,
  auditEntrySchema,
  auditFacetsSchema,
  auditListQuerySchema,
  engagementExportSchema,
  exportedAuditEntrySchema,
  removeAuditEntryInput,
} from './schemas.js';

// The audit vocabulary is the one thing every later layer compiles against — the
// server writes it, the routes filter on it, the web renders it, and the export
// carries it — so what is pinned here is that the vocabulary is closed, that every
// label map covers it exactly, and that the wire shapes accept what the server
// will actually produce.

describe('the vocabulary is closed and fully labelled', () => {
  it.each([
    ['AUDIT_VIAS', AUDIT_VIAS, AUDIT_VIA_LABELS],
    ['AUDIT_ACTIONS', AUDIT_ACTIONS, AUDIT_ACTION_LABELS],
    ['AUDIT_ENTITY_TYPES', AUDIT_ENTITY_TYPES, AUDIT_ENTITY_TYPE_LABELS],
    ['AUDIT_SOURCES', AUDIT_SOURCES, AUDIT_SOURCE_LABELS],
  ] as const)('%s has exactly one label per value', (_name, values, labels) => {
    expect(Object.keys(labels).sort()).toEqual([...values].sort());
    for (const v of values) expect(labels[v as keyof typeof labels]).toBeTruthy();
  });

  it('names no action as a suppression, and no entity type as the log itself', () => {
    // A removal is recorded in place on the row, never as a second entry.
    expect(AUDIT_ENTITY_TYPES as readonly string[]).not.toContain('audit_entry');
    // Denied attempts are deliberately not actions.
    for (const a of AUDIT_ACTIONS) expect(a).not.toMatch(/denied|forbidden|rejected/);
  });

  it('pins the entity labels to the words the UI already uses', () => {
    // DESIGN.md reserves "Comment" for linked evidence, which records as `evidence`.
    expect(AUDIT_ENTITY_TYPE_LABELS.evidence_comment).toBe('Evidence note');
    expect(AUDIT_ENTITY_TYPE_LABELS.report_settings).toBe('Report branding');
    expect(AUDIT_ENTITY_TYPE_LABELS.member).toBe('Member');
  });

  it('only labels fields of entity types that exist', () => {
    for (const type of Object.keys(AUDIT_FIELD_LABELS)) {
      expect(AUDIT_ENTITY_TYPES as readonly string[]).toContain(type);
    }
  });
});

describe('auditChangeSchema', () => {
  it('accepts every kind the server writes', () => {
    const changes = [
      { kind: 'field', field: 'title', from: 'a', to: 'b' },
      { kind: 'field', field: 'severity', from: null, to: 'high' },
      { kind: 'field', field: 'logo', from: { $opaque: 'blob', chars: 120 }, to: null },
      { kind: 'list', field: 'scopeTargets', from: [], to: [{ label: 'Head unit', hash: 'abc' }] },
      { kind: 'order', field: 'goals', from: ['a', 'b'], to: ['b', 'a'] },
      { kind: 'items', label: 'Evidence', items: ['CAN dump', 'Boot log'] },
      { kind: 'count', label: 'Evidence anonymized', count: 12 },
      { kind: 'elided', field: 'executiveSummary' },
    ];
    expect(auditChangesSchema.parse(changes)).toEqual(changes);
  });

  it('rejects an unknown kind, a kind missing its payload, and an overlong list', () => {
    expect(auditChangeSchema.safeParse({ kind: 'set', field: 'x', from: 1, to: 2 }).success).toBe(
      false,
    );
    expect(auditChangeSchema.safeParse({ kind: 'field', field: 'x' }).success).toBe(false);
    expect(auditChangeSchema.safeParse({ kind: 'count', label: 'x', count: -1 }).success).toBe(
      false,
    );
    expect(auditChangeSchema.safeParse({ kind: 'items', label: 'x' }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_AUDIT_CHANGES + 1 }, () => ({
      kind: 'elided',
      field: 'x',
    }));
    expect(auditChangesSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe('auditListQuerySchema', () => {
  it('accepts list parameters as repeated keys and as comma-separated values, deduplicated', () => {
    const repeated = auditListQuerySchema.parse({ action: ['create', 'update', 'create'] });
    expect(repeated.action).toEqual(['create', 'update']);
    const csv = auditListQuerySchema.parse({ action: 'create, update,,delete' });
    expect(csv.action).toEqual(['create', 'update', 'delete']);
    const mixed = auditListQuerySchema.parse({ entity: ['evidence,finding', 'tag'] });
    expect(mixed.entity).toEqual(['evidence', 'finding', 'tag']);
  });

  it('rejects an unknown action or entity type, and defaults the sort', () => {
    expect(auditListQuerySchema.safeParse({ action: 'create,explode' }).success).toBe(false);
    expect(auditListQuerySchema.safeParse({ entity: 'audit_entry' }).success).toBe(false);
    expect(auditListQuerySchema.safeParse({ sort: 'what' }).success).toBe(false);
    const parsed = auditListQuerySchema.parse({});
    expect(parsed.sort).toBe('when');
    expect(parsed.dir).toBe('desc');
    expect(parsed.action).toBeUndefined();
  });

  it('reads the no-engagement flag from the strings a URL carries', () => {
    expect(auditListQuerySchema.parse({ noEng: '1' }).noEng).toBe(true);
    expect(auditListQuerySchema.parse({ noEng: 'true' }).noEng).toBe(true);
    expect(auditListQuerySchema.parse({ noEng: '0' }).noEng).toBe(false);
    expect(auditListQuerySchema.parse({}).noEng).toBeUndefined();
  });

  it('keeps page and pageSize out — the routes read those with parsePagination', () => {
    const parsed = auditListQuerySchema.parse({ page: '3', pageSize: '50' });
    expect('page' in parsed).toBe(false);
    expect('pageSize' in parsed).toBe(false);
  });
});

describe('removeAuditEntryInput', () => {
  it('requires a non-blank, bounded reason', () => {
    expect(removeAuditEntryInput.parse({ reason: '  leaked token  ' }).reason).toBe('leaked token');
    expect(removeAuditEntryInput.safeParse({ reason: '   ' }).success).toBe(false);
    expect(removeAuditEntryInput.safeParse({}).success).toBe(false);
    expect(removeAuditEntryInput.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('the entry on the wire', () => {
  const entry = {
    uuid: 'e0a1b2c3-0000-4000-8000-000000000001',
    engagement: { slug: 'op1', name: 'Op One', deleted: false },
    actor: { name: 'Wendy Writer', email: 'writer@test.local', slug: 'wendy', currentName: null },
    via: 'session',
    action: 'update',
    entityType: 'evidence',
    entityId: 'e0a1b2c3-0000-4000-8000-000000000002',
    entityLabel: 'CAN dump',
    summary: 'Wendy Writer edited evidence “CAN dump”: Description',
    changes: [{ kind: 'field', field: 'description', from: 'a', to: 'b' }],
    coalescedCount: 3,
    source: 'intent',
    createdAt: '2026-10-09T10:00:00.000Z',
    lastAt: '2026-10-09T10:02:00.000Z',
    deleted: null,
  };

  it('round-trips a live entry and a tombstone', () => {
    expect(auditEntrySchema.parse(entry)).toEqual(entry);
    const tombstone = {
      ...entry,
      changes: [],
      summary: '',
      entityLabel: '',
      deleted: {
        at: '2026-10-09T11:00:00.000Z',
        byName: 'Ada Admin',
        byEmail: 'admin@test.local',
        bySlug: 'ada',
        reason: 'A credential was pasted into the description.',
      },
    };
    expect(auditEntrySchema.parse(tombstone)).toEqual(tombstone);
  });

  it('allows a system row with no actor and a site-wide row with no engagement', () => {
    const system = { ...entry, actor: null, engagement: null, via: 'system' };
    expect(auditEntrySchema.parse(system).actor).toBeNull();
  });

  it('refuses an unknown source or via', () => {
    expect(auditEntrySchema.safeParse({ ...entry, source: 'file' }).success).toBe(false);
    expect(auditEntrySchema.safeParse({ ...entry, via: 'web' }).success).toBe(false);
  });

  it('serves the engagement facet only when present, never required', () => {
    const facets = {
      actors: [
        { value: 'wendy', label: 'Wendy Writer', email: 'writer@test.local', deleted: false },
      ],
      actions: ['create', 'update'],
      entityTypes: ['evidence'],
      logStartsAt: null,
    };
    expect(auditFacetsSchema.parse(facets).engagements).toBeUndefined();
    expect(
      auditFacetsSchema.parse({
        ...facets,
        engagements: [{ slug: 'op1', name: 'Op One', deleted: true }],
      }).engagements,
    ).toHaveLength(1);
  });
});

describe('the entry in a backup', () => {
  it('applies the defaults an older or hand-trimmed file leaves out, and caps content', () => {
    const minimal = {
      uuid: 'e0a1b2c3-0000-4000-8000-000000000001',
      actorEmail: null,
      via: 'system',
      action: 'import',
      entityType: 'engagement',
      summary: 'Imported',
      createdAt: '2026-10-09T10:00:00.000Z',
      lastAt: '2026-10-09T10:00:00.000Z',
    };
    const parsed = exportedAuditEntrySchema.parse(minimal);
    expect(parsed.actorName).toBeNull();
    expect(parsed.entityId).toBeNull();
    expect(parsed.entityLabel).toBe('');
    expect(parsed.changes).toEqual([]);
    expect(parsed.coalescedCount).toBe(1);
    expect(
      exportedAuditEntrySchema.safeParse({ ...minimal, summary: 'x'.repeat(2049) }).success,
    ).toBe(false);
  });

  it('is absent from a v2 file and defaults to none', () => {
    // The whole-file schema must keep parsing an archive written before the log
    // existed; the version constants are what gate an older server.
    expect(ENGAGEMENT_EXPORT_VERSION).toBe(3);
    expect(ENGAGEMENT_EXPORT_VERSION_WITHOUT_AUDIT_LOG).toBe(2);
    expect(ENGAGEMENT_EXPORT_VERSION_WITHOUT_FINDING_TAGS).toBe(1);
    const shape = engagementExportSchema.shape;
    expect(shape.auditEntries.parse(undefined)).toEqual([]);
  });
});
