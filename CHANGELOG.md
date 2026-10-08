# Changelog

All notable changes to **reporter** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org). Every workspace (server, web,
desktop, terminal recorder, and shared packages) shares one version; bump it
with `pnpm run version:bump <major|minor|patch>`.

## [Unreleased]

### Added

- **Each finding in the report now lists the engagement goals it is linked to.**
  Detailed Findings prints a **Linked Goals** block under each weakness — the goal's
  title over a muted `Target · Activity` context line, listed in the same order the
  Scope & Objectives Coverage table uses. A finding with no linked goals prints
  nothing at all, never a "not linked to any goal" line. A new **Show each finding's
  linked goals** control under Detailed Findings (Reports → Configure) turns the
  block off per engagement, and a saved report template carries the choice like the
  rest of the configuration. The block deliberately omits each goal's status, which
  the app's finding page does show: status is assessor workflow state, and a goal
  reading "Not started" beside a confirmed Critical weakness reads as an unfinished
  assessment in a signed deliverable.
- **A new `Script` evidence type for full, runnable scripts — distinct from the
  short `Code block` snippet.** A script is captured by typing it into a monospace
  editor or by uploading a file (decoded to UTF-8 and stored as editable text, so
  either way it stays editable afterwards), with an optional interpreter (`bash`,
  `python`, …) that names it in the report. Unlike a code block, a script renders
  **verbatim** everywhere — the PDF, the in-app viewer, and the editor — never as
  markdown, so a leading `#!/bin/bash` stays a shebang instead of becoming a
  heading. It ships in the supporting-files ZIP with a sensible extension derived
  from the interpreter (`.sh`, `.py`), and keeps its uploaded filename when it has
  one.
- **Four new Assessment Execution display controls (Reports → Configure).** Three
  per-section toggles — **Evidence tags**, **Evidence type captions**, and **Script
  contents** — and one top-level report option, **Number subsection titles**, which
  prefixes the hand-authored subsection headings with `1.`, `2.`, `3.`… in the order
  they already render (a labelling change only — nothing is reordered). All four
  default to today's behaviour, so every existing engagement's report is byte-for-byte
  unchanged. Turning **Script contents** off replaces each script's inline body with a
  one-line pointer to its ZIP entry; the script is still delivered in the ZIP either
  way.
- **An evidence item's language / interpreter is now shown and editable.** The value
  that names a script's file in the report ZIP (`.sh`, `.py`) and prints as the
  report's language chip used to be write-once and invisible after capture; the
  evidence Content card now displays it — with the extension it will produce — and
  lets a writer correct it.

### Changed

- **That Linked Goals block defaults on, so an engagement configured before this
  release gains it in its next report.** This is a deliberate change to what those
  reports print: a finding's objectives are standard report content you opt _out_ of,
  not a section sub-item you opt in to. Turn it off under Reports → Configure →
  Detailed Findings.
- **A built-in report type now honours the per-section display choices.** Picking
  "Full report", "Executive summary" or "Findings only" from **Report type**
  previously reset every per-section sub-item to on, because a preset carries no
  options of its own. A preset decides _which_ sections appear, not what each one
  shows, so the engagement's sub-item choices are now carried across — most
  importantly **Script contents**, where the old behaviour printed script bodies in
  full for an author who had deliberately suppressed them. Engagements that had
  switched an older sub-item (e.g. _Standards traceability_) off will now see that
  choice respected by a preset report too.
- Applying a report template warns when it would re-print script bodies the
  engagement currently withholds, alongside the existing sanitize warning.

### Fixed

- The **Scope & Objectives Coverage** table no longer counts findings the report
  omits. Each goal's `findings / evidence` tally filtered the evidence side to what
  the report prints but counted _every_ linked finding, so a goal linked to a finding
  still short of "Ready to report" advertised coverage the document never shows. The
  interactive Goals page keeps the true totals — it is where an author goes to see
  what is still outstanding, and a report asked for _every_ finding tallies every
  finding, so the two always agree.
- **Linked goals** on an evidence or finding detail view are now listed in the same
  Target → Activity → Goal order as the goals tree and the report, instead of in
  whatever order the database returned them.
- An unrecognized script interpreter no longer becomes the file extension in the
  report ZIP. Free text such as `pyton`, `Bourne Again Shell` or `C#` produced
  `.pyton`, a truncated `.bourneag`, or the plausible-but-wrong `.c`; an interpreter
  outside the known table now yields `.txt`, which is the only honest answer.
- An engagement import now applies the same UTF-8 and size checks to `script`
  evidence that the capture path does, instead of writing bytes the report would
  later render as replacement characters into a client PDF.
- An empty script upload is refused instead of being stored as a zero-length
  supporting file, which put a blank entry (and the SHA-256 of nothing) in the
  report's Files Attached table.

## [0.10.0] - 2026-10-07

### Added

- **Full engagement export — one `.zip` that recreates an entire engagement on
  another reporter server.** **Settings → Export engagement** downloads the whole
  thing: the engagement's details and all of its report content, its Targets,
  Activities and Goals, its Tags, every piece of Evidence **including the stored file
  content** (screenshots, terminal recordings, thumbnails), comments on evidence,
  every Finding with its categories and evidence links, the saved queries, and the
  report history together with the exact files that were generated. A backup is not a
  deliverable, so Evidence marked **Excluded from reports** travels too, still
  flagged. This is separate from the existing findings-scoped JSON export, which is
  for moving findings between engagements and is unchanged.
- **Import engagement always creates a new engagement.** On **Engagements**, a site
  admin can restore an engagement from an export archive. It can never modify,
  overwrite or merge into an engagement that already exists — there is no way to ask
  it to, because the import address names no engagement. The new slug comes from the
  file (made unique if taken) or from whoever imports it, and an explicit slug that is
  already in use is refused rather than landing somewhere unexpected. The result
  reports what was created, which report references were rewritten to the new rows,
  and everything that was deliberately left behind.
- **An import never creates an account, and never shares the original's files.**
  Evidence and comment bylines travel as email addresses and are matched to accounts
  on the destination server; with no match the byline shows as **Deleted user**. Every
  stored file is re-saved under a fresh key, so deleting an imported engagement cannot
  destroy the original's evidence or report artifacts. Membership is not in the file —
  whoever imports becomes the new engagement's admin — and neither are favorites, API
  keys, sessions, or the destination's own site-wide report branding and templates.
  The archive is validated in full before a single row is written, and a failed import
  leaves nothing behind.

- **Report templates — a site-wide library of named report configurations.** Save
  the configuration you built on **Reports → Configure** under a name, and any
  engagement can reproduce the same kind of report. A template captures the section
  selection and order, every per-section option, the custom sections (titles and
  bodies, so a `custom:` section entry still resolves), the findings grouping, and
  the evidence-log and sanitize choices. It deliberately does **not** capture the
  engagement's report-readiness **"Not applicable"** marks — those are bookkeeping
  about one engagement's checklist, not a reporting choice — and applying a template
  never touches them.
