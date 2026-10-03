import { describe, expect, it } from 'vitest';
import { slugSchema } from '@reporter/shared';
import { slugify, slugifyDraft } from './slugify.js';

/** Replay a controlled input: each character is appended to the previous value. */
function type(text: string): string {
  let value = '';
  for (const char of text) value = slugifyDraft(value + char);
  return value;
}

describe('slugifyDraft', () => {
  it('keeps a hyphen the user just typed so the next keystroke can use it', () => {
    expect(slugifyDraft('red-')).toBe('red-');
  });

  it('lets a hyphen be typed mid-word (the original bug: "red-team" became "redteam")', () => {
    expect(type('red-team')).toBe('red-team');
  });

  it('collapses runs of invalid characters to a single hyphen', () => {
    expect(slugifyDraft('red--')).toBe('red-');
    expect(slugifyDraft('Red Team')).toBe('red-team');
    expect(slugifyDraft('acme / q3 ops')).toBe('acme-q3-ops');
  });

  it('drops leading hyphens, which can never become valid', () => {
    expect(slugifyDraft('-red')).toBe('red');
    expect(type('-red')).toBe('red');
  });

  it('caps at 64 characters', () => {
    expect(slugifyDraft('a'.repeat(70))).toBe('a'.repeat(64));
  });

  it('is idempotent, so re-running it on a controlled value is a no-op', () => {
    for (const s of ['red-', 'red-team', '', 'a'.repeat(64)]) {
      expect(slugifyDraft(slugifyDraft(s))).toBe(slugifyDraft(s));
    }
  });
});

describe('slugify', () => {
  it('strips the trailing hyphen the draft tolerated', () => {
    expect(slugify('red-')).toBe('red');
    expect(slugify('red--')).toBe('red');
  });

  it('matches the draft output once the slug is already valid', () => {
    expect(slugify('red-team')).toBe('red-team');
    expect(slugify('Red Team')).toBe('red-team');
  });

  it('caps before stripping edges, so a truncated slug never ends in a hyphen', () => {
    // 63 chars then a separator: slicing to 64 lands the hyphen last.
    const input = `${'x'.repeat(63)} y`;
    expect(slugify(input)).toBe('x'.repeat(63));
  });

  it('produces a slug the server will accept for every typed prefix', () => {
    const name = 'Red Team — Acme Corp Q3 2026 external perimeter assessment, phase two';
    let value = '';
    for (const char of name) {
      value = slugifyDraft(value + char);
      const finalized = slugify(value);
      // An empty slug is the legitimate "nothing typed yet" state; the Create
      // button stays disabled for it. Anything non-empty must validate.
      if (finalized) expect(slugSchema.safeParse(finalized).success).toBe(true);
    }
    expect(value.length).toBeLessThanOrEqual(64);
  });
});
