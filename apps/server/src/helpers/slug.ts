import { SLUG_MAX_LENGTH } from '@reporter/shared';

/**
 * Turn an arbitrary name into a URL-safe slug (lowercase, hyphen-separated).
 * Mirrors `slugify` in `apps/web/src/lib/slugify.ts` — keep the two in sync.
 *
 * The trailing-hyphen strip must run *after* the length cap, not as part of one
 * leading-and-trailing pass before it: truncating a longer name can land a
 * separator in the last position, and `slugSchema` rejects a trailing hyphen. That
 * is reachable through `uniqueSlug` below, which slugifies the engagement name
 * whenever the client doesn't supply a slug of its own.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}

/**
 * Ensure a slug is unique by appending `-2`, `-3`, … using the provided
 * existence check. Falls back to a random suffix if the base is empty.
 *
 * Every result satisfies `slugSchema`, suffix included — see {@link withSuffix}.
 */
export async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  const candidate = slugify(base) || `item-${Math.abs(hashString(base)) % 100000}`;
  if (!(await exists(candidate))) return candidate;
  for (let i = 2; i < 1000; i++) {
    const next = withSuffix(candidate, `-${i}`);
    if (!(await exists(next))) return next;
  }
  return withSuffix(candidate, `-${Date.now()}`);
}

/**
 * Append a disambiguating suffix, making room for it inside `SLUG_MAX_LENGTH`
 * rather than overflowing.
 *
 * A base that is already at the cap is reachable: `slugSchema` accepts a
 * 64-character slug, so an engagement can hold one, and a full engagement import
 * restoring that engagement onto the same server has to suffix it. Overflowing
 * instead produced a slug no route would validate — and the import only discovered
 * that while serializing its response, i.e. after the rows were committed.
 */
function withSuffix(base: string, suffix: string): string {
  const room = SLUG_MAX_LENGTH - suffix.length;
  // Re-strip: trimming to make room can leave a separator last, which the regex
  // in `slugSchema` rejects (the same reason `slugify` strips after its cap).
  return `${base.slice(0, room).replace(/-+$/, '')}${suffix}`;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