- **Apply a template, or generate one report from it.** **Apply** (behind a confirm,
  because it overwrites) copies a template into this engagement's own configuration;
  the template's custom sections are **merged**, not substituted — the template's
  version wins when an id collides, and your own custom sections the template never
  references are kept, listed switched off so nothing is deleted and nothing appears
  in the report uninvited. On **Reports → Generate & History**, templates sit beside
  the built-in report types: generating with one uses its configuration **for that
  report only** and leaves the engagement's own configuration exactly as it was. The
  download and the **Report history** row are named for the template.
- **A template that would un-sanitize a report says so first.** `Show evidence
timestamps` and `Show evidence operators` decide whether evidence capture times and
  operator identities reach a client deliverable, and both are off by default, so a
  template that would switch either on names exactly what it would reveal — in the
  apply confirm, under the Generate chooser, and in the confirm before the report is
  produced. Every template is badged **Sanitized** or **Shows timestamps + operator
  names** wherever it is listed.
- **Admin → Report templates** curates the library: each row shows how much of the
  report the template turns on (with the enabled section names on hover), its
  sanitize state, who saved it and when, and offers rename/reword and delete.
  Deleting a template leaves every engagement that applied it — and every report
  already generated from it — untouched, because applying copies rather than links.
  Saving, renaming and deleting a template needs **write access on at least one
  engagement** (or site admin); listing, applying and generating with one needs only
  an account.
- **Exclude a piece of evidence from reports.** Each piece of evidence gets a
  **Report** card with an **Exclude from reports** checkbox. Excluded evidence is
  left out of _every_ report output — all six PDF inclusion paths, the
  supporting-files ZIP (and its `SHA256SUMS.txt` / "Files Attached" table), the
  per-goal coverage counts, the cover and Executive Summary evidence totals, and
  the JSON export. **Linked evidence under an excluded capture is withheld too**:
  a report renders a follow-up capture standalone, so shipping one whose parent was
  withheld would hand over a fragment of a withheld capture. It all stays **fully
  visible in the app** — timeline, finding pages, and pickers — badged **Excluded
  from reports**, so it can always be un-excluded.
- **Excluding evidence affects future report output only**, and the **Report** card
  now says so at the moment you tick the box. Entries in **Reports → Report history**
  are left exactly as they were: a generated report is the immutable record of what
  was handed to the client, and its stored SHA-256, the `SHA256SUMS.txt` inside a ZIP
  bundle, and any attestation letter naming that report version all describe those
  exact bytes. After excluding something, generate a new report version rather than
  expecting an already-delivered download to have changed.
- **"Findings needing attention" on the Reports tab.** Beside the readiness
  checklist (and mirrored in the confirm before you generate), an advisory panel
  lists the findings you have already marked **Ready to report** that the report
  will nonetheless render incomplete: no linked evidence, no severity rating, no
  remediation guidance, or — the one you cannot otherwise see — **every** linked
  evidence item withheld from reports, so the finding ships with no evidence section
  at all. Each row links straight to the finding. It is advisory only: it is not part
  of the readiness checklist, does not move the readiness bar, and never blocks
  generation. A finding now also reports how much of its evidence actually reaches
  report output, and evidence withheld only because the capture it is linked to is
  excluded is badged **Excluded from reports** on every surface — the timeline, the
  evidence detail header, finding cards, and the evidence pickers — instead of
  looking report-bound because its own box is unticked.
- **Backup export.** Reports → Generate gets a **Backup export** card: a full JSON
  data export (every finding, evidence content embedded) for backups and transfers
  between servers, downloaded rather than recorded in report history. It is the only
  output with an **Include evidence excluded from reports** opt-in — off by default.
  When it is on, excluded evidence is exported carrying its flag, so an
  export → import round trip restores both the evidence **and** its exclusion
  instead of losing it. Every other output — the PDF, the ZIP bundle and its
  `SHA256SUMS.txt` / "Files Attached" table, the per-goal and cover counts, the
  preset **Export JSON** deliverable, and this export by default — remains
  incapable of emitting report-excluded evidence. Asking for excluded evidence
  implies embedding content, because metadata without the bytes could not restore
  anything; and a file that carries excluded evidence is stamped with export schema
  version 4, so an older server rejects it outright instead of importing it with the
  exclusion silently stripped.
- **Delete a user from the Admin panel.** Deleting a user is a **hard delete that
  anonymizes rather than destroys**: the account, its sessions, sign-in credentials,
  API keys, and engagement memberships are permanently removed (freeing the email
  address for a new account), but the evidence they captured and the comments they
  wrote are **kept** — evidence is the client deliverable, so it outlives its author
  — and are reattributed to **"Deleted user"** everywhere, including the generated
  report. A pre-flight dialog shows exactly what will be removed and what will be
  kept, with real counts. You cannot delete yourself, and the last admin who can
  sign in can no longer delete, demote, or disable themselves out of the Admin
  panel.
- **Filter and sort the Findings page.** The full facet set: free text (title,
  description, and affected target), severity (including **Unrated**), kind,
  category (including **Uncategorized**), ready-to-report, fix effort, has/has-no
  linked evidence, affected target, and ISO 21434 / UN R155 mapping — each as
  _mapped_ / _not mapped_ plus a searchable list of the refs actually in use.
  Sort by manual order, severity, title, created, **last updated**, evidence
  count, or **linked-goals count**, ascending or descending. Filters live in the
  URL so a filtered view is shareable, removable chips show what is active, and
  drag-to-reorder is disabled (with the reason in a tooltip) whenever a filter or
  a non-manual sort would make reordering write the wrong positions.
- **A finding card counts the strategic recommendations addressing it.** Alongside
  the evidence and linked-goals counts, a finding row now reads
  `… · Evidence (4) · Goals (2) · Recommendations (1)`, where the recommendation
  count is the engagement's strategic recommendations whose **Addresses** list names
  that finding. Goals and recommendations appear only when non-zero, so a card with
  neither stays as short as before, and the Findings list and the finding picker you
  use when linking findings to a goal read identically. The Findings page gains a
  matching has/has-no **strategic recommendation** filter (shareable in the URL,
  with a removable chip) and a **Recommendations** sort key.

### Changed

- **A report never claims a finding has no evidence when it does.** When a
  finding's evidence is filtered out of a report — by a section toggle or by the
  new report exclusion — the report now prints **nothing** instead of
  "No evidence attached.", which would have been a false statement in a signed
  client deliverable. Attack Path steps renumber contiguously, so an omission is
  not advertised by a gap in the numbering.
- **"Linked evidence" now sits directly under "Linked goals"** on the evidence
  detail page, instead of below the Content and Comments sections — grouping the
  two linking panels together near the top.
