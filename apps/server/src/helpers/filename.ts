/** Filename helpers for download routes. */

/**
 * A filename timestamp down to the second (local time), so repeated downloads on
 * the same day get distinct names: `2026-08-20-143052`.
 *
 * Local time rather than UTC on purpose: these strings are read by the operator who
 * triggered the download, in the folder they saved it to, so they should match the
 * clock on the wall rather than the server's zone.
 */
export function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}
