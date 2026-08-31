# Robustness / stabilization pass

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
