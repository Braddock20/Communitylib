# v3.0.0 — clean rebuild

Full rewrite of every source file from scratch. API surface, routes, and
database schema are unchanged from v2.0.0 — anything already talking to
this API keeps working. Two concrete fixes and one workflow change:

## Fixed
- **`/health/db` was a black box with no CLI available.** `resolveDb()`
  now always returns a structured `attempts` array (which env var, which
  host, why it failed — never credentials) attached to the thrown error.
  `/health/db` stays generic by default, but an optional `DEBUG_KEY`
  secret unlocks the full breakdown at
  `/health/db?debug_key=YOUR_KEY` in a plain browser tab — no
  `wrangler tail`, no Logs dashboard tab needed.
- **Duplicate-upload race returned a 500.** `resource_files.file_hash` is
  globally unique; two near-simultaneous uploads of the same file can
  both pass the pre-insert duplicate check and race to insert. The loser
  used to fall through to the generic 500 handler. Now the Postgres
  unique-violation (`23505`) is caught explicitly and turned into the
  same clean `409 duplicate_files` response the normal duplicate path
  already returns.

## Changed
- Docs (`README.md`) rewritten for a **dashboard-only workflow**: Neon's
  SQL Editor instead of `psql`, Cloudflare's Variables and Secrets UI
  instead of `wrangler secret put`, Workers Builds (git push) instead of
  `wrangler deploy`. The CLI-based instructions in v2.0.0 didn't match
  how this project is actually being run.
- `wrangler.toml` now carries an explicit comment warning that secrets
  are scoped to the exact Worker script name and do not survive a
  rename — this project hit that exact gap after being renamed from
  `uoe-resources-api` to `communitylib`.

---

# v2.0.0 — resilient DB connection + private-bucket downloads

- Multi-candidate DB connection: tries `DATABASE_URL` →
  `DATABASE_URL_UNPOOLED` → `POSTGRES_URL` → `POSTGRES_URL_NON_POOLING` →
  `NEON_DATABASE_URL`, in order, actually test-querying each rather than
  only checking whether it parses.
- `normalizeDatabaseUrl` recovers from common copy/paste mistakes: whole
  `.env` blocks, shell `export`, `psql '...'` wrapping, mismatched quotes.
- Private B2 bucket support via a same-origin `/api/files/*` streaming
  proxy (signed server-side per request, byte-range support, never
  expires) instead of raw/presigned B2 URLs.
- `wrangler.toml` observability (logs + traces) enabled.
- Upgraded `@neondatabase/serverless` to the GA 1.x line; atomic
  transactions for comment/download counters; idempotent schema.
