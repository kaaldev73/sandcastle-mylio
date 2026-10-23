# Deploying Familio on Coolify

Familio runs as a single container holding the web app and a SQLite database in
write-ahead-log mode, with originals and the database on one persistent volume
(ADR 0002). TLS is terminated at Coolify's proxy; the container speaks plain
HTTP behind it and is reached over HTTPS from the browser.

## Environment variables

All configuration comes from environment variables — nothing sensitive lives in
the code. Missing or invalid **required** values fail fast on start with a
message naming every problem (see `src/config.ts`, the single source of truth).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SESSION_SECRET` | **yes** | — | Secret for session security; use a long random value (≥16 chars). |
| `DATABASE_PATH` | **yes** | — | SQLite database file path. Point inside the volume, e.g. `/data/familio.db`. |
| `ORIGINALS_DIR` | **yes** | — | Directory for original Asset files, kept untouched. Point inside the volume, e.g. `/data/originals`. |
| `HOST` | no | `0.0.0.0` | Address to bind. Leave at the default so Coolify's proxy can reach the container. |
| `PORT` | no | `3000` | Port the HTTP server listens on. Matches the Dockerfile `EXPOSE`. |
| `SECURE_COOKIES` | no | `true` | Marks the session cookie `Secure` so browsers only send it over HTTPS. Keep `true` in production; set `false` only for a plain-HTTP local run. |
| `SESSION_TTL_SECONDS` | no | `604800` (7 days) | How long a login session stays valid. |
| `INVITE_TTL_SECONDS` | no | `604800` (7 days) | How long an unaccepted invitation stays valid. |
| `PASSWORD_RESET_TTL_SECONDS` | no | `3600` (1 hour) | How long a password-reset token stays valid. |
| `LOGIN_MAX_FAILURES` | no | `5` | Failed logins allowed per email within the window before blocking. |
| `LOGIN_WINDOW_SECONDS` | no | `900` (15 min) | Sliding window for counting login failures. |
| `UPLOAD_MAX_BYTES` | no | `52428800` (50 MB) | Largest single Upload accepted. |
| `BACKUP_S3_ENDPOINT` | no | — | S3-compatible endpoint for off-box backups. Set all four `BACKUP_S3_*` target/credential variables together, or none. |
| `BACKUP_S3_BUCKET` | no | — | Bucket that receives the database snapshot and originals. |
| `BACKUP_S3_ACCESS_KEY_ID` | no | — | S3 access key id. Keep it in the environment, never in the repository. |
| `BACKUP_S3_SECRET_ACCESS_KEY` | no | — | S3 secret access key. Keep it in the environment, never in the repository. |
| `BACKUP_S3_REGION` | no | `us-east-1` | Region used to sign S3 requests. |
| `BACKUP_S3_PREFIX` | no | `familio` | Key prefix under which backups are written. |
| `BACKUP_INTERVAL_SECONDS` | no | `86400` (daily) | Seconds between scheduled backups. Set `0` to disable the schedule (manual backups still work). |

The Dockerfile already sets `DATABASE_PATH=/data/familio.db`,
`ORIGINALS_DIR=/data/originals` and `PORT=3000`, so in Coolify you normally only
need to supply `SESSION_SECRET` and, to enable backups, the `BACKUP_S3_*`
target/credential variables.

## Coolify steps

1. **Create the resource.** In your Coolify project, add a new resource from
   this Git repository. Coolify detects the `Dockerfile` and builds the image.
2. **Mount a persistent volume.** Add a volume mounted at `/data`. Both the
   SQLite database and the originals live here, so this one volume is all the
   state the app has. The Dockerfile declares `VOLUME ["/data"]`.
3. **Set environment variables.** At minimum set `SESSION_SECRET` to a long
   random value. Override any default from the table above if needed. The
   defaults for `DATABASE_PATH`, `ORIGINALS_DIR` and `PORT` already point inside
   `/data` and at the exposed port.
4. **Set the domain and enable HTTPS.** Assign your domain and let Coolify issue
   and renew a certificate automatically. Coolify terminates TLS at its proxy
   and forwards to the container's port; keep `SECURE_COOKIES=true` so session
   cookies are only ever sent over HTTPS.
5. **Deploy.** Coolify builds and starts the container. The built-in
   `HEALTHCHECK` polls `/health`; Coolify shows the container healthy once it
   responds.
6. **Bootstrap the first Admin.** Once, after the first deploy, `POST
   /api/setup` with an `email` and `password` to create the first Admin
   account. Further accounts are invite-only.

## Persistence, restart and upgrades

- **Restart / redeploy.** Because the database and originals sit on the `/data`
  volume, stopping, restarting or redeploying the container keeps all data.
- **Upgrades.** On every start the app applies any pending database migrations
  inside a transaction and records each one, so re-running is a no-op. Deploying
  a newer image migrates the schema automatically without losing data; no manual
  migration step is needed.
- **Local volume.** The `/data` volume holds all the state; off-box backups
  copy it somewhere else so a lost disk is recoverable.

## Backups, restore and disk usage

When `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID` and
`BACKUP_S3_SECRET_ACCESS_KEY` are all set, a scheduled job runs every
`BACKUP_INTERVAL_SECONDS`. Each run:

- copies every original file untouched from `ORIGINALS_DIR`;
- takes a consistent snapshot of the live SQLite database with SQLite's online
  backup API (no need to stop the app);
- writes everything under `<BACKUP_S3_PREFIX>/backups/<backup-id>/`, then
  publishes `<BACKUP_S3_PREFIX>/latest.json` pointing at that complete set.

Only an Admin can use the backup endpoints:

- `GET /api/admin/backups` — whether backups are configured and the last run's
  start/finish time, outcome, error, object count and size.
- `POST /api/admin/backups` — run a backup immediately (`201` on success,
  `502` on failure; the failure is also recorded for the status endpoint).
- `GET /api/admin/disk` — total, used, free and available bytes on the data
  volume (`ORIGINALS_DIR`).

The same data is exercised by `test/backup.test.ts`, which starts a fake
S3-compatible endpoint, backs up through the HTTP API, then runs the restore
script and boots a fresh app on the restored database and originals.

### Restore procedure

Restore into an empty volume **before** starting the app, or stop the app first;
the script replaces `familio.db` and the `originals/` tree.

1. Prepare a volume mounted at `/data` (or another destination directory).
2. Run a one-off command in the same image with the same `BACKUP_S3_*`,
   `DATABASE_PATH`, `ORIGINALS_DIR` and `SESSION_SECRET` environment, using the
   latest backup:

   ```sh
   npm run restore -- --destination /data
   ```

   To restore a specific backup instead, add `--backup <backup-id>` (the id is
   in `latest.json`/the manifest, e.g. `2026-10-23T12-00-00-000Z`).
3. Start Familio normally. It applies any pending migrations and serves the
   restored database and originals; the restore script checks every downloaded
   object against the SHA-256 in the backup manifest.

## Smoke test

`test/smoke.test.ts` boots the real entrypoint (`src/main.ts`, the Dockerfile
`CMD` target) against a temporary directory standing in for the `/data` volume,
then drives it over HTTP to prove the container serves requests, that data
survives a restart/redeploy, and that migrations re-apply cleanly on the next
boot. It runs as part of `npm run test`. The deployment files themselves are not
unit tested (parent spec, Testing Decisions).
