import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { AUDIT_ENTITY_TYPES } from '@reporter/shared';
import {
  afterImage,
  countOf,
  dataRows,
  diffRow,
  overlay,
  snapshotChanges,
  summarizeNested,
} from './diff.js';
import {
  ALL_AUDITED_MODELS,
  AUDITED_MODEL_NAMES,
  MODEL_SPECS,
  REDACTED_FIELDS,
  UNAUDITED_MODELS,
  delegateOf,
  type RowSpec,
} from './models.js';
import { plural } from './extension.js';

// The backstop's pure half: the structural diff through a model spec, the
// after-image rules for writes Prisma does not return a row for, the nested
// relation summaries, and — because the spec table is the one place a secret
// column could slip past — the proof that every spec is total over the real
// schema. The extension's behaviour against a database is the backstop itest.

const row = (name: string) => MODEL_SPECS[name as keyof typeof MODEL_SPECS] as RowSpec;

describe('diffRow', () => {
  const tag = row('Tag');

  it('reports only the changed allowlisted columns', () => {
    const before = { id: 1, engagementId: 3, name: 'recon', colorName: 'blue', position: 0 };
    const after = { ...before, name: 'reconnaissance' };
    expect(diffRow(before, after, tag)).toEqual([
      { kind: 'field', field: 'name', from: 'recon', to: 'reconnaissance' },
    ]);
    expect(diffRow(before, { ...before }, tag)).toEqual([]);
  });

  it('produces NO changes when only ignored or unlisted columns moved', () => {
    const evidence = row('Evidence');
    const before = {
      id: 1,
      uuid: 'u',
      title: 'CAN dump',
      lastEditedById: null,
      updatedAt: new Date(1),
    };
    const after = { ...before, lastEditedById: 7, updatedAt: new Date(2), fullBlobKey: 'k2' };
    expect(diffRow(before, after, evidence)).toEqual([]);
  });

  it('stores Dates as ISO strings and collapses "" and undefined to null', () => {
    const evidence = row('Evidence');
    const before = { occurredAt: new Date('2026-01-01T00:00:00.000Z'), description: '' };
    const after = { occurredAt: new Date('2026-02-01T00:00:00.000Z'), description: undefined };
    expect(diffRow(before, after, evidence)).toEqual([
      {
        kind: 'field',
        field: 'occurredAt',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      },
    ]);
  });

  it('detects a change to a redacted column but never serialises its value', () => {
    const settings = row('ReportSettings');
    const before = { id: 1, logoDataUri: null, organizationName: 'BH' };
    const after = {
      id: 1,
      logoDataUri: 'data:image/png;base64,SECRETLOGOBYTES',
      organizationName: 'BH',
    };
    const changes = diffRow(before, after, settings);
    expect(changes).toEqual([
      { kind: 'field', field: 'logoDataUri', from: null, to: { $opaque: 'blob', chars: 37 } },
    ]);
    expect(JSON.stringify(changes)).not.toContain('SECRETLOGOBYTES');
  });

  it('diffs list columns as refs through the spec', () => {
    const finding = row('Finding');
    const before = { iso21434Refs: ['A'], unr155Refs: [] };
    const after = { iso21434Refs: ['A', 'B'], unr155Refs: [] };
    const [change] = diffRow(before, after, finding);
    if (change?.kind !== 'list') throw new Error('expected a list change');
    expect(change.field).toBe('iso21434Refs');
    expect(change.to.map((r) => r.label)).toEqual(['A', 'B']);
  });

  it('diffs a structured column by leaf, re-prefixed with the real column name', () => {
    const template = row('ReportTemplate');
    const before = { config: {} };
    const after = { config: { includeAllFindings: true } };
    expect(diffRow(before, after, template)).toEqual([
      { kind: 'field', field: 'config.includeAllFindings', from: false, to: true },
    ]);
  });

  it('hands an engagement row to the shared engagement differ, plus slug and the redacted proposal', () => {
    const engagement = row('Engagement');
    const before = { slug: 'acme', name: 'Acme', proposalImport: null, executiveSummary: 'a' };
    const after = {
      slug: 'acme-2026',
      name: 'Acme',
      proposalImport: { huge: 'x'.repeat(100) },
      executiveSummary: 'b',
    };
    const changes = diffRow(before, after, engagement);
    expect(changes.map((c) => ('field' in c ? c.field : c.label))).toEqual([
      'slug',
      'proposalImport',
      'executiveSummary',
    ]);
    expect(changes[1]).toMatchObject({ to: { $opaque: 'blob' } });
    expect(JSON.stringify(changes)).not.toContain('xxxx');
  });

  it('never lets a threat-model diagram body near the entry', () => {
    const engagement = row('Engagement');
    const body = `data:image/png;base64,${'Q'.repeat(50_000)}`;
    const changes = diffRow(
      { threatModelDiagrams: [] },
      { threatModelDiagrams: [{ caption: 'Surface', imageDataUri: body }] },
      engagement,
    );
    const json = JSON.stringify(changes);
    expect(json).toContain('Surface');
    expect(json).not.toContain('QQQQ');
    expect(json.length).toBeLessThan(300);
  });
});

