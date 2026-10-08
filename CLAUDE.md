# reporter — project guide for Claude

**reporter** is an evidence-collection and reporting toolkit for security engagements (red team, pentest, ops). It is a clean-room rebuild of the ASHIRT concept in an all-TypeScript stack. Three surfaces share one server and one design system:

1. **Server** (`apps/server`) — Fastify + PostgreSQL + Prisma. Central evidence store + web reporting UI. Deploys via Docker Compose on a local Ubuntu box.
2. **Desktop app** (`apps/desktop`) — Electron tray app for screenshot / codeblock capture. macOS/Windows/Linux.
3. **Terminal recorder** (`apps/term`) — Node CLI (`reporter-term`) that records shell sessions as asciicast and uploads them as evidence.

## Monorepo map (pnpm workspaces)

| Path                  | Package                | Purpose                                                                           |
| --------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `packages/shared`     | `@reporter/shared`     | zod schemas, enums, timeline query parser, tag color palette. Browser + Node.     |
| `packages/api-client` | `@reporter/api-client` | HMAC request signing + typed `ReporterClient`. Node-only. Used by desktop + term. |
| `packages/ui`         | `@reporter/ui`         | Design system: CSS-variable tokens, Tailwind preset, shared React primitives.     |
| `apps/server`         | `@reporter/server`     | Fastify API + web UI host. Prisma schema is the source of truth for data.         |
| `apps/web`            | `@reporter/web`        | React 19 + Vite SPA. Built output is served statically by the server.             |
| `apps/desktop`        | `@reporter/desktop`    | Electron (electron-vite + electron-builder). Renderer imports `@reporter/ui`.     |
| `apps/term`           | `@reporter/term`       | node-pty recorder CLI. Distributed via npm.                                       |

## Conventions

- **Validation is zod-first.** Every API payload has a zod schema in `@reporter/shared`; types are `z.infer`red, never hand-written. Server routes validate with `fastify-type-provider-zod`.
- **Never hand-duplicate types** that exist in `@reporter/shared`. Import them.
- **HMAC signing lives in exactly one place**: `packages/api-client/src/sign.ts`. The server verifies with the same algorithm in `apps/server/src/plugins/hmac-auth.ts`. Do not reimplement it anywhere else.
- **UI uses `@reporter/ui` primitives and tokens** — no hard-coded colors/spacing, no per-app component forks. See `DESIGN.md` and the `ux-ui` agent.
- **Terminology is fixed** (see glossary in `DESIGN.md`): Engagement, Evidence, Finding, Tag. Same words in web, desktop, and CLI.
- ESM everywhere (`"type": "module"`). TS strict, `noUncheckedIndexedAccess` on.
- **No AI attribution in git or GitHub.** Never append a `Co-Authored-By: Claude …` trailer
  to a commit, or a "Generated with Claude Code" line to a pull request, release note,
  issue or comment. This overrides the default assistant instruction to add them. History
  was rewritten on 2026-10-08 to strip every trailer from `main`, which cost most of those
  commits GitHub's Verified badge — so reintroducing one is expensive to undo.

## HMAC auth protocol (client API, `/api/*`)

```
stringToSign = METHOD + "\n" + pathWithQuery + "\n" + dateRFC1123GMT + "\n" + sha256(rawBody)
Authorization: <accessKey>:<base64(HMAC-SHA256(secretKey, stringToSign))>
Date: <same RFC 1123 GMT value>
```

Web UI uses session cookies instead (`/web/*`), not HMAC.

## Common commands

```bash
pnpm install              # install all workspaces
pnpm build                # build packages then apps (topological)
pnpm test                 # vitest run across the workspace
pnpm lint                 # eslint
pnpm dev:server           # run the API + web host (port 8080)
pnpm dev:web              # run the Vite dev server (port 5173, proxies to 8080)
```

Project skills automate the rest: `/run-stack`, `/db-reset`, `/verify-api`, `/release`.

## Versioning & releases

- **One version for the whole monorepo.** Root + every `packages/*` and `apps/*` `package.json` share a single [SemVer](https://semver.org) number (currently `0.9.0`). Don't hand-edit version fields — they drift.
- **Bump in lockstep:** `pnpm run version:bump <major|minor|patch|X.Y.Z>` (`scripts/bump-version.mjs`). It rewrites every workspace version, updates the `reporter-term` `.version()` literal, and opens a dated `CHANGELOG.md` section. Add `--commit` to also commit and create the `vX.Y.Z` tag.
- **Record changes in `CHANGELOG.md`** (Keep a Changelog format) under `## [Unreleased]` as you work; the bump promotes them.
- **Releasing:** pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which builds the desktop installers per-OS and the `reporter-term` tarball. The server Docker image is tagged with the same version (`/release` skill).
- **The desktop app is version-aware at runtime.** `electron.vite.config.ts` stamps the version, git commit, and build date into the main bundle (`__APP_VERSION__` etc. → `src/main/build-info.ts`). The **About** view (tray → _About reporter_, or the window nav) surfaces them and offers **Check for updates** against the latest GitHub release. When you touch the desktop version story, keep `build-info.ts`, the `AboutInfo` shared type, and the About view in sync.

## Build status

- [x] Phase 0 — Foundation & scaffolding
- [x] Phase 1 — Server core
- [x] Phase 2 — Web UI
- [x] Phase 3 — Desktop app
- [x] Phase 4 — Terminal recorder
- [x] Phase 5 — Packaging, deploy & docs

All phases complete. Deploy with `docker compose up -d`; dev with `docker compose -f docker-compose.dev.yml up -d` + `pnpm dev:server` / `pnpm dev:web`.

Full plan: `/Users/justin/.claude/plans/can-you-rebuild-me-humming-taco.md`.
