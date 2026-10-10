# @reporter/web — component guide

React 19 + Vite 7 SPA. Built output is served by the server at `/`. Talks to `/web/*` with the session cookie (no HMAC). Built entirely from `@reporter/ui`.

## Rules

- Compose from `@reporter/ui`; never hard-code colors/spacing. Follow `DESIGN.md`.
- Data via TanStack Query v5; one `fetch` wrapper adds `X-Requested-With` and parses JSON errors. Invalidate by engagement slug after mutations.
- Types from `@reporter/shared`. Routing: react-router v7 library mode.
- Every view has loading + empty (with next action) + error states, in light and dark; list views add _no results match your filters_ with Clear all. Filter/sort bars follow the three convergence rules in `DESIGN.md` → Filter & sort bars.

## Pages (target)

`/login` (+TOTP), `/setup`, `/login/recovery/:code` · `/engagements` · `/engagements/:slug/evidence` (timeline + create-evidence + renderers) · `.../goals` (Target → Activity → Goal tree, objectives narrative, proposal import, goal progress + evidence/finding links) · `/engagements/:slug/findings[/:uuid]` · `.../reports` (report section config + PDF/ZIP/JSON generation) · `.../queries` · `.../settings` (details, members, tag management — `.../tags` redirects here) · `.../audit-log` (the engagement's Audit log tab; writers and admins, hidden from read-only members once the role is known) · `/admin?tab={users,default-tags,engagements,branding,report-templates,audit-log}` (the site-wide Audit log tab carries the tamper-evident removal) · `/account/{profile,security,api-keys}`.

## Evidence renderers

`ImageViewer`, `CodeblockViewer` (CodeMirror 6), `TerminalPlayer` (asciinema-player v3), `HarViewer`, `EventViewer`, `NoteViewer`, with shared `EvidenceMeta`.

## Tailwind

`@import '@reporter/ui/theme.css';` and add `@source` for both this app's `src` and `../../packages/ui/src` so shared component classes are scanned.

## Verify

`pnpm dev:web` with the server running; walk each view in both themes; hand milestones to the `ux-ui` agent.
