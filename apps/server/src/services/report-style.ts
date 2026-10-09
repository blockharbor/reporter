/**
 * Block Harbor house-style CSS and small HTML helpers for the findings-report
 * PDF. Ported from the reference proposal stylesheet (`proposalDoc.css`) and
 * adapted for a findings report: cover, numbered section headers, red-header
 * tables, TOC, callouts, pills, severity dashboard, evidence blocks.
 *
 * The stylesheet is a template string so the accent color from the report
 * settings can be injected into `--bh-red` / `--accent`. Everything is embedded
 * inline in the report HTML so the document is fully self-contained.
 */
import { renderMarkdown } from '@reporter/shared';

/** HTML-escape user text for safe interpolation into the document. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render author prose (finding description, remediation, scope, summary,
 * methodology, narratives, custom sections) as Markdown → HTML. Uses the shared
 * renderer so the exported PDF matches the in-app editor's Preview exactly:
 * blank lines start new paragraphs, single newlines become `<br>`, and the usual
 * markdown (headings, lists, **bold**, links, code, tables) is supported. The
 * output is wrapped in `.md` for the report's markdown styling; empty input
 * yields an empty string so callers can omit the block.
 */
export function prose(text: string | null | undefined): string {
  const html = renderMarkdown(text);
  return html ? `<div class="md">${html}</div>` : '';
}

/** Map the three transparency levels to CSS opacities. */
export const WATERMARK_OPACITY_VALUES = { light: 0.06, medium: 0.11, strong: 0.18 } as const;

/**
 * The diagonal watermark font size (px) that keeps the rotated word inside the
 * printable Letter page. The single word is centered and rotated -45°, so its
 * axis-aligned bounding box grows with both its length and its glyph height; we
 * solve for a font size whose box stays within the ~7.3in printable width, using
 * a conservative per-glyph advance (~0.82em, covering the condensed font's wider
 * Arial fallback plus letter-spacing). Short text is capped so it stays a
 * tasteful size; long text shrinks (never clips). The lower bound is chosen so
 * that even the longest allowed text (`WATERMARK_MAX_CHARS`) still fits.
 */
export function watermarkFontSize(text: string): number {
  const n = Math.max(text.trim().length, 1);
  // 920 ≈ (printable width / cos45°) with a safety margin; 0.82·n + 1 is the box
  // width (advance·n) plus the glyph-height term, both in font-size units.
  const fit = 920 / (0.82 * n + 1);
  return Math.round(Math.min(120, Math.max(34, fit)));
}

/**
 * CSS for the per-page watermark. A single diagonal `position: fixed` word
 * repeats on every printed page in Chromium; the cover's opaque, higher-z-index
 * background hides it on the title page. `layer: 'behind'` (z-index -1) sits
 * under the content; `'front'` (z-index 900) sits above it (still below the
 * cover at 1000). Caller passes a resolved color + opacity + a page-fitting font
 * size (see `watermarkFontSize`).
 */
