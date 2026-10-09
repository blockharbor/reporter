import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The page-width arithmetic, pinned in something that runs.
 *
 * `--container-page` is the only layout constant in the design system, and the
 * number everyone actually quotes is the one it does NOT state: the readable
 * content box, which is the token minus the shell's two `px-4` gutters. That
 * subtraction lives in a comment, and comments do not fail a build — so the
 * relationship is asserted here instead.
 *
 * Read as text rather than imported: `theme.css` is a Tailwind `@theme` block, so
 * there is no runtime module to import and no CSSOM in a node test. The values
 * are what ships, because this is the same file the apps `@import`.
 */
const THEME_CSS = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

/** The shell's horizontal padding, `px-4` on each side (Tailwind's 4 = 1rem). */
const GUTTER_REM = 1;

function themeVar(name: string): string {
  const m = THEME_CSS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m?.[1]) throw new Error(`--${name} is not declared in theme.css`);
  return m[1].trim();
}

function rem(value: string): number {
  const m = value.match(/^([\d.]+)rem$/);
  if (!m?.[1]) throw new Error(`expected a rem length, got "${value}"`);
  return Number(m[1]);
}

describe('page container token', () => {
  it('leaves exactly 1320px of content inside the shell gutters', () => {
    const container = rem(themeVar('container-page'));

    // The element's own cap.
    expect(container * 16).toBe(1352);
    // What a reader actually gets, which is the figure the product talks about.
    expect((container - 2 * GUTTER_REM) * 16).toBe(1320);
  });

  it('fires the `wide:` variant exactly where the container stops growing', () => {
    // Deliberately the same length. A `wide:` rule is for layouts that want to
    // spend the extra width differently, so it has to start at the viewport width
    // where there IS no extra width left to give — not at `xl:` (1280px), where the
    // container is still fluid and the branch would fire on a common laptop.
    expect(themeVar('breakpoint-wide')).toBe(themeVar('container-page'));
  });

  it('declares the token rather than inlining it', () => {
    // `@theme inline` bakes the literal into the utility and never emits the custom
    // property, which would make the token unreadable to hand-written CSS. The
    // page-width block must therefore be a plain `@theme`.
    const inlineStart = THEME_CSS.indexOf('@theme inline');
    const inlineBlock = THEME_CSS.slice(inlineStart, THEME_CSS.indexOf('}', inlineStart));
    expect(inlineBlock).not.toContain('--container-page');
    expect(THEME_CSS).toMatch(/@theme\s*\{[^}]*--container-page/);
  });
});

describe('rendered-markdown reading measure', () => {
  it('caps prose blocks but lets code, tables and images use the full column', () => {
    const measure = THEME_CSS.slice(THEME_CSS.indexOf('.md-body > p'));

    // Paragraphs, lists, quotes and headings are prose: capped.
    for (const sel of ['p', 'ul', 'ol', 'blockquote', 'h1', 'h2', 'h3', 'h4']) {
      expect(measure).toContain(`.md-body > ${sel}`);
    }
    expect(measure).toContain('max-width: 80ch');

    // `pre`, `table` and images are the reason a wider page is worth having, so
    // they must NOT be in the capped selector list.
    expect(measure).not.toContain('.md-body > pre');
    expect(measure).not.toContain('.md-body > table');
    expect(measure).not.toContain('.md-body > img');
  });
});
