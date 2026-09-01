# Resilient DB connection + observability

## Multi-candidate DB connection with real fallback
- `db.js` previously only fell back from `DATABASE_URL` to the next env var
  if the *string failed to parse* — a syntactically valid but wrong/dead
  credential just failed outright. `getDb()`/`resolveDb()` now actually
  test-query (`SELECT 1`) each candidate in order (`DATABASE_URL` →
  `DATABASE_URL_UNPOOLED` → `POSTGRES_URL` → `POSTGRES_URL_NON_POOLING` →
  `NEON_DATABASE_URL`) and use the first one that really connects — so a
  bad pooled connection can fall back to a working direct one without a
  redeploy. The winning candidate is cached per-isolate so this doesn't
  add a round trip to every request, only the first one.
- `normalizeDatabaseUrl` now also recovers from a whole `.env` block being
  pasted in as a secret value (comment lines, a second `KEY=value` line) by
  keeping only the first non-comment line — this was silently producing an
  unparsable multi-line "URL" before.
- `/health/db` now reports which env var actually worked
  (`{"ok":true,"database":"reachable","source":"DATABASE_URL_UNPOOLED"}`),
  and on failure logs a per-candidate breakdown (hostnames only, never
  credentials) to Workers Logs / `wrangler tail` instead of a single opaque
  message — the client response stays generic either way.

## Observability
- Added `[observability]` to `wrangler.toml`: logs (with invocation logs)
  and traces enabled, so `console.error` calls like the one in `/health/db`
  are visible in the dashboard's Logs/Observability tab without needing
  `wrangler tail`.

---

# Deploy fix + private-bucket downloads

## Deploy failure
- `wrangler.toml` had a leftover placeholder `[[routes]]` pointing at
  `your-domain.com`, a zone that doesn't exist on the Cloudflare account.
  That's what was failing with "Could not find zone" — everything before
  it (build, bindings, upload) was already succeeding. Removed the block;
  the Worker now deploys to the default `*.workers.dev` subdomain. A real
  custom domain can be attached later from the dashboard's Domains &
  Routes tab instead of hand-editing routes.
- Renamed the Worker from `uoe-resources-api` to `communitylib` in
  `wrangler.toml` to match the connected Workers Builds project name and
  stop the CI name-mismatch warning/auto-PR on every build.

## Private-bucket downloads that never expire
- `storage.putObject` no longer returns a raw B2 URL. A private bucket
  returns 401 on those, and a presigned alternative would expire — neither
  is "forever." It now returns a same-origin `/api/files/<key>` path.
- Added `src/routes/files.js`, a streaming proxy mounted at `/api/files/*`.
  Each request is signed to B2 server-side with the existing stored keys
  and streamed straight through (no buffering the whole file in Worker
  memory), so the bucket can stay private while the link never expires.
  Supports byte-range requests (PDF viewers, resumable downloads) and
  sets long-lived immutable caching, since object keys are UUID-based and
  never change once uploaded.
- `resource_files.file_url`, `resources.thumbnail_url`, and
  `resources.combined_pdf_url` are now relative paths
  (`/api/files/units/12/notes/uuid-name.pdf`) rather than absolute URLs —
  the frontend should prepend the API's own base URL to them, the same
  way it already does for `/api/upload` etc.



## Database environment handling
- Accepts `postgres://` and `postgresql://`.
- Works with Neon pooled (`-pooler`) and direct/unpooled URLs.
- Trims whitespace/BOM.
- Accepts matching `'...'`, `"..."`, and `` `...` `` wrappers.
- Accepts accidental `DATABASE_URL=...` / `export DATABASE_URL=...` / `psql '...'` copy-paste.
- Falls back across common environment names:
  `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_URL`,
  `POSTGRES_URL_NON_POOLING`, `NEON_DATABASE_URL`.
- Validates the URL before giving it to Neon.

## Database reliability
- Upgraded `@neondatabase/serverless` to the GA 1.x line.
- Removed invalid multi-statement calls through Neon's HTTP query function.
- Uses `sql.transaction()` for comment counters and download counters/logs.
- Makes resource + resource files + unit resource counter atomic.
- Serializes logical unit creation with a transaction-scoped advisory lock.
- Makes schema enum creation idempotent.
- Added useful indexes and defensive non-negative counter constraints.

## Upload reliability
- Adds total upload-size protection in addition to per-file limits.
- Rejects unsupported/empty files.
- Detects duplicates inside the same multipart request.
- Keeps existing database duplicate detection.
- Uses UUID object keys instead of `Date.now()` keys.
- Deletes already-uploaded B2 objects if PDF conversion or DB persistence fails.
- Prevents WebP from being sent to `pdf-lib` while still allowing WebP as a stored image.
- Validates academic years.

## API stability/security
- Added `/health/db` readiness check without leaking credentials.
- Keeps `/health` as a database-independent liveness endpoint.
- Public 500 responses no longer expose raw DB/B2 exception messages.
- Added request IDs via `X-Request-ID`.
- Added explicit JSON/content headers for CORS.

## Validation performed
- `node --check` passed for every JavaScript source file.
- `package.json` parses successfully.
- Scanned SQL template literals and found no remaining multi-statement SQL calls.
- Full dependency installation was attempted but timed out in the execution environment, so a live Worker/Neon integration test could not be completed here.