export function watermarkCss(
  color: string,
  opacity: number,
  layer: 'behind' | 'front',
  fontSize: number,
): string {
  const z = layer === 'front' ? 900 : -1;
  return `.watermark { position: fixed; top: 50%; left: 50%;
  transform: translate(-50%, -50%) rotate(-45deg); font-family: var(--font-cond);
  font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; white-space: nowrap;
  font-size: ${fontSize}px; line-height: 1; color: ${color}; opacity: ${opacity}; pointer-events: none;
  z-index: ${z}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;
}

/** The watermark element (empty string disables it). */
export function watermarkMarkup(text: string): string {
  return `<div class="watermark" aria-hidden="true">${esc(text)}</div>`;
}

/** The Google Fonts `<link>`s. Rendering never blocks on these — see build. */
export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700;900&family=Roboto+Condensed:wght@400;500;700&family=Roboto+Mono:wght@400;500;700&display=swap" rel="stylesheet">`;

/** CSS-string-escape a value for safe use inside a `content: "..."` declaration. */
function cssString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/**
 * The full self-contained stylesheet. `accent` drives the BH red accent
 * (section numbers, rules, table headers, list markers, pills). `hdrLeft` /
 * `hdrRight` are baked into the running-header margin boxes (both already
 * escaped/uppercased by the caller as plain text).
 */
export function reportCss(accent: string, hdrLeft: string, hdrRight: string): string {
  const left = cssString(hdrLeft);
  const right = cssString(hdrRight);
  return `
:root {
  --bh-red: ${accent};
  --accent: ${accent};
  --bh-gray: #686563;
  --bh-light-gray: #e5e7e6;
  --bh-black: #000000;
  --bh-white: #ffffff;
  --bh-near-black: #0d0d0d;
  --bh-panel: #1a1a1a;
  --bh-stroke-dark: #2a2a2a;
  --bh-stroke-light: #d6d8d7;
  --bh-muted: #9a9897;
  --fg-1: var(--bh-black);
  --fg-2: var(--bh-gray);
  --fg-3: var(--bh-muted);
  --fg-inverse: var(--bh-white);
  --fg-inverse-2: #cfcecd;
  --bg-1: var(--bh-white);
  --bg-2: var(--bh-light-gray);
  --bg-inverse: var(--bh-near-black);
  --stroke: var(--bh-stroke-light);
  --stroke-light: var(--bh-stroke-light);
  --stroke-dark: var(--bh-stroke-dark);
  --font-sans: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
  --font-cond: 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif;
  --font-mono: 'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  /* Severity palette (CVSS v3.1 bands). */
  --sev-critical: #b3111e;
  --sev-high: #d9822b;
  --sev-medium: #c99a00;
  --sev-low: #3ba55d;
  --sev-none: #5b6472;
}

* { box-sizing: border-box; }
html { font-family: var(--font-sans); color: var(--fg-1); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #fff; -webkit-font-smoothing: antialiased; font-family: var(--font-sans); color: var(--fg-1); }
h1, h2, h3, h4, p { margin: 0; }
h1, h2, h3 { text-wrap: balance; }
p, li { text-wrap: pretty; }

.pad { padding: 0.62in 0.75in; }
.section { break-before: page; }
.pp { color: var(--fg-1); font-size: 14.5px; line-height: 1.62; white-space: pre-wrap; margin: 0 0 12px; }
.pp:last-child { margin-bottom: 0; }
.muted { color: var(--fg-3); }
.mono { font-family: var(--font-mono); }

/* Rendered markdown prose (see report-style prose()). Mirrors the in-app editor
   preview (.md-body in the design system) with print colors. */
.md { color: var(--fg-1); font-size: 14.5px; line-height: 1.62; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 12px; }
.md h1, .md h2, .md h3, .md h4 { color: var(--bh-black); font-weight: 700; line-height: 1.25;
  margin: 18px 0 8px; break-after: avoid; }
.md h1 { font-size: 20px; }
.md h2 { font-size: 17px; }
.md h3 { font-size: 15px; }
.md h4 { font-size: 14px; }
.md ul, .md ol { margin: 0 0 12px; padding-left: 22px; }
.md li { margin: 2px 0; }
.md li > ul, .md li > ol { margin: 2px 0; }
.md a { color: var(--bh-red); text-decoration: underline; }
.md strong { font-weight: 700; }
.md em { font-style: italic; }
.md code { font-family: var(--font-mono); font-size: 12.5px; background: #f6f6f6;
  border: 1px solid var(--stroke-light); border-radius: 4px; padding: 0.5px 4px; }
.md pre { background: #f6f6f6; border: 1px solid var(--stroke-light); border-radius: 6px;
  padding: 12px; overflow-x: auto; margin: 0 0 12px; white-space: pre-wrap; word-break: break-word; }
.md pre code { background: none; border: 0; padding: 0; font-size: 12px; line-height: 1.5; }
.md blockquote { margin: 0 0 12px; padding: 2px 0 2px 14px; border-left: 3px solid var(--bh-red);
  color: var(--fg-2); }
.md hr { border: 0; border-top: 1px solid var(--stroke-light); margin: 16px 0; }
.md table { width: 100%; border-collapse: collapse; margin: 0 0 12px; font-size: 13px; }
.md th, .md td { border: 1px solid var(--stroke-light); padding: 6px 10px; text-align: left;
  vertical-align: top; }
.md th { background: var(--bh-light-gray); font-weight: 700; color: var(--bh-black); }

/* Markdown rendered *inside* another text block — a summary-table cell, a
   timeline description, a figure or step caption, a scope paragraph. The rules
   above are the document's body prose (14.5px, --fg-1); these hosts set their own
   size and colour (13.5px table text, 13px muted timeline copy, 12.5px captions),
   so the nested markdown inherits the host's instead of jumping back up to body
   size. Margins already come from the :first-child / :last-child resets above,
   and a code span is sized relative to its host rather than pinned at 12.5px.

   white-space: normal undoes a host's pre-wrap: the renderer sets breaks: true,
   so it emits a <br> for a single newline itself and pre-wrap would print every
   line break twice. .tl-desc and .step-caption dropped their pre-wrap outright
   (every one of their users renders markdown now); .pp keeps it, because most of
   its users are still verbatim text. */
.pp > .md, table.tbl td > .md, .tl-desc > .md, figcaption > .md, .ev-note > .md,
.step-caption > .md {
  font-size: inherit; line-height: inherit; color: inherit; white-space: normal; }
.pp > .md code, table.tbl td > .md code, .tl-desc > .md code, figcaption > .md code,
.ev-note > .md code, .step-caption > .md code { font-size: 0.92em; }
/* A caption is one short line in practice, and the language chip sits after it on
   that line, so a single-paragraph caption flows inline and the chip stays put. A
   caption that really is multi-block (a list, a fenced block) still breaks — only
   p is made inline, so ul / ol / pre keep their own display. A *second* paragraph
   goes back to being a block: inlining it too would run two paragraphs together
   into one line and lose the break the author typed. */
figcaption > .md, figcaption > .md > p { display: inline; }
figcaption > .md > p + p { display: block; }

/* ---- cover ---- */
/* The cover is the first page, which has zero @page margin (see @page :first),
   so it fills the full 8.5x11in sheet. Its own padding provides the inset; the
   height stays just under 11in so it never spills to a second page. */
.cover { background: var(--bh-near-black); color: var(--fg-inverse);
         padding: 0.7in 0.75in; position: relative; height: 10.7in; box-sizing: border-box;
         break-after: page; overflow: hidden; z-index: 1000; }
.cover-logo { max-height: 40px; max-width: 240px; width: auto; display: block; margin: 0 0 8px; }
.cover-wordmark { font-weight: 900; font-size: 26px; letter-spacing: -0.01em; color: #fff; }
.cover-wordmark .dot { color: var(--bh-red); }
.cover-top { }
.cover-mid { margin-top: 1.2in; }
.cover-rule { width: 56px; height: 4px; background: var(--bh-red); margin: 0 0 22px; border: 0; }
.cover-eyebrow { font-family: var(--font-cond); font-weight: 700; font-size: 13px;
                 letter-spacing: 0.26em; text-transform: uppercase; color: var(--bh-red); }
.cover-title { font-weight: 900; font-size: 54px; line-height: 1.0; letter-spacing: -0.02em;
               margin: 18px 0 0; color: #fff; max-width: 15ch; }
.cover-sub { color: var(--fg-inverse-2); font-size: 16px; line-height: 1.6; max-width: 34em; margin: 22px 0 0; }
.cover-meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px;
              background: var(--bh-stroke-dark); border: 1px solid var(--bh-stroke-dark); margin-top: 44px; }
.cover-cell { background: var(--bh-near-black); padding: 16px 18px; }
.cover-cell .k { font-family: var(--font-cond); font-weight: 700; font-size: 11px; letter-spacing: 0.14em;
                 text-transform: uppercase; color: var(--fg-3); margin-bottom: 7px; }
.cover-cell .v { color: #fff; font-size: 15px; font-weight: 500; }
.cover-cell-wide { grid-column: 1 / -1; }
.cover-foot { position: absolute; left: 0.75in; bottom: 0.5in; font-family: var(--font-mono);
              font-size: 13px; letter-spacing: 0.06em; color: var(--bh-red); margin: 0; }

/* ---- numbered section header ---- */
.sec-head { display: grid; grid-template-columns: auto 1fr; column-gap: 20px; align-items: baseline;
            border-top: 2px solid var(--bh-black); padding-top: 16px; margin-bottom: 26px; break-after: avoid; }
.sec-head .sec-kicker { grid-column: 2; grid-row: 1; }
.sec-head .sec-num { grid-column: 1; grid-row: 2; }
.sec-head .sec-title { grid-column: 2; grid-row: 2; }
.sec-num { font-family: var(--font-mono); font-weight: 700; font-size: 14px; color: var(--bh-red);
           letter-spacing: 0.04em; white-space: nowrap; }
.sec-title { font-weight: 900; font-size: 32px; letter-spacing: -0.02em; line-height: 1.05; color: var(--bh-black); }
.sec-kicker { font-family: var(--font-cond); font-weight: 700; font-size: 12px; letter-spacing: 0.14em;
              text-transform: uppercase; color: var(--fg-3); margin-bottom: 6px; }

h3.block-h { font-weight: 700; font-size: 18px; letter-spacing: -0.01em; color: var(--bh-black);
             margin: 30px 0 10px; break-after: avoid; }
h3.block-h:first-child { margin-top: 0; }
h4.block-h { font-family: var(--font-cond); font-weight: 700; font-size: 12px; letter-spacing: 0.1em;
             text-transform: uppercase; color: var(--fg-3); margin: 22px 0 8px; break-after: avoid; }
.lede { font-size: 16px; line-height: 1.6; color: var(--fg-1); font-weight: 400; margin: 0 0 6px; }

/* ---- pills ---- */
.pill { display: inline-block; padding: 2px 11px; border-radius: 999px; font-size: 12.5px;
        font-weight: 500; line-height: 1.5; color: #fff; vertical-align: middle; }
.pill-red { background: var(--bh-red); }
.pill-ghost { background: var(--bh-light-gray); color: var(--bh-black); }
.pill-sev-critical { background: var(--sev-critical); }
.pill-sev-high { background: var(--sev-high); color: #1a1204; }
.pill-sev-medium { background: var(--sev-medium); color: #1a1400; }
.pill-sev-low { background: var(--sev-low); color: #04210f; }
.pill-sev-none { background: var(--sev-none); }
.chip { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 11px; font-weight: 600;
        line-height: 1.5; color: #fff; }

/* ---- info / detail grid ---- */
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--stroke-light);
         border: 1px solid var(--stroke-light); border-radius: 8px; overflow: hidden; margin-top: 20px; }
.info-cell { background: #fff; padding: 16px 18px; break-inside: avoid; }
.info-cell .k { font-family: var(--font-cond); font-weight: 700; font-size: 11px; letter-spacing: 0.12em;
                text-transform: uppercase; color: var(--fg-3); margin-bottom: 7px; }
.info-cell .v { font-size: 15px; color: var(--bh-black); font-weight: 500; line-height: 1.45; }
.info-cell .v.mono { font-family: var(--font-mono); font-weight: 500; font-size: 14px; }
.info-cell-wide { grid-column: 1 / -1; }
.person { padding: 9px 0; border-top: 1px solid var(--stroke-light); }
.person:first-of-type { border-top: 0; padding-top: 0; }
.person .nm { font-weight: 700; font-size: 14px; color: var(--bh-black); }
.person .rl { font-size: 12.5px; color: var(--fg-2); margin-top: 1px; }

/* ---- key-stats strip ---- */
.stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; background: var(--stroke-light);
         border: 1px solid var(--stroke-light); border-radius: 8px; overflow: hidden; margin-top: 20px; }
.stat { background: #fff; padding: 15px 16px; break-inside: avoid; }
.stat .k { font-family: var(--font-cond); font-weight: 700; font-size: 10px; letter-spacing: 0.1em;
           text-transform: uppercase; color: var(--fg-3); margin-bottom: 7px; }
.stat .v { font-family: var(--font-mono); font-weight: 700; font-size: 22px; color: var(--bh-black); line-height: 1; }
.stat .u { font-size: 11px; color: var(--fg-3); font-weight: 500; }

/* ---- severity distribution ---- */
.sev-bar { display: flex; width: 100%; height: 20px; border-radius: 4px; overflow: hidden; margin-top: 20px;
           background: var(--bh-light-gray); }
.sev-bar > span { display: block; height: 100%; }
.sev-cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 14px; }
.sev-card { border: 1px solid var(--stroke-light); border-radius: 8px; padding: 12px 14px; break-inside: avoid;
            border-top: 3px solid var(--sev-none); }
.sev-card.critical { border-top-color: var(--sev-critical); }
.sev-card.high { border-top-color: var(--sev-high); }
.sev-card.medium { border-top-color: var(--sev-medium); }
.sev-card.low { border-top-color: var(--sev-low); }
.sev-card.none { border-top-color: var(--sev-none); }
.sev-card .n { font-family: var(--font-mono); font-weight: 700; font-size: 26px; color: var(--bh-black); line-height: 1; }
.sev-card .l { font-family: var(--font-cond); font-weight: 700; font-size: 11px; letter-spacing: 0.08em;
               text-transform: uppercase; color: var(--fg-2); margin-top: 6px; }

/* ---- tables ---- */
table.tbl { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 13.5px; }
table.tbl th { background: var(--bh-red); color: #fff; font-family: var(--font-cond); font-weight: 700;
               font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; text-align: left; padding: 10px 12px; }
table.tbl th.num { text-align: right; }
table.tbl td { padding: 9px 12px; border-bottom: 1px solid var(--stroke-light); color: var(--fg-2);
               vertical-align: top; line-height: 1.45; }
table.tbl tr:last-child td { border-bottom: 0; }
table.tbl tr { break-inside: avoid; }
table.tbl .num { font-family: var(--font-mono); text-align: right; white-space: nowrap; color: var(--bh-black); }
table.tbl td.title { color: var(--bh-black); font-weight: 500; }
.row-group td { background: var(--bh-light-gray); font-weight: 700; color: var(--bh-black); font-family: var(--font-cond);
                letter-spacing: 0.06em; text-transform: uppercase; font-size: 12px; }
/* The engagement goals a summary-table row is linked to, printed as one muted
   line under the row's description (Summary of Strengths). A line inside the
   existing cell rather than a column of its own — the table has three columns,
   descriptions are long, and a fourth would squeeze them. */
.cell-goals { margin: 6px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--fg-3); }

/* ---- toc ---- */
.toc { margin-top: 8px; }
.toc-item { display: flex; align-items: baseline; gap: 16px; padding: 13px 0; border-top: 1px solid var(--stroke-light);
            break-inside: avoid; }
.toc-item:last-child { border-bottom: 1px solid var(--stroke-light); }
.toc-n { font-family: var(--font-mono); font-weight: 700; font-size: 13px; color: var(--bh-red); width: 30px; flex: none; }
.toc-t { font-size: 16px; font-weight: 500; color: var(--bh-black); }
.toc-dot { flex: 1; border-bottom: 1px dotted var(--stroke-light); transform: translateY(-4px); }
.toc-item.sub { padding: 8px 0 8px 30px; }
.toc-item.sub .toc-n { font-size: 11px; width: 34px; }
.toc-item.sub .toc-t { font-size: 14px; font-weight: 400; color: var(--fg-2); }

/* ---- callout ---- */
.callout { border: 1px solid var(--stroke-light); border-left: 3px solid var(--bh-red);
           border-radius: 0 8px 8px 0; background: #fafafa; padding: 16px 20px; margin-top: 20px; break-inside: avoid; }

/* ---- finding block ---- */
.finding { margin-top: 32px; break-inside: avoid; }
.finding:first-of-type { margin-top: 0; }
.finding-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
                border-top: 2px solid var(--bh-black); padding-top: 14px; break-after: avoid; }
.finding-num { font-family: var(--font-mono); font-weight: 700; font-size: 14px; color: var(--bh-red); }
.finding-title { font-weight: 900; font-size: 22px; letter-spacing: -0.01em; line-height: 1.15;
                 color: var(--bh-black); flex: 1; min-width: 60%; }
.finding-meta { font-size: 13px; color: var(--fg-2); margin: 10px 0 0; }
.finding-meta code { font-family: var(--font-mono); font-size: 12px; background: var(--bh-light-gray);
                     border-radius: 4px; padding: 1px 6px; color: var(--bh-black); }
.finding-meta .sep { color: var(--stroke-light); margin: 0 8px; }
/* A finding's own tag chips, under the meta line. Its own class rather than the
   timeline's .tl-tags: the margin belongs to this card's rhythm, and .tl-tags is
   the literal markup an Assessment Execution test asserts the absence of to prove
   evidence tags are suppressed. break-after: avoid keeps the row with the
   Description heading that follows it when a card is taller than one page and
   Chromium has to ignore the card's break-inside: avoid. The chip colours already
   print at full saturation: tagChip() writes the palette hexes inline and
   print-color-adjust: exact is set on html and inherited. (No backticks in this
   comment — the whole stylesheet is a template literal.) */
.finding-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0;
                break-inside: avoid; break-after: avoid; }
.finding h4.sub { font-family: var(--font-cond); font-weight: 700; font-size: 12px; letter-spacing: 0.1em;
                  text-transform: uppercase; color: var(--fg-3); margin: 20px 0 8px; break-after: avoid; }
/* Cross-reference lists under a finding (Detailed Findings): the related
   recommendations, and the goals the finding is linked to. Phrased so no heading
   this stylesheet styles is quotable out of it — an absence test for a block
   should not match a comment in every report's <style>. */
.rec-links { margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.6; color: var(--fg-1); }
.rec-links li { margin: 2px 0; }
.rec-links strong { font-family: var(--font-mono); color: var(--bh-red); font-weight: 700; }

/* ---- evidence ---- */
.ev { margin: 0 0 16px; break-inside: avoid; }
.ev img { max-width: 100%; border: 1px solid var(--stroke-light); border-radius: 6px; display: block; }
.ev figcaption, figcaption { color: var(--fg-2); font-size: 12.5px; margin-top: 6px; line-height: 1.4; }
.ev-lang { font-family: var(--font-cond); font-weight: 700; font-size: 10px; letter-spacing: 0.08em;
           text-transform: uppercase; background: var(--bh-light-gray); border-radius: 4px; padding: 1px 7px;
           color: var(--fg-2); margin-left: 6px; }
.ev-code { background: #f6f6f6; border: 1px solid var(--stroke-light); border-radius: 6px; padding: 12px;
           overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono);
           font-size: 12px; line-height: 1.5; color: #1a1a1a; margin-top: 6px; }
.ev-note { color: var(--fg-2); font-size: 13px; margin: 0; }
.ev-note .play { color: var(--bh-red); font-weight: 700; }

/* attack path steps */
.path { list-style: none; margin: 8px 0 0; padding: 0; }
.step { border-left: 2px solid var(--bh-red); padding: 2px 0 4px 16px; margin: 0 0 18px; break-inside: avoid; }
.step-label { font-family: var(--font-cond); font-weight: 700; font-size: 10px; letter-spacing: 0.1em;
              text-transform: uppercase; color: var(--bh-red); margin: 0 0 5px; }
.step-caption { margin: 0 0 8px; font-size: 14px; line-height: 1.55; color: var(--fg-1); }

/* ---- timeline item ---- */
.tl-item { border-top: 1px solid var(--stroke-light); padding: 16px 0; break-inside: avoid; }
.tl-item:first-of-type { border-top: 0; }
.tl-when { font-family: var(--font-mono); font-size: 12px; color: var(--bh-red); font-weight: 500; }
.tl-who { font-size: 12px; color: var(--fg-3); margin-left: 8px; }
.tl-title { font-size: 14px; font-weight: 600; color: var(--fg-1); margin: 6px 0 0; }
.tl-desc { font-size: 13px; line-height: 1.55; color: var(--fg-2); margin: 4px 0 0; }
.tl-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
.tl-body { margin-top: 10px; }
.group-head { font-family: var(--font-cond); font-weight: 700; font-size: 14px; letter-spacing: 0.06em;
              text-transform: uppercase; color: var(--bh-black); margin: 26px 0 2px; padding-bottom: 6px;
              border-bottom: 2px solid var(--bh-red); break-after: avoid; }
.group-head:first-of-type { margin-top: 8px; }
.group-count { color: var(--fg-3); font-weight: 500; }

@page { size: Letter; margin: 0.5in 0.6in 0.62in; }
@page {
  @top-left { content: "${left}"; font-family: 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif;
              font-size: 8.5px; letter-spacing: 0.12em; color: #9a9897; }
  @top-right { content: "${right}"; font-family: 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif;
               font-size: 8.5px; letter-spacing: 0.12em; color: #9a9897; }
  @bottom-center { content: "PAGE " counter(page) " OF " counter(pages);
                   font-family: 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif; font-size: 8.5px;
                   letter-spacing: 0.12em; color: #9a9897; }
}
@page :first {
  margin: 0;
  @top-left { content: none; }
  @top-right { content: none; }
  @bottom-center { content: none; }
}
h2, h3, h4 { break-after: avoid; }
p, li { orphans: 3; widows: 3; }
`;
}

/**
 * The attestation-letter stylesheet. Shares the report's tokens, fonts, colors
 * and running header/footer so a letter reads as a first-class reporter
 * deliverable — but it is a self-contained sheet (not `reportCss`) because a
 * letter has no full-bleed cover: it needs its normal margins and the running
 * header on the FIRST page too, whereas `reportCss`'s `@page :first` zeroes them
 * for the cover. Keep the `:root` tokens here in sync with `reportCss`. `accent`
 * drives the red accent; `hdrLeft`/`hdrRight` are the running-header text (plain,
 * already uppercased by the caller).
 */
export function letterCss(accent: string, hdrLeft: string, hdrRight: string): string {
  const left = cssString(hdrLeft);
  const right = cssString(hdrRight);
  return `
:root {
  --bh-red: ${accent};
  --accent: ${accent};
  --bh-black: #000000;
  --bh-near-black: #0d0d0d;
  --bh-stroke-light: #d6d8d7;
  --bh-muted: #9a9897;
  --fg-1: var(--bh-black);
  --fg-2: #686563;
  --fg-3: var(--bh-muted);
  --stroke-light: var(--bh-stroke-light);
  --font-sans: 'Roboto', 'Helvetica Neue', Arial, sans-serif;
  --font-cond: 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif;
  --font-mono: 'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
html { font-family: var(--font-sans); color: var(--fg-1); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #fff; -webkit-font-smoothing: antialiased; font-family: var(--font-sans); color: var(--fg-1); }
h1, h2, h3, p { margin: 0; }

/* rendered markdown prose (methodology / scope), mirrors the report's .md */
.md { color: var(--fg-1); font-size: 13.5px; line-height: 1.6; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 10px; }
.md ul, .md ol { margin: 0 0 10px; padding-left: 22px; }
.md li { margin: 2px 0; }
.md strong { font-weight: 700; }
.md em { font-style: italic; }
.md a { color: var(--bh-red); text-decoration: underline; }

/* ---- letterhead ---- */
.letterhead { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px;
              border-bottom: 1px solid var(--stroke-light); padding-bottom: 14px; margin-bottom: 30px; }
.lh-logo { max-height: 44px; max-width: 240px; width: auto; display: block; }
.lh-wordmark { font-weight: 900; font-size: 22px; letter-spacing: -0.01em; color: var(--bh-black); }
.lh-wordmark .dot { color: var(--bh-red); }
.lh-client { font-size: 13px; color: var(--fg-2); text-align: right; font-weight: 500; }

/* ---- title ---- */
.letter-title { font-weight: 900; font-size: 25px; letter-spacing: -0.01em; line-height: 1.12;
                color: var(--bh-black); text-transform: uppercase; }
.letter-rule { width: 56px; height: 4px; background: var(--bh-red); border: 0; margin: 12px 0 26px; }

/* ---- letter body ---- */
.letter { font-size: 13.5px; line-height: 1.6; color: var(--fg-1); }
.letter p { margin: 0 0 13px; }
.letter .date { margin: 0 0 20px; }
.letter .addr { margin: 0 0 18px; line-height: 1.5; }
.letter .re { font-weight: 700; color: var(--bh-black); margin: 0 0 18px; }
.letter h2 { font-family: var(--font-cond); font-weight: 700; font-size: 13px; letter-spacing: 0.1em;
             text-transform: uppercase; color: var(--bh-black); margin: 26px 0 10px; break-after: avoid; }
.letter ol { margin: 0 0 13px; padding-left: 22px; }
.letter ol li { margin: 0 0 9px; padding-left: 4px; }
.letter ul.scope { list-style: disc; margin: 0 0 13px; padding-left: 22px; }
.letter ul.scope li { margin: 0 0 8px; }
.letter .fineprint { font-size: 11px; line-height: 1.5; color: var(--fg-2); margin: 0 0 13px; }

/* ---- key-value summary table ---- */
table.kv { width: 100%; border-collapse: collapse; margin: 4px 0 6px; font-size: 13px; }
table.kv td { padding: 8px 0; border-bottom: 1px solid var(--stroke-light); vertical-align: top; line-height: 1.45; }
table.kv tr:last-child td { border-bottom: 0; }
table.kv td.k { font-weight: 700; color: var(--bh-black); width: 34%; padding-right: 16px; }
table.kv td.v { color: var(--fg-2); }

/* ---- severity counts table (report red-header style) ---- */
table.tbl { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 13px; }
table.tbl th { background: var(--bh-red); color: #fff; font-family: var(--font-cond); font-weight: 700;
               font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; text-align: center; padding: 9px 10px; }
table.tbl td { padding: 9px 10px; border-bottom: 1px solid var(--stroke-light); color: var(--bh-black);
               text-align: center; font-family: var(--font-mono); }

/* ---- signature ---- */
.sig { margin-top: 34px; break-inside: avoid; }
.sig .close { margin: 0 0 44px; }
.sig .line { width: 280px; border-top: 1px solid var(--bh-black); margin: 0 0 8px; }
.sig .nm { font-weight: 700; color: var(--bh-black); }
.sig .rl { color: var(--fg-2); }
.sig .date { margin-top: 26px; color: var(--fg-2); }

@page { size: Letter; margin: 0.8in 0.85in 0.85in; }
@page {
  @top-left { content: "${left}"; font-family: 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif;
              font-size: 8.5px; letter-spacing: 0.12em; color: #9a9897; }
  @top-right { content: "${right}"; font-family: 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif;
               font-size: 8.5px; letter-spacing: 0.12em; color: #9a9897; }
  @bottom-center { content: "PAGE " counter(page) " OF " counter(pages);
                   font-family: 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif; font-size: 8.5px;
                   letter-spacing: 0.12em; color: #9a9897; }
}
h2 { break-after: avoid; }
p, li { orphans: 3; widows: 3; }
`;
}
