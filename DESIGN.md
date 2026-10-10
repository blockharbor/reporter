# reporter — design system & style guide

reporter spans three surfaces (web, desktop, terminal). They must feel like **one professional product**. This document is the contract; the `ux-ui` agent enforces it, and `@reporter/ui` implements it.

## Principles

1. **One product, three windows.** The desktop renderer is the web UI in a smaller frame — same components, same tokens. The terminal recorder is the same brand translated to ANSI. Nothing is bespoke per surface without a reason.
2. **Calm and dense, not flashy.** This is an operator tool used for hours. Prefer clarity, generous hit targets, and low chrome over decoration.
3. **Never a dead end.** Every async action shows loading → success/error. Every list has an empty state with a next action. Every destructive action confirms.
4. **Consistent words.** Use the glossary below verbatim, everywhere.

## Terminology glossary (use these exact words)

| Term                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Never call it                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Engagement**            | The top-level container that scopes all evidence, findings, and tags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | operation, project, case                |
| **Evidence**              | A single timestamped artifact (screenshot, recording, note…).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | item, artifact, capture                 |
| **Script**                | An evidence type for a full, runnable script — distinct from the short **Code block** snippet. Typed or uploaded, stored as editable text, carries an optional interpreter (`bash`, `python`, …), and renders **verbatim** (never as markdown) in the report, viewer and editor. Shown as `Script` in the type filter and report captions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | file, shell script, codeblock           |
| **Comment**               | A piece of evidence linked to another as a follow-up/update — a.k.a. _Linked Evidence_.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | reply, annotation, thread               |
| **Finding**               | A reportable grouping of evidence, carrying the engagement's tags like the evidence does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | issue, vuln, result                     |
| **Severity**              | A finding's risk rating on the CVSS v3.1 scale: None, Low, Medium, High, Critical.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | priority, criticality                   |
| **Tag**                   | A colored label, scoped to an engagement, applied to evidence and to findings — one pool for both, managed on the engagement's Settings tab.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | label, category                         |
| **Operator**              | The user who captured a piece of evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | author, creator                         |
| **Deleted user**          | Stand-in byline for evidence or a comment whose author has been deleted. Deleting a user is a hard delete, but their evidence survives it. Use `DELETED_USER_LABEL` from `@reporter/shared`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | anonymous, unknown, former user         |
| **Excluded from reports** | A per-evidence flag that keeps that evidence — and any linked evidence under it — out of every report output generated from then on (PDF, supporting-files ZIP, JSON export), while leaving it fully visible in the app; reports already in the history keep the exclusions that were in force when they were generated, because each one is the record of what was delivered. One deliberate exception: a **backup export** can be asked to carry it, flagged, so an import restores the exclusion along with the evidence.                                                                                                                                                                                                                                                                                                            | hidden, redacted, private               |
| **Report template**       | A named, saved report configuration — the sections, their order and per-section options, the custom sections, the findings grouping, and the evidence-log and sanitize choices — kept in a **site-wide library** so any engagement can produce the same kind of report. **Apply** copies a template into one engagement's own configuration (and never touches that engagement's report-readiness "Not applicable" marks, which are not part of a template); **generating** with one uses it for that report only. Saving, renaming and deleting a template needs write access on at least one engagement; applying or generating with one needs only an account.                                                                                                                                                                       | preset, profile, report type            |
| **Engagement export**     | A single `.zip` holding one whole Engagement — its details and report content, Targets/Activities/Goals, Tags, every piece of Evidence **including the stored file content**, comments, Findings and their categories and evidence links, saved queries, and the report history with the exact files that were generated. It is a **backup**, not a deliverable, so it carries Evidence marked **Excluded from reports** as well, with the flag intact. It also carries the engagement's **Audit log** — which names everyone who ever acted on the engagement, by name and email, and records its membership changes — unless the download asks to leave it out. Downloading one needs engagement **admin**. Membership itself, favorites, API keys, sessions and this server's site-wide report branding and templates are not in it. | dump, archive, snapshot                 |
| **Import engagement**     | Restoring an Engagement from an engagement export. It **always creates a new Engagement** and can never modify, overwrite or merge into one that already exists — the route has no engagement in it, so there is nothing for a request to address. The new slug comes from the file (made unique) or from the importer. Evidence and comment authors are matched to local accounts **by email**; no match shows as **Deleted user**, and an import never creates an account. Whoever imports becomes the new Engagement's admin. Needs a **site admin**.                                                                                                                                                                                                                                                                                | restore, merge, overwrite               |
| **API key**               | An access-key/secret-key pair for client apps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | token, credential                       |
| **Audit log**             | The append-only record of what happened: on an engagement (its **Audit log** tab, for writers and admins) and across the site (Admin → Audit log). Every entry says who, when, what changed and what to; a burst of edits to one field within a short window folds into one entry with a count. Entries are never deleted. A site admin can **remove** one, which erases its details for good and leaves a permanent, visible record of the removal in its place.                                                                                                                                                                                                                                                                                                                                                                       | activity log, history, event log, trail |

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