describe('snapshotChanges', () => {
  it('a create is the diff from nothing and a delete the diff to nothing', () => {
    const tag = row('Tag');
    const r = { id: 1, name: 'recon', colorName: 'blue', position: 2 };
    expect(snapshotChanges(r, tag, 'create')).toEqual([
      { kind: 'field', field: 'name', from: null, to: 'recon' },
      { kind: 'field', field: 'colorName', from: null, to: 'blue' },
      { kind: 'field', field: 'position', from: null, to: 2 },
    ]);
    expect(snapshotChanges(r, tag, 'delete')).toEqual([
      { kind: 'field', field: 'name', from: 'recon', to: null },
      { kind: 'field', field: 'colorName', from: 'blue', to: null },
      { kind: 'field', field: 'position', from: 2, to: null },
    ]);
  });
});

describe('afterImage', () => {
  const cols = ['name', 'position', 'count'];

  it('applies plain values, unwraps { set } and evaluates the numeric operators', () => {
    const before = { name: 'a', position: 2, count: 10, other: 'kept' };
    expect(afterImage(before, { name: 'b' }, cols)).toEqual({ ...before, name: 'b' });
    expect(afterImage(before, { name: { set: 'c' } }, cols)).toEqual({ ...before, name: 'c' });
    expect(afterImage(before, { position: { increment: 3 } }, cols).position).toBe(5);
    expect(afterImage(before, { position: { decrement: 1 } }, cols).position).toBe(1);
    expect(afterImage(before, { count: { multiply: 2 } }, cols).count).toBe(20);
    expect(afterImage(before, { count: { divide: 5 } }, cols).count).toBe(2);
    expect(afterImage(before, { count: { divide: 0 } }, cols).count).toBe(10);
  });

  it('keeps the before value for an operator it cannot evaluate, and ignores unlisted columns', () => {
    const before = { name: 'a', position: 2 };
    expect(afterImage(before, { name: { increment: 1 } }, cols).name).toBe('a');
    expect(afterImage(before, { position: { push: 1 } }, cols).position).toBe(2);
    expect(afterImage(before, { secret: 'x' }, cols)).toEqual(before);
    expect(afterImage(before, 'junk', cols)).toEqual(before);
  });

  it('starts a create from nothing', () => {
    expect(afterImage({}, { name: 'n', position: 0 }, cols)).toEqual({ name: 'n', position: 0 });
  });
});

describe('overlay', () => {
  it('takes only the named columns that the result carries', () => {
    const before = { name: 'a', position: 1 };
    expect(overlay(before, { name: 'b', extra: 1 }, ['name', 'position'])).toEqual({
      name: 'b',
      position: 1,
    });
    expect(overlay(before, null, ['name'])).toEqual(before);
  });
});