- **"Delete evidence" moved to a Danger zone.** Deleting a piece of evidence is no
  longer tucked inside the Details **Edit** form — it now lives in its own **Danger
  zone** card at the very bottom of the evidence detail page (red border, red
  heading, description of what's removed), matching the engagement settings Danger
  zone. Deletion still runs through the existing confirmation dialog (which, for an
  item with linked evidence, lets you keep or cascade its children).

### Fixed

- **A derived slug no longer overflows the 64-character limit.** When a slug is
  already taken, the server appends `-2`, `-3`, … — and a base that was already at
  the limit pushed the result past it, producing a slug no form or route would
  accept. The suffix now makes room for itself. This was reachable by importing an
  engagement whose slug was at the limit onto the server it came from, where it
  failed _after_ the engagement had been written.
- **Re-importing a report-filtered export no longer detaches withheld evidence.**
  The deliverable JSON export leaves report-excluded evidence out, and the importer
  reconciled a finding's evidence links to exactly the file's list — so importing a
  deliverable export back into its own engagement silently deleted the finding's
  link to every excluded item, along with the Attack Path bucket, position and
  caption that _are_ the content of a path step, with nothing in the import result
  to hint at it. The export now records whether it was allowed to describe excluded
  evidence (`includesExcludedEvidence`), and a file that was not cannot detach what
  it could not see. A backup export does describe those links, so its removals still
  apply in full.
- **Hyphens can be typed in an engagement slug again.** The new-engagement form
  stripped a hyphen the instant it was typed, so "red-team" could only ever be
  pasted — the slug field ran its finalizing slugifier on every keystroke, and a
  trailing hyphen is an unavoidable waypoint on the way to a valid slug. Typing is
  now lenient and the slug is finalized on blur and again before submit, so nothing
  invalid reaches the server. Separately, slugifying a long name could produce a
  slug ending in a hyphen (the 64-character cap ran _after_ the trailing-hyphen
  strip rather than before it) — a value the slug schema then rejected on read.
- **Dialogs accept more than one keystroke.** In any dialog whose parent owned the
  input's state — **Save query**, **Edit saved query**, and the type-the-slug
  **Delete engagement** confirmation — typing a single character moved focus to the
  dialog's ✕ button, making them effectively unusable. The shared `Modal` primitive
  re-ran its focus effect on every re-render; it now only runs when the dialog
  opens. Initial focus also no longer lands on the ✕: a caller's `autoFocus` is
  honoured, otherwise the first control in the dialog body is focused, and focus
  returns to whatever opened the dialog when it closes. The same fix was applied to
  `Popover`. Both primitives are now covered by regression tests that run against a
  real DOM and fail against the old focus behaviour.

- **The server reported the wrong version to clients.** `/api/checkconnection`
  advertised `0.1.0` while every package manifest said `0.9.0` — the constant was
  a hand-written literal and the version-bump script never knew about it. It is
  now read from the package manifest, so it cannot drift, and a test pins the
  agreement. The bump script also fails loudly instead of silently skipping when
  it cannot find the `reporter-term` version literal or the CHANGELOG heading,
  which is how the drift went unnoticed for eight minors.
- **`@reporter/api-client` now takes the schema's input type when creating
  evidence**, so a server-side field with a default no longer breaks client
  builds. Adding `excludeFromReport` was backward-compatible on the wire yet
  forced edits to both the desktop and terminal apps to pass a value the server
  would have supplied anyway.
- `scripts/verify-api.mjs` sent no `title`, which has been required since
  evidence titles landed, so the HMAC smoke test failed with a 400.

## [0.9.0] - 2026-09-04

### Added

- **Strategic recommendations from a finding** — the finding detail page gains a
  **Strategic recommendations** section where an engagement admin can add a new
  program-level recommendation (auto-linked to the finding) or link an existing
  one, and unlink. These are the same engagement-level R1/R2… recommendations that
  appear in Reports → Content, so the two stay in sync. The finding's own
  **Remediation** field is unchanged — the two are distinct. Reports → Content now
  shows a **coverage** summary at the top of Strategic recommendations ("N/M
  weaknesses have a strategic recommendation") that lists any uncovered weakness
  with a one-click **Add**.
- **Comments on evidence** — a lightweight, plain-text discussion thread on each
  piece of evidence, for internal notes (never shown in the exported report). Any
  writer can post a markdown comment; authors can edit or delete their own (with an
  "edited" marker). The old "Comments (Linked Evidence)" section is renamed to
  **Linked evidence** to end the naming overlap, and the evidence Details / Linked
  goals panels use an explicit **Edit** / **Add to goal** button (each linked goal
  has a **Remove**) instead of the expand-to-edit accordion.
- **Edit evidence content, deliberately** — notes, events, code blocks, and HTTP
  requests can now have their body edited from the evidence detail page. Editing
  is explicit: an **Edit** button unlocks the field and a dedicated **Save**
  persists it (clicking away never saves), keeping the markdown Write/Preview (and
  the HTTP field/value preview). Each item now shows a **"Last edited by &lt;operator&gt;"**
  line, and the detail page's Details / Linked-goals panels moved above the content
  as collapsible sections — collapsed shows the values read-only, expanding lets you
  edit them.
- **Assessment type on the Engagements dashboard** — each engagement's report
  **Assessment type** (e.g. "External Penetration Assessment") now shows on both
  the dashboard cards (as a subtitle under the engagement name) and the table
  view (as a new sortable **Assessment type** column). Engagements with no
  assessment type set simply omit it.
- **"Save your changes?" prompt when closing a form with unsaved edits** —
  closing the Add evidence / New finding forms (Cancel, Esc, or a click outside)
  while the form is complete now offers **Save**, **Discard**, or **Keep
  editing**, so you can always save without hunting for the button — even after a
  long description has scrolled it out of view. Incomplete forms still show the
  simpler Discard / Keep editing confirm.
- **Markdown in the evidence "Content" field** — Add evidence now uses the same
  Write / Preview markdown editor for the **Content** of notes, events, and code
  blocks that Description already used, and those bodies render as markdown both
  in the app and in the exported report.
- **HTTP request field/value preview** — the Add evidence **HTTP data** field has
  a Write / Preview toggle that parses HAR JSON, loose JSON, or a raw HTTP
  request/response into a field/value view: method/URL/status, header, query and
  cookie tables, and request/response bodies rendered as an expandable JSON tree.
- **"Sanitize" report option** — under Assessment Execution in the report
  configurator, **Show timestamps** and **Show operator** (both off by default)
  control whether each evidence item's capture time and operator name appear
  anywhere in the generated report. Saved with the engagement's report config.

### Changed

- **Desktop & terminal apps say "linked evidence", not "comment".** To match the
  web app's renamed **Linked evidence** section, the desktop capture app's
  **Comment on** picker is now **Link to**, and `reporter-term`'s
  `--comment-on <uuid>` flag is renamed to **`--link-to <uuid>`** (the old flag
  keeps working as a hidden, deprecated alias). Upload log lines, retry hints, and
  the client-API docs use "linked evidence" throughout. The underlying
  `parentEvidenceUuid` wire field is unchanged.

### Fixed

- **Modals can no longer grow off the screen** — every dialog now caps its
  height to the viewport, keeps its title bar and action buttons pinned, and
  scrolls its body internally. Previously a tall body (e.g. a long evidence
  description, or its rendered markdown **Preview**) could push the header and
  the Save/Cancel buttons past the top and bottom of the screen with no way to
  scroll back to them.

## [0.8.0] - 2026-08-27

### Added

- **Strategic recommendations now link to findings** — every recommendation must
  be tied to the finding(s) it addresses (a per-row picker shows each finding
  with its severity). In the report, the numbered **Strategic Recommendations**
  table is unchanged, and each finding's Detailed Findings card now also echoes
  its **Related Recommendations** (e.g. "R1 — …"), so guidance always correlates
  with a concrete finding. Recommendations authored before this change keep
  working and simply surface a "Link a finding" prompt until updated.
- **Report readiness checklist** — the Reports → Content tab now shows a
  progress bar and a checklist of every item a report needs before it's ready
  (client name, assessment type, location, scope notes, executive summary,
  methodology, watermark, service scope, strategic recommendations, threat model,
  assessment execution, provider/client contacts, test tools used, and at least
  one finding marked "Ready to report"). Incomplete sections are flagged inline,
  each item jumps to its editor, and any genuinely-irrelevant item can be marked
  **Not applicable**. The Generate tab shows a **"Not ready — N left"** badge and
  asks for confirmation before generating an incomplete report.
- **Live section preview in Report → Configure** — selecting a section now shows
  a sticky, live preview of exactly how that section will render in the report
  (the real output, not a mock-up), refreshing as your edits autosave.

### Changed

- **"3rd-party software used" is now "Test tools used"** (tools, hardware, and
  3rd-party software), everywhere it appears — the Content editor, the report
  section configurator, and the rendered report heading.
- **Report → Configure options simplified** — the "Include all findings" and
  "Include the evidence timeline" checkboxes were removed. Config-driven reports
  always include only "Ready to report" findings, and the Assessment Execution
  timeline is now driven entirely by the timeline subsections authored on the
  Content tab. "Findings grouping" remains.

## [0.7.1] - 2026-08-27

### Added

- **Link an existing piece of evidence as a comment on another** — from an
  evidence's detail view you can now **make it a comment on** another existing
  piece of evidence (a searchable picker lists the engagement's top-level
  evidence by title + timestamp), **move** a comment to a different parent, or
  **detach** it back to standalone. Comments stay one level deep: an item that
  already has its own comments can't itself become one (the action explains why),
  and the same rule is enforced on the server under a row lock so concurrent
  edits can't create a cycle.

## [0.7.0] - 2026-08-26

### Added

- **Compliance attestation letters** — the Reports tab can now produce a short,
  formal **attestation letter** (PDF) that a client can hand to auditors,
  customers, or regulators in support of a compliance framework: **SOC 2,
  HIPAA, PCI DSS, ISO 27001, NIST CSF, GDPR**, or a custom/other framework named
  at download time. The letter is auto-drafted from the engagement (client,
  dates, scope, methodology, provider/client contacts) and a specific generated
  report's findings snapshot, and its "Use of this letter" wording is tailored
  per framework. It is deliberately a **vendor attestation of testing activity**,
  not a certification. The letter is only available **once a report has been
  generated**, since it attests to a specific report.
- **Report history** — every generated report document (PDF or ZIP) is now
  recorded as a versioned entry (`v1.0`, `v2.0`, …) with a snapshot of its
  findings tallies and who generated it, shown on the Reports tab. The
  attestation letter attests to one of these entries so its stated results stay
  consistent with that deliverable even after the engagement's findings change.
- **Re-download past reports** — the exact bytes of every generated report are
  now stored, so any past **PDF, ZIP bundle, or JSON export** can be
  re-downloaded from Report history with a per-entry **Download** button (the
  identical file that was produced, not a re-render). JSON exports are recorded
  in history too; entries generated before this release show as non-downloadable.
- **Reports tab is now a guided set of sub-tabs** — **Content · Configure ·
  Generate & History · Attestation** — so authoring a report is a clear
  walkthrough. All report-content authoring (report details, watermark, service
  scope, strategic recommendations, threat model, assessment execution, client
  and third-party software, and provider/client contacts) now lives on the
  **Content** sub-tab.
- **Attestation letter options** — the letter form now lets you set the
  **Attn:** recipient (name + title) and the **Dear** greeting directly
  (prefilled from the first client contact), and adds a **Show scope
  exclusions** toggle so exclusions can be included in the letter (**off by
  default**). All other details are still pulled from the engagement's content.

### Changed

- **Report content moved from engagement Settings to the Reports tab.** The
  Settings tab now covers only the engagement itself (details, members, tags,
  finding categories); everything report-related is authored under
  **Reports → Content**.

### Fixed

- **Desktop "Comment on" picker is now readable.** When filing a capture as a
  comment on existing evidence, the desktop app's picker listed each item by its
  bare content type (e.g. `(image)`, `(codeblock)`), making it impossible to tell
  which piece of evidence you were commenting on. It now shows each item's
  **title** (falling back to its description, then a friendly type label) plus a
  short timestamp, so items — even a burst of screenshots — are easy to tell apart.

## [0.6.0] - 2026-08-20

### Added

- **Full Markdown in every prose field** — engagement Executive summary, Methodology,
  Scope notes, Threat-model narrative, Execution-narrative bodies, Strategic
  recommendations, custom report sections, finding Description/Impact/Remediation,
  objectives, target descriptions, and evidence descriptions are now Markdown
  editors with a **Write / Preview** toggle. One shared renderer powers both the
  editor preview and the exported PDF, so what you preview is what the report
  prints — headings, lists, **bold**, links, code, and tables all render, and a
  blank line between paragraphs produces real paragraph spacing. (Code / HAR /
  note _content_ fields stay plain — Markdown applies to prose only.)
- **Choose how findings are grouped in the report** — the Reports tab gains a
  **Findings grouping** option: **by severity** (default, unchanged), **by
  category**, or **by affected target**. The Summary of Weaknesses table and the
  Detailed Findings section group under headings accordingly, with W-numbers kept
  consistent across the summary, detail, standards matrix, and table of contents.
- **Proposal import seeds finding categories** — importing a proposal now
  pre-fills the engagement's finding-category list from its own plan (the
  non-retest goal titles plus the activity categories), so classifying a finding
  is picking from your scope rather than free-typing.

### Changed

- **Finding categories are now per-engagement** — categories belong to the
  engagement that owns them (managed under Settings → Finding categories) instead
  of a single global pool shared across every engagement. Existing categories in
  use are migrated to the engagements whose findings reference them; the global
  Admin → Finding categories tab is removed. Tags stay the evidence-organization
  tool; categories are the report's per-engagement weakness taxonomy.
- **One canonical logo everywhere** — the web app, its favicon, and the desktop
  app now render the same SVG reporter mark from the design system, replacing the
  low-resolution screenshot images that were standing in for the logo.

### Fixed

- **Proposal import now populates the Service scope** — importing a proposal fills
  the structured **Service scope** section in Settings (each target with its
  in-scope subsystems), matching the detail it already imported into Goals. It
  was previously left empty ("No targets yet").

### Added

- **Assessment Execution timeline subsections** — the Assessment Execution card in
  engagement Settings now offers two kinds of subsection: the existing hand-authored
  **narrative** (title + prose + embedded evidence) and a new **activity timeline**
  that renders the engagement's captured evidence, filtered by **tag** and/or
  **type**, **grouped** (chronological / by tag / by type), with toggles to
  **include follow-up comments** and show **only starred** items. "Add subsection"
  splits into **Add narrative** / **Add timeline**.
- **Save a search as a saved query** — the Evidence tab's filter bar gains a
  **Save query** action that stores the current filter as a saved query. The
  **Saved queries** tab is now purely for managing them: **run**, **edit**
  (rename/modify), and **delete** — its old "Save a query" form is removed.
- **Expandable report sections with sub-item toggles** — on the Reports tab, click
  a section to expand it, preview a **sample** of what it renders, and
  **include/exclude individual pieces** within it (e.g. Executive Summary's scope,
  severity distribution, or key stats; Detailed Findings' impact, standards,
  remediation, attack path, or attached evidence; and more).
- **Create tags inline when adding evidence in the web app** — the web "Add
  evidence" dialog now has the **+ New tag** affordance already present in the
  desktop app, the evidence detail view, and the terminal recorder.

### Fixed

- **Report watermark no longer clips at the page edge** — the diagonal watermark
  now scales its font size to the text length so the whole word fits on the page,
  and the watermark text is capped at 32 characters.

### Added

- **Engagement Goals** — a new **Goals** tab that structures an engagement as a
  **Target → Activity → Goal** tree (systems/devices under scope, their testing
  activities, and the areas-of-interest/objectives under each). Goals carry a
  **status** (Not started / In progress / Complete / N/A) and roll up into a live
  **engagement progress** percentage shown on the Goals tab and the engagements
  list. Each activity gets an auto-created **tag** so evidence captured under it
  correlates back to the goal it advances, and goals can be **linked directly to
  evidence and findings** (with those links surfaced on the evidence and finding
  detail pages). Activities with no imported objectives can have **sub-items
  added** by hand.
- **Import a proposal JSON when creating an engagement** — the "New engagement"
  flow accepts the JSON exported by the proposal-generation tool and builds the
  goals tree from its **scope** section (devices → interfaces → sub-items), a
  1-to-1 translation from proposal to engagement. Sub-items carried over from a
  prior report (e.g. `W1-…`) are auto-flagged as **retests**. Engagement metadata
  (client, assessment type, approach, objectives narrative, scope, contacts,
  start date, exclusions) is applied from the proposal, and the raw JSON is kept
  for provenance.
- **Reports section** — export moves out of Findings into its own **Reports** tab
  where you compose the report: **enable/disable and drag-reorder** every section,
  add **free-text custom sections**, and set options (include-all-findings,
  evidence timeline + grouping). A new **Scope & Objectives Coverage** section can
  render the goals tree (per-target activity/goal coverage with status and linked
  findings/evidence counts). The default configuration reproduces the previous
  report exactly.
- **Report types** — the Reports tab offers one-click **Full report**,
  **Executive summary**, **Findings only**, and **Custom** (your configured
  sections) downloads (PDF / ZIP / JSON).

### Changed

- **Exported report filenames now include the report type and a to-the-second
  timestamp** (e.g. `acme-executive-summary-2026-08-20-143052.pdf`), so different
  report types — and repeated exports on the same day — no longer overwrite each
  other.

### Migration

- Adds the `engagement_targets`, `target_activities`, `activity_goals`,
  `goal_evidence`, and `goal_findings` tables and the `GoalStatus` enum, plus
  `engagements.test_approach`, `objectives_narrative`, `report_config`, and
  `proposal_import`. Purely additive — existing data is untouched and an
  unconfigured engagement's report is byte-for-byte unchanged.

## [0.4.0] - 2026-08-19

### Added

- **Evidence now has a Title** (a short, required label) distinct from its
  **Description** (longer prose). The "Add evidence" modal, the desktop capture
  window, and the `reporter-term` recorder all now ask for both — Title is
  required (`reporter-term` gains a `--title` flag for its `upload` command).
- **Unsaved-changes handling across the app.** Edit-in-place detail pages
  (**evidence**, **finding**, and **engagement settings**) now **autosave** as you
  type — debounced, with a **"Saved"** breadcrumb toast and a live
  _Unsaved / Saving… / Saved_ status — and block the save with an inline error
  while a required field (e.g. a blank title) is invalid. The create forms that
  have nothing to autosave yet (**Add evidence**, **Add finding**, and the desktop
  capture window) instead prompt **"Discard changes?"** when you try to leave a
  dirty form, backed by a `beforeunload` guard for tab-close/reload.

### Changed

- Evidence is now shown by its **Title** everywhere it's listed — the timeline,
  finding evidence cards, and the evidence picker — with a **snippet of the
  description** underneath; the full **content** (screenshot, code block, terminal
  recording, HAR, note body) is shown only on the **evidence detail** view. The
  exported PDF report and evidence log likewise key off the title, with the
  description as subtext.
- The findings JSON export is now **schema version 3** (evidence carries its
  `title`). Older v1/v2 exports still import cleanly (title defaults to empty).

### Migration

- Adds `evidence.title`. Existing evidence is migrated by copying its old
  `description` into the new `title`, then clearing `description` — so the former
  single label becomes the title and the description starts empty.

## [0.3.0] - 2026-08-19

### Added

- **Client-ready report, greatly expanded.** The exported PDF now follows a full
  professional pentest-report structure, all reusing the existing house style:
  - **Front matter** gained per-engagement **provider contacts** and **client
    contacts** (name / title / email) on the Engagement Details page.
  - **Executive Summary** gained a structured **Service Scope** (targets →
    subsystems) and **Scope Exclusions**.
  - A new **Assessment Findings** section with a **Summary of Strengths** table, a
    **Summary of Weaknesses** table (now with a **Fix effort** column), a
    **Strategic Recommendations** table, the category breakdown, and a **Standards
    Traceability** matrix. Findings/strengths/recommendations are cross-referenced
    as `W#` / `S#` / `R#`.
  - A new **Threat Model** section (narrative + uploadable diagram images).
  - **Assessment Execution** is now a hand-authored, titled **narrative** (group
    the walkthrough by interface/topic, with evidence embedded per subsection) —
    shown by default; the auto evidence **timeline** is now an optional add-on.
  - Detailed findings gained **Affected target**, **Impact** (distinct from the
    description), **Fix effort**, and **Standards Mapping**.
  - A new **Supporting Information** section: **Client Software Tested**,
    **3rd-Party Software Used**, and an auto-generated **Files Attached** table
    (non-screenshot evidence) with **SHA-256** hashes.
  - Every one of these is editable in **Engagement Settings** (like the executive
    summary), and round-trips through the findings JSON export/import.
- **Findings can be a Strength or a Weakness.** A finding now has a **kind**
  (default _weakness_) selectable when creating a finding and in the finding
  editor. Strengths appear only in the Summary of Strengths table; the server
  clears severity/CVSS/fix-effort/impact/remediation on a strength so it can never
  enter the weaknesses dashboard/tables.
- **Standards mapping (ISO/SAE 21434 & UN R155).** Each finding can be mapped to
  one or more ISO/SAE 21434 work products (including TARA entries) and UN R155
  requirements from a built-in catalog, shown per-finding and in the report's
  traceability matrix.
- **ZIP report bundle.** Alongside the PDF, the Export dialog can produce a **ZIP**
  containing the report plus all supporting files (terminal recordings, HTTP
  cycles, uploaded files — not screenshots, which are embedded) and a
  `SHA256SUMS.txt`. New `GET /web/engagements/:slug/findings/report.zip`.
- **Finding category is now a dropdown** of the engagement's existing categories,
  with inline "add new category" — in the New-finding modal and the finding editor.
- **Evidence records its original filename + content hash.** Uploads now persist
  the original filename (web, client API, desktop, `reporter-term`) and a SHA-256 +
  byte size of the stored blob, used to name and verify files in the report bundle.

### Changed

- **Report export options.** The Export dialog now offers **PDF** or **ZIP
  bundle**, and the Assessment Execution narrative is included by default with the
  evidence timeline as an opt-in toggle. `report.pdf`/`report.zip` accept
  `includeNarrative` and `includeTimeline` query params. The findings export schema
  is now `v2` (older `v1` exports still import).

### Fixed

- **Release binaries now attach to the GitHub Release.** The `Release` workflow
  built the installers but only stored them as ephemeral workflow-run artifacts;
  it now attaches the `.dmg` / `.exe` / `.AppImage` / `.tar.gz` / `.deb` and the
  `reporter-term` `.tgz` to the tag's Release via `softprops/action-gh-release`,
  adds `permissions: contents: write`, and fails loudly (`if-no-files-found:
error`) if a build produced nothing.
- **Desktop Linux is no longer Ubuntu/Debian-only.** The Linux build now also
  ships a distro-agnostic **`tar.gz`** (extract-and-run, no package manager or
  FUSE required — works on Arch and any distro) alongside the AppImage and `.deb`.
- **`reporter-term` releases install with npm again.** The release now attaches the
  raw `reporter-term-<version>.tgz` (a valid npm gztar) as a Release asset, instead
  of only the double-zipped workflow artifact that `npm install` rejected.

## [0.2.0] - 2026-08-19

### Removed

- **Finding "Ticket Link" field.** Removed the finding ticket-link field
  everywhere (schema, API, export/import, and the PDF report). Old export files
  that still carry a `ticketLink` key import cleanly — the key is ignored.

### Added

- **Block Harbor house-style report PDF.** The exported findings report was
  rebuilt into a client-ready, on-brand document: a dark **cover page** (logo /
  wordmark, assessment type, client, prepared-by, assessment window, status), an
  **Engagement Details** page, a **Table of Contents**, an **Executive Summary
  dashboard** (severity distribution bar + per-severity count cards, a key-stats
  strip, a findings-at-a-glance table, and a category breakdown), a
  **Methodology & Approach** section, **detailed Findings** (severity-ordered,
  each with description, remediation, CVSS, attack path and evidence), an
  **Assessment Execution** evidence timeline (groupable chronologically, by tag,
  or by type), and a **Severity & CVSS Reference** appendix — with a running
  header/footer and "PAGE N OF M" page numbers. The `report.pdf` route accepts
  `evidenceGroup`, `includeTimeline`, and `includeAppendix` query params; the
  Export dialog surfaces the grouping and timeline options.
- **Report metadata on engagements.** Engagements gained optional **Client /
  organization name**, **Assessment type**, **Location**, **Scope**, **Executive
  summary**, and **Methodology** fields, plus per-finding **Remediation** — all
  editable in Engagement Settings / the finding editor and rendered in the
  report. Round-trips through the findings JSON export/import.
- **Per-engagement report watermark.** A configurable watermark is drawn on
  every page of the exported PDF except the cover — defaulting to
  **CONFIDENTIAL**. Engagement Settings lets you set the text, color,
  transparency (light / medium / strong), and placement (under or above the
  content), and toggle it off.
- **Admin → Report branding.** A new Admin tab sets the site-wide report
  organization name, accent color, cover logo (uploaded inline), and footer
  note (defaulting to the Block Harbor house style). New admin-only
  `GET`/`PUT /web/admin/report-settings`.
- **Inline tag creation.** Tags can now be created directly from the tag picker
  while working — in the web evidence editor, the desktop capture composer, and
  the `reporter-term` post-recording prompt — instead of only in Settings. New
  desktop `tags:create` IPC channel.
- **Tag delete warning.** Deleting a tag now reports how many pieces of evidence
  carry it and warns more strongly when it is in use (the tags list response
  includes a `usageCount`).
- **Engagement list: dates & default filter.** The Table view gained sortable
  **Started** and **End** columns (so no dates are lost switching from Cards),
  and the status filter now defaults to **active** so completed/archived
  engagements only appear when explicitly selected.
- **Product mark.** The teal reporter icon is now the web favicon and replaces
  the "reporter" wordmark in the desktop app's navigation.
- **Admin → Engagements console.** A new fourth tab in the Admin area lists
  every engagement on the server — any status, member or not — with member /
  evidence / finding counts and the created date, a name/slug text filter plus a
  status filter, and sortable columns. Each row links to the engagement and to
  its settings (site admins can manage any engagement's settings), can be
  deleted in place after a cascade warning, and engagements the admin isn't a
  member of are marked "not a member". New admin-only
  `GET /web/admin/engagements`.
- **Admin user tools: recovery links, API-key control & TOTP reset.** The
  Admin → Users tab gains per-user actions: **Recovery link** issues the
  (previously API-only) one-time, 24-hour sign-in link and shows it in a modal
  with copy-to-clipboard — and the link now works end to end via the new
  `/login/recovery/:code` page and `POST /web/login/recovery` (single-use,
  redeemed atomically, rate-limited like login). Redeeming a link flags the
  account (`mustResetPassword`) so the user can set a new password once without
  knowing the current one — Account → Security adapts accordingly; **API keys**
  lists a user's client API keys (access key, last used, created — never the
  secret) with per-key revocation; **Reset TOTP** clears a user's enrolled TOTP
  secret (TOTP login enforcement is not yet enabled; only shown for users with
  TOTP enrolled — the admin users list now reports `hasTotp`). New admin-only
  `POST /web/admin/users/:slug/totp-reset` and
  `GET`/`DELETE /web/admin/users/:slug/api-keys[/:accessKey]`.
- **Evidence starring & new timeline filters.** Evidence can now be starred
  per-user (like engagement favorites) straight from the timeline rows — the
  star never navigates, and read-only members can star too. The timeline filter
  bar gains a **Starred only** checkbox and a **Hide comments** checkbox that
  hides evidence linked as comments on other evidence; both surface as removable
  chips, work in saved queries, and round-trip through the Advanced raw-query
  mode via the new `starred` / `no-comments` query keys. The evidence API now
  returns `starred`, and the web API adds
  `POST /web/engagements/:slug/evidence/:uuid/star`.
- **Engagements list: filtering, favorites pinning & sortable table.** The
  engagements page gains a filter bar (free-text match on name/slug plus a
  status filter) that applies to both the card and table views, with a
  clear-filters empty state when nothing matches. Starred engagements are always
  pinned to the top of both views, and the table's Name / Status / Evidence /
  Findings / Members columns are click-to-sort (text columns start ascending,
  numeric columns start with the largest counts). New `SortableTh` primitive in
  `@reporter/ui` for accessible sortable table headers.
- **Engagement lifecycle dates.** Engagements now track a **start date** (set to
  creation time, editable), a user-entered **projected end date**, and an
  **actual end date** the server stamps automatically whenever an engagement moves
  into _Complete_/_Archived_ (and clears on a return to _Active_); all three are
  editable in **Settings → Details**, a projected end can be set when creating an
  engagement, and the dates appear on the engagement header and cards. The desktop
  app and `reporter-term` show each engagement's status in their engagement
  pickers. The engagement API returns `startedAt`, `projectedEndAt`, and
  `actualEndAt`.
- **Delete an engagement.** Engagement (and site) admins can now delete an
  engagement from its **Settings → Danger zone**. Deletion is guarded by a
  type-the-slug confirmation and permanently removes the engagement and all of
  its evidence (blobs included), findings, tags, saved queries, and members. New
  admin-only `DELETE /web/engagements/:slug`.
- **Engagements list: card / table views and finding counts.** The engagements
  page now toggles between the existing **card** view and a compact **table**
  view (the choice is remembered per browser). Both views, and the engagement
  header, show a finding count alongside the evidence count — shown only when the
  engagement has at least one finding. The engagement API now returns
  `numFindings`.
- **Engagement-scoped finding categories.** Finding categories can now be listed
  and managed from within an engagement (not just the admin console): any member
  can list them to populate a dropdown, engagement writers can create/revive one,
  and engagement admins can soft-delete one.
- **Evidence comments (linked evidence).** Any piece of evidence can now carry
  **comments** — themselves full evidence (screenshot, note, code block, HTTP
  request, terminal recording, …) linked to a parent piece of evidence, for
  tracking follow-ups/updates and cross-linking related captures. Add one from an
  evidence's detail page (the same Add-evidence form), from `reporter-term` with
  `--comment-on <uuid>`, or from the desktop compose form's **Comment on** picker.
  Comments are real evidence: they appear on the timeline with a link indicator to
  their parent, and a parent shows its comment count. Deleting evidence that has
  comments asks whether to delete them too or keep them as top-level evidence.
- **Findings: Attack Path & captioned evidence.** A finding's evidence is now
  split into two persisted buckets — an ordered, numbered **Attack Path** (each
  step carries an optional caption describing that step of the attack) and plain
  **Attached Evidence**. Attach evidence into either bucket, move links between
  buckets, and reorder within a bucket; positions are tracked per bucket. The
  PDF report renders the Attack Path as numbered steps with captions and lists
  Attached Evidence separately (the Attack Path section is omitted when empty),
  and both the JSON export and import preserve each link's caption and bucket.
- **Findings: severity, ordering, deletion, and report export.**
  - **CVSS v3.1 severity.** Findings carry a severity on the CVSS v3.1 scale
    (None → Critical). Rate one with the built-in **CVSS v3.1 calculator**
    (eight base metrics → live score, vector, and severity) or pick a severity
    directly from a simple dropdown. The server derives the score and label from
    the vector, so the number can never drift from the vector. A colored
    `SeverityBadge` shows the rating on the list and detail views.
  - **Reorder findings** by drag-and-drop; **reorder the evidence** attached to a
    finding the same way. The manual order drives the list, the PDF, and the JSON
    export. New findings/evidence append to the end.
  - **Delete a finding** from the list row or the detail view (with a confirm
    dialog). Deleting a finding detaches its evidence but never deletes the
    evidence itself.
  - **Export** the findings for an engagement: a one-click **PDF** report
    (rendered server-side with headless Chromium, evidence embedded) and a
    portable **JSON** export. Both default to report-ready findings, with toggles
    to include all findings and to embed evidence content in the JSON.
  - **Import** a findings JSON export into an engagement. Findings are upserted by
    uuid (re-importing the same file is idempotent); embedded evidence is
    recreated with its original uuid, existing evidence is re-linked, and
    reference-only evidence with no local copy is skipped. The import reports how
    many findings/evidence were created, updated, linked, or skipped.
- Desktop **About** view — open it from the tray (_About reporter_) or the window
  nav. It shows the app version, the build's git commit and date, Electron /
  Chromium / Node / V8 versions, the platform, the configured server URL, and a
  **Check for updates** button that compares against the latest GitHub release.
- Build-time version metadata is stamped into the desktop bundle (version, commit,
  build date) so a running app can always report exactly which build it is.
- Repo-wide version tooling: `pnpm run version:bump` keeps every workspace, the
  `reporter-term` CLI banner, and this changelog in lockstep, and can tag the
  release (`--commit`) to trigger the release workflow.

### Changed

- **Read-only members see disabled controls instead of 403 errors.** When your
  role on an engagement is read-only, every mutating control on its web pages —
  add/edit/delete evidence, comments, findings (incl. import, attach/detach,
  captions, and drag reordering), saved queries, tags, and categories — now
  renders greyed out with an explanatory tooltip instead of failing with a
  permission error on click; admin-only Settings controls (details, members) do
  the same for non-admin members. Site admins keep full controls on any
  engagement, read-oriented actions (filters, starring, favorites, export
  downloads) stay enabled for everyone, and the server still enforces every
  rule.
- **The Engagements page is membership-scoped for everyone.** Site admins no
  longer see every engagement on the main Engagements page — it now lists only
  the engagements they are a member of, matching its "Engagements you can
  access" subtitle. The new **Admin → Engagements** tab is the all-engagements
  surface. (Server-side, `GET /web/engagements` no longer special-cases
  admins; the client API `GET /api/engagements` still returns everything for
  admins so capture tools keep working.)
- **Renamed the core "Operation" concept to "Engagement"** across the entire
  stack — the term red-teamers use for a scoped piece of work. This is a breaking
  change with no automatic data migration:
  - **Database:** tables `operations` → `engagements`, `user_operation_roles` →
    `user_engagement_roles`, `user_operation_prefs` → `user_engagement_prefs`;
    every `operation_id` column → `engagement_id`; enums `OperationStatus` →
    `EngagementStatus` and `OperationRole` → `EngagementRole`. The `init`
    migration was regenerated with the new names (the `operator`/`operator_id`
    columns are unchanged — an operator is still the person who captures evidence).
  - **Client API & web API:** `/api/operations*` → `/api/engagements*` and
    `/web/operations*` → `/web/engagements*`; the `@reporter/api-client`
    `listOperations()` method → `listEngagements()`.
  - **Web UI:** routes `/operations/:slug/…` → `/engagements/:slug/…`; all
    navigation, headings, and copy now say "Engagement(s)".
  - **Desktop & terminal recorder:** engagement pickers, menus, and the persisted
    current-engagement setting.
  - **Shared:** zod schemas/enums/types renamed to the `Engagement*` forms.
- **Engagement settings → Members** is cleaner: add a member by typing their
  account **email** and picking a role (Read / Write / Admin), instead of hunting
  for their URL "user slug". The member list now shows each person's name and
  email. Server-side, `POST /web/engagements/:slug/users` takes `{ email, role }`
  (validated by the new `addEngagementMemberInput` schema) and resolves the
  account case-insensitively.
- The login rate limit is now tunable via `LOGIN_RATE_LIMIT_MAX` (default `10`
  per minute).

### Fixed

- **No more sideways scrolling / cut-off content.** Wide evidence (long code
  blocks, HTTP/HAR JSON, long note text) used to stretch the evidence detail page
  past the viewport, pushing the metadata/edit sidebar off-screen and forcing a
  horizontal scroll. Wide content now scrolls inside its own box while the page
  layout stays put; the affected two-column grids and code viewers were fixed and
  the app shell has a horizontal-overflow guard so no view can scroll sideways.
- **Note and event evidence now show their full body.** Creating a note or event
  with body text stored the text but the detail view only showed the short
  description. The detail view now renders the description as a caption above the
  full body; a description-only note shows its text directly.
- **CI and release workflows install pnpm again.** `pnpm/action-setup@v4` began
  failing when both the action's `version` input and package.json's
  `packageManager` field are set (every CI run since Aug 14 died in setup, before
  any code ran). The workflows now omit the redundant `version` input and let the
  action read `packageManager`.
- **`docker compose build` for the server image no longer fails compiling
  `node-pty`.** The desktop app's `dbus-next` dependency pulls in an optional
  `usocket`, which pinned `node-gyp@7.1.2` into the lockfile. That old node-gyp
  got hoisted and used to build `node-pty` (needed only by `reporter-term`)
  during the server image's `pnpm install`, and it can't compile against Node
  22.2x (`gyp ERR! Cannot assign to read only property 'cflags'` — Node 22
  froze `process.config`). Added a pnpm override pinning `node-gyp` to `^11`
  (the current maintained major), which collapses the toolchain to one
  Node-22-capable node-gyp, drops the 7.1.2 subtree from the lockfile, and
  sheds the legacy transitives node-gyp 7/9 dragged in. Node stays at 22 and
  the terminal recorder still builds/loads `node-pty`.
- **Sign out reliably returns to the login screen.** Signing out could leave the
  user on the app with a "Couldn't load your engagements" error instead of the
  login page, because protected queries refetched (and 401'd) before the auth
  state cleared. Logout now pins the unauthenticated state synchronously so the
  app redirects straight to `/login`, drops all cached data, and can no longer
  reach protected pages — even if the logout request itself fails.
- **Desktop capture now works on modern GNOME/Wayland (and fails loudly, never
  silently).** On Wayland — the default on Ubuntu 24.04+ — capturing an area
  brought up the selection overlay but then produced **no comment window** and
  sometimes an **all-black screenshot**. Root cause: `gnome-screenshot` lost
  access to GNOME Shell's screenshot API in GNOME 49 (Ubuntu 25.10 / 26.04) and no
  longer writes a file on Wayland, and the app treated the missing file as a silent
  "cancelled". Capture now goes through the **XDG desktop portal**
  (`org.freedesktop.portal.Screenshot`, interactive) on Wayland, which shows the
  desktop's native area/window/screen picker, captures real compositor output (no
  more black frames), and returns the cropped image — working across GNOME, KDE,
  and wlroots. It falls back to CLI tools (`gnome-screenshot`, `spectacle`,
  `grim`+`slurp`, `maim`, `scrot`, `import`) on X11 or when no portal is available,
  and now **surfaces a clear error toast** (with the tool's message) instead of
  doing nothing when capture genuinely fails. The reporter window is also hidden
  before capture so it can't occlude the shot or be captured itself. The `.deb`
  now **depends on `xdg-desktop-portal`** (plus `gnome-screenshot` for X11).
- **Global hotkeys under Wayland are now explained.** Electron global shortcuts
  don't fire on Wayland; Settings now says so and points to the tray menu or
  binding a system shortcut to `reporter --capture-area` / `--capture-window`.
- **Desktop app now runs on Linux VMs / headless boxes.** On Linux the Chromium
  GPU process often fails to initialize on machines without a real GPU (`Exiting
GPU process due to errors during initialization`), which could leave the capture
  window blank. GPU acceleration is now disabled on Linux (the tray + form UI
  doesn't need it); set `REPORTER_ENABLE_GPU=1` to force it back on.
- **Desktop Linux executable is now `reporter`** (was `@reporterdesktop`, derived
  from the scoped package name) — fixes the `reporter` launch command, the `.deb`
  `/usr/bin/reporter` symlink, and the `.desktop` icon lookup.
- **Desktop `.deb` no longer needs a manual `chmod 4755` on Ubuntu 23.10+/24.04+
  /26.04.** A custom `postinst` always makes `chrome-sandbox` SUID root; the stock
  one skipped it because its user-namespace probe runs as root (who can always use
  userns) while the unprivileged user is blocked by AppArmor, so Chromium's
  sandbox aborted at launch. (AppImage can't set SUID; run it with userns enabled
  or `--no-sandbox`.)
- **`reporter-term` no longer crashes with `Error: posix_spawnp failed.` on a
  fresh `npm i -g`.** node-pty starts a session by `posix_spawn`-ing its prebuilt
  `spawn-helper` binary; some installs land that binary without its executable
  bit, so the very first recording aborts before the shell starts. The recorder
  now restores `+x` on `spawn-helper` (macOS/Linux) right before spawning, so
  recording works regardless of how node-pty was unpacked. No-op on Windows
  (ConPTY has no helper). When it _can't_ self-heal — e.g. a `sudo npm install`
  left the files owned by root — it no longer dumps a raw stack trace but prints
  an actionable message telling you to `chmod +x` the helper (with `sudo` when
  it's root-owned) or reinstall without sudo.

## [0.1.0] - 2026-08-14

### Added

- Initial release: Fastify + PostgreSQL evidence server with web reporting UI,
  the Electron desktop capture app, and the `reporter-term` terminal recorder,
  all sharing `@reporter/shared`, `@reporter/api-client`, and `@reporter/ui`.
