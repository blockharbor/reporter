/**
 * The fixed tag color palette, shared by every surface (web timeline, desktop
 * history, CLI selection lists) so a tag looks identical everywhere.
 *
 * Each entry maps a stable `name` (stored in the DB) to light/dark hex values
 * chosen to keep white/near-black text legible on the chip.
 */
export interface TagColor {
  name: string;
  /** Chip background in light theme. */
  light: string;
  /** Chip background in dark theme. */
  dark: string;
  /** Text color to use on the chip (both themes handle contrast via this). */
  fg: string;
}

export const TAG_COLORS = [
  { name: 'red', light: '#e05252', dark: '#f0716b', fg: '#ffffff' },
  { name: 'orange', light: '#d9822b', dark: '#f0a04b', fg: '#1a1204' },
  { name: 'amber', light: '#c99a00', dark: '#e5bd3a', fg: '#1a1400' },
  { name: 'green', light: '#3ba55d', dark: '#4fc57a', fg: '#04210f' },
  { name: 'teal', light: '#0e8a8a', dark: '#2dd4bf', fg: '#04211f' },
  { name: 'cyan', light: '#2b9bc9', dark: '#4fc0e5', fg: '#03212b' },
  { name: 'blue', light: '#2d7ff9', dark: '#5ea2ff', fg: '#ffffff' },
  { name: 'indigo', light: '#5b5bd6', dark: '#8686f0', fg: '#ffffff' },
  { name: 'violet', light: '#8a4fd6', dark: '#b083f0', fg: '#ffffff' },
  { name: 'pink', light: '#d64f9b', dark: '#f083bd', fg: '#ffffff' },
  { name: 'slate', light: '#5b6472', dark: '#8b95a5', fg: '#ffffff' },
  { name: 'stone', light: '#8a8078', dark: '#b0a79e', fg: '#1a1512' },
] as const satisfies readonly TagColor[];

/** One of the twelve palette names. */
export type TagColorName = (typeof TAG_COLORS)[number]['name'];

/**
 * Every stored `colorName` value. A non-empty readonly tuple rather than
 * `string[]`, so the input schemas in `schemas.ts` can constrain `colorName` with
 * `z.enum` (`tagColorNameSchema`). Before that, any string persisted and silently
 * rendered as `slate` via {@link tagColor}'s fallback.
 */
export const TAG_COLOR_NAMES = TAG_COLORS.map((c) => c.name) as [TagColorName, ...TagColorName[]];

/** Keyed by plain `string` on purpose: {@link tagColor} must accept legacy and
 *  imported rows whose `colorName` is off-palette, and degrade them. */
const TAG_COLOR_BY_NAME = new Map<string, TagColor>(TAG_COLORS.map((c) => [c.name, c]));

/** Look up a color by stored name, falling back to `slate` for unknown values. */
export function tagColor(name: string): TagColor {
  return TAG_COLOR_BY_NAME.get(name) ?? TAG_COLORS[10]!;
}

/**
 * Deterministically pick a palette color for a tag name (used for auto-coloring).
 * Typed as a palette name, not `string`: every inline-create path (desktop tray,
 * `reporter-term`, the web pickers) sends this straight into `createTagInput`,
 * whose `colorName` is palette-constrained.
 */
export function defaultTagColorFor(tagName: string): TagColorName {
  let hash = 0;
  for (let i = 0; i < tagName.length; i++) {
    hash = (hash * 31 + tagName.charCodeAt(i)) >>> 0;
  }
  return TAG_COLORS[hash % TAG_COLORS.length]!.name;
}
