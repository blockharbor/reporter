/**
 * Engagement slug helpers.
 *
 * There are two of them because a slug being typed and a slug being submitted
 * obey different rules. `slugSchema` in `@reporter/shared` is
 * `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, so a trailing hyphen is invalid — but "red-"
 * is an unavoidable waypoint on the way to "red-team". Running the finalizing
 * slugifier on every keystroke deletes the hyphen the instant it is typed and
 * the controlled input snaps back, so the user can never get a hyphen into the
 * field at all (pasting works, typing doesn't). Use `slugifyDraft` in `onChange`
 * and `slugify` on blur and again before submit.
 */

/**
 * Lenient slugifier for a field the user is still typing into. Lowercases,
 * NFKD-normalizes, collapses every run of non-slug characters to a single
 * hyphen, drops leading hyphens and caps the result at 64 characters.
 *
 * Leading and trailing hyphens are treated differently on purpose: a leading
 * hyphen can never become valid by typing more, so removing it costs the user
 * nothing, while a trailing one is a single keystroke away from being legal and
 * so is kept. Runs are still collapsed, which means "red--" renders as "red-" —
 * the field stays exactly one `slugify` call away from valid at every point in
 * the edit, and the user can keep typing either way.
 */
export function slugifyDraft(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64);
}

/**
 * Strict slugifier: `slugifyDraft` plus the trailing-hyphen strip, so the result
 * always satisfies `slugSchema`. Mirrors the server helper
 * `apps/server/src/helpers/slug.ts` — keep the two in sync.
 *
 * The trailing strip must run *after* the 64-character cap, not before:
 * truncating a longer input can land a hyphen in the last position, which
 * `slugSchema` rejects.
 */
export function slugify(input: string): string {
  return slugifyDraft(input).replace(/-+$/, '');
}
