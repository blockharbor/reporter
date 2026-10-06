# reporter — design system & style guide

reporter spans three surfaces (web, desktop, terminal). They must feel like **one professional product**. This document is the contract; the `ux-ui` agent enforces it, and `@reporter/ui` implements it.

## Principles

1. **One product, three windows.** The desktop renderer is the web UI in a smaller frame — same components, same tokens. The terminal recorder is the same brand translated to ANSI. Nothing is bespoke per surface without a reason.
2. **Calm and dense, not flashy.** This is an operator tool used for hours. Prefer clarity, generous hit targets, and low chrome over decoration.
3. **Never a dead end.** Every async action shows loading → success/error. Every list has an empty state with a next action. Every destructive action confirms.
4. **Consistent words.** Use the glossary below verbatim, everywhere.

## Terminology glossary (use these exact words)

| Term                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Never call it                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Engagement**            | The top-level container that scopes all evidence, findings, and tags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | operation, project, case        |
| **Evidence**              | A single timestamped artifact (screenshot, recording, note…).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | item, artifact, capture         |
| **Comment**               | A piece of evidence linked to another as a follow-up/update — a.k.a. _Linked Evidence_.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | reply, annotation, thread       |
| **Finding**               | A reportable grouping of evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | issue, vuln, result             |
| **Severity**              | A finding's risk rating on the CVSS v3.1 scale: None, Low, Medium, High, Critical.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | priority, criticality           |
| **Tag**                   | A colored label on evidence, scoped to an engagement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | label, category                 |
| **Operator**              | The user who captured a piece of evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | author, creator                 |
| **Deleted user**          | Stand-in byline for evidence or a comment whose author has been deleted. Deleting a user is a hard delete, but their evidence survives it. Use `DELETED_USER_LABEL` from `@reporter/shared`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | anonymous, unknown, former user |
| **Excluded from reports** | A per-evidence flag that keeps that evidence — and any linked evidence under it — out of every report output generated from then on (PDF, supporting-files ZIP, JSON export), while leaving it fully visible in the app; reports already in the history keep the exclusions that were in force when they were generated, because each one is the record of what was delivered. One deliberate exception: a **backup export** can be asked to carry it, flagged, so an import restores the exclusion along with the evidence.                                                                                                                                      | hidden, redacted, private       |
| **Report template**       | A named, saved report configuration — the sections, their order and per-section options, the custom sections, the findings grouping, and the evidence-log and sanitize choices — kept in a **site-wide library** so any engagement can produce the same kind of report. **Apply** copies a template into one engagement's own configuration (and never touches that engagement's report-readiness "Not applicable" marks, which are not part of a template); **generating** with one uses it for that report only. Saving, renaming and deleting a template needs write access on at least one engagement; applying or generating with one needs only an account. | preset, profile, report type    |
| **API key**               | An access-key/secret-key pair for client apps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | token, credential               |

Empty-state copy is warm and instructive ("No evidence yet — capture your first screenshot with the desktop app or drop a file here."). Errors are plain and actionable ("Couldn't reach the server. Check the server URL in Settings."). No stack traces in the UI.

## Color tokens

Defined as CSS variables in `@reporter/ui` (`src/tokens.css`), exposed to Tailwind via the preset. Semantic roles — **never reference raw hex in app code**.

Primitive palette (brand): a slate-neutral base with a single confident **teal** accent, plus status hues.

| Semantic role               | Light     | Dark      |
| --------------------------- | --------- | --------- |
| `--bg` (app background)     | `#f7f8fa` | `#0e1116` |
| `--surface` (cards, panels) | `#ffffff` | `#171b22` |
| `--surface-2` (raised)      | `#f0f2f5` | `#1f242d` |
| `--border`                  | `#e2e5ea` | `#2a303a` |
| `--text`                    | `#1a1d23` | `#e6e9ef` |
| `--text-muted`              | `#5b6472` | `#9aa4b2` |
| `--accent` (teal)           | `#0e8a8a` | `#2dd4bf` |
| `--accent-contrast`         | `#ffffff` | `#04211f` |
| `--success`                 | `#1f9d55` | `#3ddc84` |
| `--warning`                 | `#c77700` | `#f0b429` |
| `--danger`                  | `#d64545` | `#ff6b6b` |
| `--info`                    | `#2d7ff9` | `#5ea2ff` |

Tag colors are a fixed 12-swatch palette shared from `@reporter/shared` (`TAG_COLORS`) so a tag looks identical in the web timeline, desktop history, and CLI selection list.

## Typography

- **UI / body:** Inter (bundled in `@reporter/ui/fonts`, `--font-sans`).
- **Code / terminal / monospace:** JetBrains Mono (`--font-mono`).
- Type scale (rem): `xs .75 / sm .875 / base 1 / lg 1.125 / xl 1.25 / 2xl 1.5 / 3xl 1.875`.
- Weights: 400 body, 500 medium (labels), 600 semibold (headings). No thin/black weights.

## Spacing & shape

- Spacing scale: `4 8 12 16 24 32 48` (px). Use Tailwind spacing tokens; no arbitrary values.
- Radius: `--radius-sm 6px`, `--radius 10px`, `--radius-lg 14px`. Cards use `--radius`, inputs/buttons `--radius-sm`.
- Elevation: one soft shadow token `--shadow` for popovers/modals; flat surfaces otherwise.
- Focus: always a visible `--accent` focus ring (2px). Never remove outlines without a replacement.

## Components (in `@reporter/ui`)

`Button` (variants: primary/secondary/ghost/danger; sizes sm/md), `Input`, `Textarea`, `Select`, `Checkbox`, `Modal`, `Confirm` (`useConfirm`), `Toast` (+ `useToast`), `Card`, `Badge`, `SeverityBadge`, `TagChip`, `TagPicker`, `Table`, `EmptyState`, `Spinner`, `DateRangePicker`, `Tabs`, `ThemeProvider`/`useTheme`. Pages compose these; they don't restyle them.

## Terminal recorder styling

`apps/term/src/theme.ts` maps the palette to ANSI: accent = teal, success = green, warning = yellow, danger = red, muted = gray. Symbols match GUI toast semantics: `✔` success, `✖` error, `⚠` warning, `›` prompt. Same glossary and tone as the GUI.

## Read-only & insufficient-role controls

When the user lacks the role a control needs, render it **disabled with a `title` explaining why** (`READ_ONLY_TITLE` / `ADMIN_ONLY_TITLE` from `apps/web/src/lib/permissions.ts`) — don't hide it. Inputs disable along with their save buttons, so a whole form reads as inert rather than a form that fails on submit. Never add `pointer-events-none` to disabled controls: it suppresses the explanatory tooltip.

## Accessibility baseline

- Contrast ≥ 4.5:1 for text (tokens above are chosen to pass in both themes).
- All interactive elements keyboard-reachable and focus-visible.
- Modals trap focus and close on Esc. Forms label every input. Icons that carry meaning have `aria-label`.
