# @reporter/server

The reporter backend: a Fastify API that stores evidence, serves the web reporting UI, and exposes the HMAC client API used by the desktop app and `reporter-term`.

## Running

The normal way to run the server is the Docker stack at the repo root (`docker compose up -d`) — see the root [README](../../README.md). For local development:

```bash
docker compose -f ../../docker-compose.dev.yml up -d   # Postgres
cp .env.example .env                                    # or set env another way
pnpm --filter @reporter/server exec prisma migrate deploy
pnpm --filter @reporter/server run seed                 # demo data (optional)
pnpm dev:server                                         # http://localhost:8080
```

## Configuration (environment)

| Variable                                                | Default                 | Purpose                                                                                                               |
| ------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                          | — (required)            | PostgreSQL connection string.                                                                                         |
| `SESSION_SECRET`                                        | dev fallback            | Secret for signing session cookies. **Set in production** (`openssl rand -hex 32`).                                   |
| `PORT`                                                  | `8080`                  | HTTP port.                                                                                                            |
| `HOST`                                                  | `0.0.0.0`               | Bind address.                                                                                                         |
| `APP_URL`                                               | `http://localhost:8080` | Public URL. Cookies are marked `Secure` only when this is `https://` (or `COOKIE_SECURE=true`).                       |
| `COOKIE_SECURE`                                         | derived                 | Force-enable/disable the `Secure` cookie flag.                                                                        |
| `BLOB_STORE`                                            | `local`                 | `local` (filesystem) or `s3`.                                                                                         |
| `BLOB_DIR`                                              | `./.data/blobs`         | Local blob directory (when `BLOB_STORE=local`).                                                                       |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` / `S3_PREFIX` | —                       | S3 settings (when `BLOB_STORE=s3`).                                                                                   |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`           | —                       | S3 credentials.                                                                                                       |
| `MAX_UPLOAD_BYTES`                                      | `104857600`             | Max evidence upload size (100 MB).                                                                                    |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD`                        | —                       | Create the first admin on boot if the users table is empty (headless deploys). Otherwise use the web `/setup` screen. |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | —                       | Optional OIDC login (extension point).                                                                                |
| `WEBAUTHN_RP_ID`                                        | —                       | Optional WebAuthn relying-party id (extension point).                                                                 |

## S3-compatible storage

Set `BLOB_STORE=s3` plus the `S3_*` / `AWS_*` variables. Use `S3_ENDPOINT` for MinIO or other S3-compatible servers (path-style addressing is enabled automatically when an endpoint is set). Blobs then live in the bucket instead of the local volume — drop the `blobdata` volume from `docker-compose.yml`.

## Backup & restore

Two things hold state: the **database** (all metadata) and the **blob store** (evidence files).

```bash
# Backup
docker compose exec db pg_dump -U reporter reporter > reporter-db.sql
docker run --rm -v reporter_blobdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/reporter-blobs.tgz -C /data .

# Restore (into a fresh stack)
cat reporter-db.sql | docker compose exec -T db psql -U reporter reporter
docker run --rm -v reporter_blobdata:/data -v "$PWD":/backup alpine \
  tar xzf /backup/reporter-blobs.tgz -C /data
```

(With `BLOB_STORE=s3`, back up the bucket instead of the volume.)

The `audit_entries` table is append-only — no supported path deletes from it, and removing an entry only blanks its content in place — so on a long-lived server it comes to dominate the dump. That is expected: keep it, because restoring without it restores every engagement with no history.

## Architecture

See [CLAUDE.md](CLAUDE.md) for the internal layout (two auth planes, blob store, evidence pipeline, timeline filtering) and the [api-client README](../../packages/api-client/README.md) for the HMAC protocol.
