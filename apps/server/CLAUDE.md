# @reporter/server — component guide

Fastify 5 + Prisma 6 + PostgreSQL. Hosts the client API (`/api/*`, HMAC), the web API (`/web/*`, session cookie), and serves the built web SPA statically.

## Layout (target)

```
src/
  index.ts            boot: read config → buildApp → listen
  app.ts              buildApp(): plugins + routes, no side effects (tests use fastify.inject);
                      wraps Prisma in the audit backstop and asserts the audit guard trigger at boot
  config.ts           zod-parsed env, fail-fast
  auth/               guards.ts (session + HMAC guards, role checks), session.ts, password.ts
  audit/              context.ts (per-request store, withIntent/withImporter), extension.ts (the
                      backstop Prisma extension), models.ts (per-model specs + redaction), diff.ts
  routes/web/*        auth, engagements, evidence, findings, goals, tags, queries, report,
                      engagement-transfer, admin, account, audit (session cookie)
  routes/api/*        client API (checkconnection, engagements, evidence, tags) — HMAC
  services/*          evidence, findings-report, report-history, engagement-export/-import,
                      findings-import, tags, goals, audit (the writer), audit-query (the reader), …
  blobstore/          ContentStore implementations (local disk, S3)
  helpers/            timeline-filter.ts, pagination.ts, slug.ts, zip-read.ts, multipart.ts
prisma/
  schema.prisma       source of truth for the data model
  migrations/         the audit_entries guard trigger lives ONLY here (no `db push`)
  seed.ts             dev/demo seed (admin, operator, tags, demo engagement + evidence)
```

## Rules

- Prisma schema first, then `prisma migrate dev --name <change>`. Raw SQL only via `Prisma.sql` (timeline filters).
- Reuse `@reporter/shared` zod schemas; handlers call `schema.parse()` directly (there is no type provider).
- **Audit every write.** An interactive `$transaction` touching an audited model is wrapped in `withIntent(models, fn)` naming its models and records its own entry through `inTx(ctx, tx)`; a no-op save takes a path outside the scope. See the root `CLAUDE.md` and the header of `src/services/audit.ts`.
- **New table →** add it to `test/helpers.ts` `TABLES`, to the engagement export inventory if it belongs to an engagement, and to `src/audit/models.ts` (a `MODEL_SPECS` entry, or `UNAUDITED_MODELS` with the reason). The backstop fails loudly on a model it cannot classify.
- HMAC verification imports `computeSignature`/`verifySignature` from `@reporter/api-client` — never reimplement.
- Capture the raw body buffer for `/api/*` before parsing (needed for the signature). Uniform 401s.
- Blobs never touch the DB — always the `ContentStore`.

## Gotchas

- HMAC raw-body buffering is memory-bound; capped by `MAX_UPLOAD_BYTES`.
- `buildApp()` must stay side-effect-free for tests.
- `audit_entries` is append-only by trigger: `prisma migrate reset` is the only way to empty it on a dev box, the test harness truncates it with `truncateAuditLog`, and the backstop records fixture writes — so a test that counts audit rows truncates the log after its fixtures.
- **Known follow-up, deliberately not taken with the audit log:** `trustProxy: true` in `app.ts` makes `req.ip` whatever `X-Forwarded-For` says. On the documented plain-HTTP deployment with no proxy in front, that header is attacker-controlled, so every IP-keyed control — today the login rate limit — can be bypassed or aimed at someone else. The audit log stores no IP for this reason. The fix is a configured trusted-proxy list rather than `true`.

## Verify

- `pnpm --filter @reporter/server test` (integration vs real Postgres, `TEST_DATABASE_URL`).
- `/run-stack` + `/verify-api` skills for a manual HMAC round-trip.
