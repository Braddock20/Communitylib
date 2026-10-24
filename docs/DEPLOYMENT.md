# Deploying v4.3.0 (document processing)

Nothing here has been run against your production Neon, Backblaze B2 or Cloudflare account.
Every step below changes production and needs your explicit go-ahead.

## 0. What is new
* Migration `006` (additive; old `extracted_text` and all old job statuses keep working).
* Job API (`/api/ai/jobs*`, `/api/ai/runs/*`), public page and content search
  (`/api/search/content`, `/api/resource/:id/pages*`).
* Admin console at `/` of the static assets (`frontend/console/index.html`), which does OCR **in your browser**.
* A cron every 5 minutes that releases dead leases and re-queues failed jobs.
* Not included (phase 2): Office/ZIP parsing, external processor, AI metadata review UI,
  duplicate-detection endpoints, embeddings, study tools v2. See `DELIVERY_REPORT.md`.

## 1. Back up, then migrate (needs approval)
1. In the Neon console create a branch or snapshot of production.
2. Run the migration on that **branch** first: `psql "$BRANCH_URL" -f migrations/006_document_intelligence.sql`
3. Check: `select version from schema_migrations;` shows `006`.
4. Repeat on production (same command) when happy.
Rollback (the confirmation must be in the same session):
`printf "SET communitylib.confirm_rollback='yes';\n" | cat - migrations/006_rollback.sql | psql "$URL"`.
Extraction data is dropped by rollback; originals are never touched.

## 2. Deploy the Worker (needs approval)
* `ADMIN_API_KEY` must already be a secret on the Worker. Use a long random value.
* `npx wrangler deploy` (Free plan is fine: all heavy work is in Postgres or the browser).
* `wrangler.toml` now has a cron trigger and an `[assets]` binding serving `frontend/console`
  for non-API paths. If your current site is already served another way, review `[assets]` before deploying.

## 3. First run
1. Open the Worker URL, enter the admin key (kept in memory only).
2. New job -> resource ID (e.g. 1) -> Create job -> Jobs -> **Process here**. Keep the tab open and the screen awake.
3. Review held pages, then **Activate** the run so search uses it. Use "Activate automatically" only after you trust results.
4. Regression target: PHYS 121 NOTES.pdf (35 pages, image-based). Expect OCR on most pages and some held for review.
   Equations are flagged, never converted to LaTeX.

## 4. Known gaps you should know about
* The console loads PDF.js 3.11.174 and Tesseract.js 5.1.1 from cdnjs without SRI hashes (could not be computed offline). Add `integrity=` attributes.
* Real PDF.js/Tesseract in a browser, real Neon/B2 and `wrangler deploy` were not exercised here (no npm/network access in the build sandbox); the protocol client was tested with fake PDF/OCR engines against the real API and Postgres.
* No `package-lock.json`: run `npm install` once and commit it.