describe('summarizeNested', () => {
  it('counts relation operators at the top level of the payload and never reads them', () => {
    const data = {
      slug: 'acme',
      tags: { create: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      roles: { create: { userId: 1, role: 'admin' } },
      identities: { create: { scheme: 'local', passwordHash: '$argon2id$SECRET' } },
      evidence: { createMany: { data: [{}, {}] } },
      reportConfig: { sections: [], customSections: [] },
    };
    const changes = summarizeNested(data);
    expect(changes).toEqual([
      { kind: 'count', label: 'Tags created', count: 3 },
      { kind: 'count', label: 'Roles created', count: 1 },
      { kind: 'count', label: 'Identities created', count: 1 },
      { kind: 'count', label: 'Evidence created', count: 2 },
    ]);
    expect(JSON.stringify(changes)).not.toContain('argon2');
  });

  it('is empty for a non-object payload and for a payload with no relation writes', () => {
    expect(summarizeNested(undefined)).toEqual([]);
    expect(summarizeNested([{ a: 1 }])).toEqual([]);
    expect(summarizeNested({ name: 'x', position: { increment: 1 } })).toEqual([]);
  });
});

describe('countOf and dataRows', () => {
  it('reads a count result, an array result, or one row', () => {
    expect(countOf({ count: 7 })).toBe(7);
    expect(countOf([{}, {}])).toBe(2);
    expect(countOf({ id: 1 })).toBe(1);
  });

  it('turns createMany data into rows', () => {
    expect(dataRows([{ a: 1 }, 'junk', { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(dataRows({ a: 1 })).toEqual([{ a: 1 }]);
    expect(dataRows(null)).toEqual([]);
  });
});

describe('plural', () => {
  it('follows the glossary', () => {
    expect(plural('evidence')).toBe('evidence');
    expect(plural('finding evidence')).toBe('finding evidence');
    expect(plural('report branding')).toBe('report branding');
    expect(plural('finding category')).toBe('finding categories');
    expect(plural('saved query')).toBe('saved queries');
    expect(plural('tag')).toBe('tags');
    expect(plural('evidence note')).toBe('evidence notes');
  });
});

// ---------------------------------------------------------------------------
// The spec table against the real schema
// ---------------------------------------------------------------------------

/** Non-relation columns of a model, from the generated client's DMMF. */
function columnsOf(model: string): Set<string> {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
  if (!m) throw new Error(`no such model ${model}`);
  return new Set(m.fields.filter((f) => f.kind !== 'object').map((f) => f.name));
}

function relationsOf(model: string): Set<string> {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model)!;
  return new Set(m.fields.filter((f) => f.kind === 'object' && f.isList).map((f) => f.name));
}

describe('MODEL_SPECS is total over the schema', () => {
  it('places every Prisma model exactly once, audited or explicitly not', () => {
    const all = Object.keys(Prisma.ModelName).sort();
    const placed = [...AUDITED_MODEL_NAMES, ...Object.keys(UNAUDITED_MODELS)].sort();
    expect(placed).toEqual(all);
    expect(AUDITED_MODEL_NAMES).toHaveLength(21);
    for (const reason of Object.values(UNAUDITED_MODELS)) expect(reason.length).toBeGreaterThan(20);
  });

  it('every row spec accounts for every column: fields, lists, structured, ids, reads or ignore', () => {
    for (const name of AUDITED_MODEL_NAMES) {
      const spec = MODEL_SPECS[name];
      if (spec.kind !== 'row') continue;
      const columns = columnsOf(name);
      const accounted = new Set([
        ...spec.fields,
        ...Object.keys(spec.lists),
        ...Object.keys(spec.structured),
        ...spec.idFields,
        ...spec.reads,
        ...spec.ignore,
      ]);
      // Nothing named that does not exist (a renamed column would otherwise
      // silently drop out of the diff).
      for (const c of accounted) expect(columns.has(c), `${name}.${c} is not a column`).toBe(true);
      // Nothing that exists is left undecided.
      for (const c of columns)
        expect(accounted.has(c), `${name}.${c} is unaccounted for`).toBe(true);
      // The select list is exactly what the diff and the resolvers need.
      for (const c of spec.select) expect(columns.has(c)).toBe(true);
      expect(AUDIT_ENTITY_TYPES).toContain(spec.entityType);
    }
  });

  it('link and owner-tag specs name real key columns and real relations', () => {
    for (const name of AUDITED_MODEL_NAMES) {
      const spec = MODEL_SPECS[name];
      const columns = columnsOf(name);
      if (spec.kind === 'link') {
        expect(columns.has(spec.ownerKey)).toBe(true);
        expect(columns.has(spec.targetKey)).toBe(true);
        for (const f of spec.row?.fields ?? []) expect(columns.has(f)).toBe(true);
      } else if (spec.kind === 'ownerTags') {
        expect(columns.has(spec.ownerKey)).toBe(true);
        expect(AUDIT_ENTITY_TYPES).toContain(spec.entityType);
      }
    }
    const cascade = row('Engagement').cascadeCounts!;
    const relations = relationsOf('Engagement');
    for (const relation of Object.keys(cascade)) expect(relations.has(relation)).toBe(true);
  });

  it('every redacted column is in the redaction table and in its own allowlist', () => {
    const seen: string[] = [];
    for (const name of AUDITED_MODEL_NAMES) {
      const spec = MODEL_SPECS[name];
      if (spec.kind !== 'row') continue;
      for (const col of spec.redacted) {
        expect(REDACTED_FIELDS.has(col), `${name}.${col}`).toBe(true);
        expect(spec.fields).toContain(col);
        seen.push(col);
      }
    }
    expect(seen.sort()).toEqual(['logoDataUri', 'proposalImport']);
    // The credential columns are redacted by name AND their models are excluded
    // wholesale: no audited model has one in its allowlist.
    for (const name of AUDITED_MODEL_NAMES) {
      const spec = MODEL_SPECS[name];
      if (spec.kind !== 'row') continue;
      for (const col of ['passwordHash', 'totpSecret', 'secretKey', 'codeHash', 'publicKey']) {
        expect(spec.fields).not.toContain(col);
      }
    }
  });

  it('names delegates the way the audit context keys them', () => {
    expect(delegateOf('Tag')).toBe('tag');
    expect(delegateOf('EvidenceTag')).toBe('evidenceTag');
    expect(delegateOf('UserEngagementRole')).toBe('userEngagementRole');
    expect(ALL_AUDITED_MODELS).toHaveLength(21);
    expect(ALL_AUDITED_MODELS).toContain('evidenceFinding');
    expect(ALL_AUDITED_MODELS).not.toContain('auditEntry');
  });
});
