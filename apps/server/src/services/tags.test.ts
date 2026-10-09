import { describe, expect, it } from 'vitest';
import type { ExecutionSubsection } from '@reporter/shared';
import { withTagRenamedInTimelines } from './tags.js';

// `withTagRenamedInTimelines` is the one piece of the rename/merge path with real
// branching, and it is pure precisely so these cases can be pinned without a
// database. The identity assertions (`toBe`) matter as much as the value ones:
// `rewriteTimelineTagNames` writes the column back only when `changed > 0`, so a
// subsection that comes back as a fresh copy when nothing moved would turn every
// rename into a whole-column rewrite that normalizes untouched JSON.

function timeline(title: string, tags: string[]): ExecutionSubsection {
  return {
    kind: 'timeline',
    title,
    body: '',
    evidence: [],
    timeline: { tags, types: ['image'], group: 'tag', includeComments: true, starredOnly: false },
  };
}

function narrative(title: string): ExecutionSubsection {
  return { kind: 'narrative', title, body: 'Some prose about alpha.', evidence: [] };
}

describe('withTagRenamedInTimelines', () => {
  it('renames the term in place, keeping the rest of the config intact', () => {
    const before = timeline('Recon', ['alpha', 'gamma']);
    const { next, changed } = withTagRenamedInTimelines([before], 'alpha', 'omega');

    expect(changed).toBe(1);
    expect(next[0]!.timeline!.tags).toEqual(['omega', 'gamma']);
    // Only `tags` moved; the sibling timeline options survive the spread.
    expect(next[0]!.timeline).toMatchObject({
      types: ['image'],
      group: 'tag',
      includeComments: true,
      starredOnly: false,
    });
    expect(next[0]!.title).toBe('Recon');
    // The input is not mutated — the caller may still hold the original row.
    expect(before.timeline!.tags).toEqual(['alpha', 'gamma']);
  });

  it('dedups when the array already names the target, whichever order they appear in', () => {
    const { next, changed } = withTagRenamedInTimelines(
      [
        timeline('A', ['alpha', 'beta']),
        timeline('B', ['beta', 'alpha']),
        timeline('C', ['alpha', 'alpha']),
      ],
      'alpha',
      'beta',
    );

    expect(changed).toBe(3);
    expect(next[0]!.timeline!.tags).toEqual(['beta']);
    expect(next[1]!.timeline!.tags).toEqual(['beta']);
    expect(next[2]!.timeline!.tags).toEqual(['beta']);
  });

  it('drops the term when `to` is null', () => {
    const { next, changed } = withTagRenamedInTimelines(
      [timeline('A', ['alpha', 'gamma']), timeline('B', ['alpha'])],
      'alpha',
      null,
    );

    expect(changed).toBe(2);
    expect(next[0]!.timeline!.tags).toEqual(['gamma']);
    // A section filtered down to no tags keeps an empty array (= "any tag"),
    // rather than losing its `timeline` config.
    expect(next[1]!.timeline!.tags).toEqual([]);
  });

  it('returns a narrative subsection by identity', () => {
    const prose = narrative('alpha');
    const { next, changed } = withTagRenamedInTimelines([prose], 'alpha', 'omega');

    expect(changed).toBe(0);
    expect(next[0]).toBe(prose);
  });

  it('returns a timeline subsection that does not name the tag by identity', () => {
    const other = timeline('Other', ['gamma', 'delta']);
    const { next, changed } = withTagRenamedInTimelines([other], 'alpha', 'omega');

    expect(changed).toBe(0);
    expect(next[0]).toBe(other);
  });

  it('counts only the subsections that moved and leaves the others untouched', () => {
    const prose = narrative('Intro');
    const other = timeline('Other', ['gamma']);
    const hit = timeline('Hit', ['alpha']);
    const { next, changed } = withTagRenamedInTimelines(
      [prose, other, hit, timeline('Hit 2', ['gamma', 'alpha'])],
      'alpha',
      'omega',
    );

    expect(changed).toBe(2);
    expect(next).toHaveLength(4);
    expect(next[0]).toBe(prose);
    expect(next[1]).toBe(other);
    expect(next[2]).not.toBe(hit);
    expect(next[2]!.timeline!.tags).toEqual(['omega']);
    expect(next[3]!.timeline!.tags).toEqual(['gamma', 'omega']);
  });

  it('matches whole names only — a tag whose name contains the term is not renamed', () => {
    const { next, changed } = withTagRenamedInTimelines(
      [timeline('A', ['alphabet', 'Alpha'])],
      'alpha',
      'omega',
    );

    expect(changed).toBe(0);
    expect(next[0]!.timeline!.tags).toEqual(['alphabet', 'Alpha']);
  });

  it('tolerates a timeline subsection whose config is missing or mis-shaped', () => {
    // The column is read with a cast, not a zod parse, so rows a hand edit or an
    // older build left in an odd shape must not take the whole rename down.
    const noConfig = {
      kind: 'timeline',
      title: 'No config',
      body: '',
      evidence: [],
    } as unknown as ExecutionSubsection;
    const stringTags = {
      kind: 'timeline',
      title: 'String tags',
      body: '',
      evidence: [],
      timeline: { tags: 'alpha' },
    } as unknown as ExecutionSubsection;
    const nullTags = {
      kind: 'timeline',
      title: 'Null tags',
      body: '',
      evidence: [],
      timeline: { tags: null },
    } as unknown as ExecutionSubsection;

    const { next, changed } = withTagRenamedInTimelines(
      [noConfig, stringTags, nullTags],
      'alpha',
      'omega',
    );

    expect(changed).toBe(0);
    expect(next[0]).toBe(noConfig);
    expect(next[1]).toBe(stringTags);
    expect(next[2]).toBe(nullTags);
  });
});