`Button` (variants: primary/secondary/ghost/danger; sizes sm/md), `Input`, `Textarea`, `Select`, `Checkbox`, `Modal`, `Confirm` (`useConfirm`), `Toast` (+ `useToast`), `Popover`, `Card`, `Badge`, `FilterChip`, `SeverityBadge`, `TagChip`, `TagPicker`, `Table` (with `Thead`/`Tbody`/`Tr`/`Th`/`Td` and `SortableTh`), `EmptyState`, `ErrorState`, `Spinner`, `DateRangePicker`, `Tabs`, `ThemeProvider`/`useTheme`. Pages compose these; they don't restyle them.

## Filter & sort bars

Every list view (evidence, findings, both audit logs) carries the same bar, and three rules keep them converged:

1. **Plain text fields apply as you type** — debounced when each application is a server round trip (the audit logs), immediately when the filter is client-side (findings). Submit-on-Enter is reserved for a query mini-language (the evidence timeline's query box), where a half-typed expression is an error rather than a narrower result.
2. **Filter and sort changes `history.replace`; page changes `push`.** A filter change returns to page 1. Back then walks pages, not keystrokes, and a URL always reproduces the view.
3. **"Clear all" lives in the bar's right-hand group** behind one `onClearAll`, and the bar carries one `role="status"` line stating the count.

Every list names its four states: loading, error (with a retry), empty (with the next action), and _no results match your filters_ (with Clear all).

The findings bar and both audit logs follow all three rules. The evidence timeline's bar predates them and still keeps Clear all beside its chips with no count line; converging it is the outstanding follow-up, not a reason to relax the rule.

## Terminal recorder styling

`apps/term/src/theme.ts` maps the palette to ANSI: accent = teal, success = green, warning = yellow, danger = red, muted = gray. Symbols match GUI toast semantics: `✔` success, `✖` error, `⚠` warning, `›` prompt. Same glossary and tone as the GUI.

## Read-only & insufficient-role controls

When the user lacks the role a control needs, render it **disabled with a `title` explaining why** (`READ_ONLY_TITLE` / `ADMIN_ONLY_TITLE` / `SITE_ADMIN_ONLY_TITLE` from `apps/web/src/lib/permissions.ts`) — don't hide it. Inputs disable along with their save buttons, so a whole form reads as inert rather than a form that fails on submit. Never add `pointer-events-none` to disabled controls: it suppresses the explanatory tooltip.

The one documented exception is **navigation**: a tab the role can never use — the engagement **Audit log** tab for a read-only member — is hidden rather than shown disabled, because an inert tab in a strip is noise, not guidance. It hides only once the role is _known_: while the engagement is still loading the tab renders, so the strip never flickers a tab in on every load or yanks one from under a user during a refetch, and a deep link to a hidden tab lands on an explanatory empty state rather than an error toast.

## Audit log

The log's user-facing vocabulary is pinned in `@reporter/shared` (`AUDIT_ENTITY_TYPE_LABELS`, `AUDIT_ACTION_LABELS`) and every surface reads from there — never a hand-written list:

| Entity type        | Label             | Why                                                                                                              |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `evidence`         | Evidence          | A linked **Comment** is an Evidence row and records as evidence.                                                 |
| `evidence_comment` | **Evidence note** | The discussion thread under an item. Never "Comment": the glossary reserves that for linked evidence.            |
| `finding_evidence` | Finding evidence  | The link between a finding and an item, with its caption and bucket.                                             |
| `member`           | Member            | A user's role on one engagement.                                                                                 |
| `generated_report` | Report            | A row in the report history.                                                                                     |
| `report_settings`  | Report branding   | The Admin tab's own name for it.                                                                                 |
| `saved_query`      | Saved query       |                                                                                                                  |
| everything else    | its glossary word | Engagement, Target, Activity, Goal, Finding, Finding category, Tag, Report template, Default tag, User, API key. |

Rows with no human actor read **System**; rows with no engagement read **No engagement**. A row restored from an engagement export carries an **Imported** badge, because a file can say anything and this server did not witness it.

The log is append-only and tamper-evident **against the application**: a database trigger refuses every delete and every rewrite of recorded content, and a removal leaves a permanent record of who removed what and why. It is not tamper-evident against a database superuser, who can drop the trigger or the table; protecting against that is a matter of database access and off-box backups, not of this feature.

## Accessibility baseline

- Contrast ≥ 4.5:1 for text (tokens above are chosen to pass in both themes).
- All interactive elements keyboard-reachable and focus-visible.
- Modals trap focus and close on Esc. Forms label every input. Icons that carry meaning have `aria-label`.
