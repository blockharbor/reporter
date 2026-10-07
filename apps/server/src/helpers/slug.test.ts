import { describe, expect, it } from 'vitest';
import { SLUG_MAX_LENGTH, slugSchema } from '@reporter/shared';
import { slugify, uniqueSlug } from './slug.js';

describe('slugify', () => {
  it('produces a slug the schema accepts', () => {
    expect(slugify('Op One: the Head Unit')).toBe('op-one-the-head-unit');
    // Truncation must not leave a trailing separator, which `slugSchema` rejects.
    const long = slugify(`${'a'.repeat(SLUG_MAX_LENGTH - 1)} tail`);
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slugSchema.safeParse(long).success).toBe(true);
  });
});

describe('uniqueSlug', () => {
  const taken =
    (...slugs: string[]) =>
    async (s: string) =>
      slugs.includes(s);

  it('appends the first free numeric suffix', async () => {
    expect(await uniqueSlug('Op One', taken())).toBe('op-one');
    expect(await uniqueSlug('Op One', taken('op-one'))).toBe('op-one-2');
    expect(await uniqueSlug('Op One', taken('op-one', 'op-one-2'))).toBe('op-one-3');
  });

  /**
   * A base already at the cap is reachable: `slugSchema` accepts a 64-character
   * slug, so an engagement can hold one, and a full engagement import restoring it
   * onto the same server has to suffix it. The suffix has to fit *inside* the cap —
   * overflowing produced a slug no route would validate, which the import only
   * discovered while serializing its response, after the rows were committed.
   */
  it('keeps a suffixed slug inside the schema length limit', async () => {
    const atLimit = 'a'.repeat(SLUG_MAX_LENGTH);
    const next = await uniqueSlug(atLimit, taken(atLimit));
    expect(next).not.toBe(atLimit);
    expect(next.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slugSchema.safeParse(next).success).toBe(true);
  });

  it('keeps the fallback timestamp suffix inside the limit too', async () => {
    // Every numeric suffix exhausted: the last resort is a timestamp.
    const atLimit = 'b'.repeat(SLUG_MAX_LENGTH);
    const next = await uniqueSlug(atLimit, async () => true);
    expect(next.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slugSchema.safeParse(next).success).toBe(true);
  });

  it('falls back to a derived slug when the base has nothing slug-worthy', async () => {
    const next = await uniqueSlug('???', taken());
    expect(slugSchema.safeParse(next).success).toBe(true);
    expect(next.startsWith('item-')).toBe(true);
  });
});
