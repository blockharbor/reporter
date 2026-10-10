import { describe, expect, it } from 'vitest';
import { diffRefList, diffValues, formatValue, isOpaque } from './json-diff.js';

describe('diffValues', () => {
  it('reports a scalar change as before and after', () => {
    expect(diffValues('Acme', 'Acme Corp')).toEqual({
      kind: 'scalar',
      from: 'Acme',
      to: 'Acme Corp',
    });
  });

  it('reports unset in either direction as a scalar', () => {
    expect(diffValues(null, 'x')).toEqual({ kind: 'scalar', from: null, to: 'x' });
    expect(diffValues('x', null)).toEqual({ kind: 'scalar', from: 'x', to: null });
  });

  it('reports two arrays as what was added and removed, as a multiset', () => {
    const d = diffValues(['a', 'b', 'b'], ['b', 'c']);
    expect(d).toEqual({ kind: 'array', added: ['c'], removed: ['a', 'b'] });
  });

  it('reports an unchanged array as nothing added or removed', () => {
    expect(diffValues([1, 2], [1, 2])).toEqual({ kind: 'array', added: [], removed: [] });
  });

  it('reports two objects by key, one level deep, dropping equal keys', () => {
    const d = diffValues({ a: 1, b: 'same', c: [1, 2] }, { b: 'same', c: [1, 3], d: true });
    expect(d).toEqual({
      kind: 'object',
      added: [{ key: 'd', from: undefined, to: true }],
      removed: [{ key: 'a', from: 1, to: undefined }],
      edited: [{ key: 'c', from: [1, 2], to: [1, 3] }],
    });
  });

  it('falls back to a scalar for mismatched shapes and for opaque stand-ins', () => {
    expect(diffValues('text', ['list']).kind).toBe('scalar');
    expect(diffValues({ a: 1 }, 'x').kind).toBe('scalar');
    const secret = { $opaque: 'secret' as const };
    expect(diffValues(secret, secret)).toEqual({ kind: 'scalar', from: secret, to: secret });
    expect(diffValues({ a: 1 }, { $opaque: 'oversize', chars: 30_000 }).kind).toBe('scalar');
  });
});

describe('diffRefList', () => {
  it('derives added, removed and edited by comparing label and hash', () => {
    const d = diffRefList(
      [
        { label: 'Kept', hash: 'h1' },
        { label: 'Edited', hash: 'h2' },
        { label: 'Gone', hash: 'h3' },
      ],
      [
        { label: 'Kept', hash: 'h1' },
        { label: 'Edited', hash: 'h2b' },
        { label: 'New', hash: 'h4' },
      ],
    );
    expect(d).toEqual({
      added: [{ label: 'New', hash: 'h4' }],
      removed: [{ label: 'Gone', hash: 'h3' }],
      edited: [{ label: 'Edited', hash: 'h2b' }],
    });
  });

  it('matches duplicate labels pairwise rather than rewriting the whole list', () => {
    const d = diffRefList(
      [
        { label: 'Diagram', hash: 'a' },
        { label: 'Diagram', hash: 'b' },
      ],
      [
        { label: 'Diagram', hash: 'a' },
        { label: 'Diagram', hash: 'c' },
        { label: 'Diagram', hash: 'd' },
      ],
    );
    // `a` is unchanged, `b` → one of the new hashes is an edit, the other is new.
    expect(d.edited).toHaveLength(1);
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(0);
  });

  it('reports nothing for identical lists', () => {
    const refs = [{ label: 'x', hash: '1' }];
    expect(diffRefList(refs, refs)).toEqual({ added: [], removed: [], edited: [] });
  });
});

describe('formatValue', () => {
  it('renders nothing as the em dash', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue('')).toBe('—');
  });

  it('renders booleans as words and numbers and strings as themselves', () => {
    expect(formatValue(true)).toBe('Yes');
    expect(formatValue(false)).toBe('No');
    expect(formatValue(7)).toBe('7');
    expect(formatValue('hello')).toBe('hello');
  });

  it('renders the opaque stand-ins as one phrase each', () => {
    expect(isOpaque({ $opaque: 'secret' })).toBe(true);
    expect(isOpaque({ opaque: 'secret' })).toBe(false);
    expect(formatValue({ $opaque: 'secret' })).toBe('Hidden (credential)');
    expect(formatValue({ $opaque: 'blob', chars: 2048 })).toBe('Binary content (2.0 KB)');
    expect(formatValue({ $opaque: 'oversize', chars: 25000 })).toMatch(
      /^Too long to record \(25\D?000 characters\)$/,
    );
  });

  it('renders structured values as pretty JSON', () => {
    expect(formatValue({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatValue(['a'])).toBe('[\n  "a"\n]');
  });
});
