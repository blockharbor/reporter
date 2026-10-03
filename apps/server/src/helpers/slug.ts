/**
 * Turn an arbitrary name into a URL-safe slug (lowercase, hyphen-separated).
 * Mirrors `slugify` in `apps/web/src/lib/slugify.ts` — keep the two in sync.
 *
 * The trailing-hyphen strip must run *after* the 64-character cap, not as part of
 * one leading-and-trailing pass before it: truncating a longer name can land a
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
    .slice(0, 64)
    .replace(/-+$/, '');
}

/**
 * Ensure a slug is unique by appending `-2`, `-3`, … using the provided
 * existence check. Falls back to a random suffix if the base is empty.
 */
export async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  const candidate = slugify(base) || `item-${Math.abs(hashString(base)) % 100000}`;
  if (!(await exists(candidate))) return candidate;
  for (let i = 2; i < 1000; i++) {
    const next = `${candidate}-${i}`;
    if (!(await exists(next))) return next;
  }
  return `${candidate}-${Date.now()}`;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
