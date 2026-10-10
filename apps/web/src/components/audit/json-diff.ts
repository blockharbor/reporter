/**
 * Pure diffing over the values an audit change carries, consumed by
 * AuditChangeList. Two differs, because the wire has two shapes:
 *
 *  - `diffValues(from, to)` for a `kind: 'field'` change, whose sides are any
 *    JSON. Scalars (and anything of mismatched shape) render as before → after;
 *    two arrays as what was added and removed (a multiset, so a duplicate that
 *    went from two copies to one shows one removal); two plain objects as the
 *    keys added, removed and edited, one level deep — a report config is a
 *    flat bag of leaves keyed by dotted path on the server side already.
 *  - `diffRefList(from, to)` for a `kind: 'list'` change, whose sides are
 *    `{label, hash}` refs — the log never stores list item bodies (a threat
 *    model diagram is base64), so "what changed" is answered by comparing refs:
 *    same label + same hash is unchanged, same label + new hash is edited, a
 *    label only on one side was added or removed.
 *
 * Equality everywhere is `JSON.stringify(a) === JSON.stringify(b)`, the
 * repo's deepEqual (useAutosave.ts), which is exact for the JSON the wire
 * carries. The server's opaque stand-ins (`{ $opaque: 'secret' | 'blob' |
 * 'oversize' }`) are never diffed into; they render as one phrase each.
 */
import type { AuditListItemRef, AuditOpaqueValue } from '@reporter/shared';
import { formatBytes } from '../../lib/format.js';

export interface KeyChange {
  key: string;
  from: unknown;
  to: unknown;
}

export type ValueDiff =
  | { kind: 'scalar'; from: unknown; to: unknown }
  | { kind: 'array'; added: unknown[]; removed: unknown[] }
  | { kind: 'object'; added: KeyChange[]; removed: KeyChange[]; edited: KeyChange[] };

export interface RefListDiff {
  added: AuditListItemRef[];
  removed: AuditListItemRef[];
  /** Same label, different hash: the item was edited in place. */
  edited: AuditListItemRef[];
}

export const jsonEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A server-side stand-in for a value the log refused to store verbatim. */
export function isOpaque(v: unknown): v is AuditOpaqueValue {
  return (
    isPlainObject(v) && (v.$opaque === 'secret' || v.$opaque === 'blob' || v.$opaque === 'oversize')
  );
}

/** Rendered text for an opaque stand-in, with its size when the server kept one. */
export function formatOpaque(v: AuditOpaqueValue): string {
  switch (v.$opaque) {
    case 'secret':
      return 'Hidden (credential)';
    case 'blob':
      return v.chars === undefined ? 'Binary content' : `Binary content (${formatBytes(v.chars)})`;
    case 'oversize':
      return v.chars === undefined
        ? 'Too long to record'
        : `Too long to record (${v.chars.toLocaleString()} characters)`;
  }
}

/**
 * Human text for one side of a change. Nothing (`null`, `undefined`, the empty
 * string) is the em dash, so "unset → value" reads at a glance; booleans are
 * words; objects and arrays are pretty JSON, which the change list folds
 * behind "Show full" past a few lines.
 */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (isOpaque(v)) return formatOpaque(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v, null, 2);
}

/** Multiset difference of two arrays by JSON identity, keeping the original values. */
function arrayDiff(from: unknown[], to: unknown[]): { added: unknown[]; removed: unknown[] } {
  const count = (items: unknown[]) => {
    const m = new Map<string, { value: unknown; n: number }>();
    for (const item of items) {
      const key = JSON.stringify(item);
      const entry = m.get(key);
      if (entry) entry.n += 1;
      else m.set(key, { value: item, n: 1 });
    }
    return m;
  };
  const before = count(from);
  const after = count(to);
  const added: unknown[] = [];
  const removed: unknown[] = [];
  for (const [key, { value, n }] of after) {
    const extra = n - (before.get(key)?.n ?? 0);
    for (let i = 0; i < extra; i += 1) added.push(value);
  }
  for (const [key, { value, n }] of before) {
    const missing = n - (after.get(key)?.n ?? 0);
    for (let i = 0; i < missing; i += 1) removed.push(value);
  }
  return { added, removed };
}

export function diffValues(from: unknown, to: unknown): ValueDiff {
  if (Array.isArray(from) && Array.isArray(to)) {
    return { kind: 'array', ...arrayDiff(from, to) };
  }
  if (isPlainObject(from) && isPlainObject(to) && !isOpaque(from) && !isOpaque(to)) {
    const added: KeyChange[] = [];
    const removed: KeyChange[] = [];
    const edited: KeyChange[] = [];
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      const inFrom = Object.prototype.hasOwnProperty.call(from, key);
      const inTo = Object.prototype.hasOwnProperty.call(to, key);
      if (inFrom && !inTo) removed.push({ key, from: from[key], to: undefined });
      else if (!inFrom && inTo) added.push({ key, from: undefined, to: to[key] });
      else if (!jsonEqual(from[key], to[key])) edited.push({ key, from: from[key], to: to[key] });
    }
    return { kind: 'object', added, removed, edited };
  }
  return { kind: 'scalar', from, to };
}

/**
 * Added / removed / edited over two ref lists, by label. Duplicate labels are
 * matched pairwise: a hash on both sides is unchanged, a leftover on each side
 * is one edit, and the remainder is added or removed — so a list that gained
 * a second "Diagram" shows one addition, not a whole-list rewrite.
 */
export function diffRefList(from: AuditListItemRef[], to: AuditListItemRef[]): RefListDiff {
  const byLabel = (refs: AuditListItemRef[]) => {
    const m = new Map<string, string[]>();
    for (const r of refs) m.set(r.label, [...(m.get(r.label) ?? []), r.hash]);
    return m;
  };
  const before = byLabel(from);
  const after = byLabel(to);
  const added: AuditListItemRef[] = [];
  const removed: AuditListItemRef[] = [];
  const edited: AuditListItemRef[] = [];

  for (const label of new Set([...before.keys(), ...after.keys()])) {
    const oldHashes = [...(before.get(label) ?? [])];
    const newHashes = [...(after.get(label) ?? [])];
    // Drop the pairs that match exactly.
    for (let i = oldHashes.length - 1; i >= 0; i -= 1) {
      const j = newHashes.indexOf(oldHashes[i]!);
      if (j !== -1) {
        oldHashes.splice(i, 1);
        newHashes.splice(j, 1);
      }
    }
    const pairs = Math.min(oldHashes.length, newHashes.length);
    for (let i = 0; i < pairs; i += 1) edited.push({ label, hash: newHashes[i]! });
    for (const hash of newHashes.slice(pairs)) added.push({ label, hash });
    for (const hash of oldHashes.slice(pairs)) removed.push({ label, hash });
  }
  return { added, removed, edited };
}
