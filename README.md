# University of Eldoret — Student Resources API (communitylib)

Backend for a public student resource-sharing platform: notes, CATs, and
exams organized by unit/course code, with search-as-you-type, a
library-style discovery feed, comments, duplicate detection, and automatic
multi-image → PDF conversion.

**Stack:** Cloudflare Workers (Hono) · Neon (Postgres, serverless) ·
Backblaze B2 (S3-compatible storage)

This version assumes a **dashboard-only workflow** — no local CLI, no
`wrangler`, no `psql`. Every setup step below uses a web UI.

---

## 1. Setup

### 1.1 Database (Neon)
1. console.neon.tech → your project.
2. Open the **SQL Editor** tab (not a terminal — Neon's own in-browser
   query runner).
3. Paste the entire contents of `schema.sql` and run it. It's idempotent
   (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`), so
   re-running it later is safe.
4. **Connection Details** panel on the same page has your connection
   string — copy the one you want (pooled, with `-pooler` in the
   hostname, is the right default for a Worker).

### 1.2 Storage (Backblaze B2)
1. Create a bucket, set it **private** — the API never returns a raw B2
   URL, everything is served through `/api/files/*`, which signs each
   request server-side, so a private bucket works fine.
2. Create an Application Key with read/write access to that bucket.
3. Note the S3-compatible endpoint (Bucket → Endpoint), e.g.
   `https://s3.eu-central-003.backblazeb2.com`.

### 1.3 Cloudflare Worker
Dashboard → **Workers & Pages** → your `communitylib` Worker (or
**Create** if starting fresh, connected to a GitHub repo so pushes
auto-deploy via Workers Builds).

**Settings → Variables and Secrets → Add** — one at a time, toggling
**Encrypt** on for each:

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon connection string from step 1.1 |
| `B2_KEY_ID` | from step 1.2 |
| `B2_APPLICATION_KEY` | from step 1.2 |
| `B2_BUCKET` | your bucket name |
| `B2_ENDPOINT` | from step 1.2 |
| `B2_REGION` | e.g. `eu-central-003` |
| `B2_PUBLIC_BASE_URL` | your bucket's friendly URL or a CDN in front of it |
| `DEBUG_KEY` *(optional)* | any random string — see §3 below |

Push this project to the connected repo (or upload the files directly if
using the dashboard's own editor) and Workers Builds deploys it. Attach a
custom domain later from **Settings → Domains & Routes → Add → Custom
Domain** — don't hand-edit a `[[routes]]` block in `wrangler.toml`,
that's what caused the "Could not find zone" deploy failure last time.

> **Secrets don't survive a Worker rename.** They're attached to the
> exact script `name` in `wrangler.toml`. If this project is ever renamed
> again, every secret above has to be re-added under the new name — that
> silent gap is the most likely cause of a Worker that deploys cleanly
> but returns 503 on every DB/storage-touching route.

---

## 2. Health checks

- `GET /health` — liveness only, never touches the database. If this
  fails, the problem is the Worker itself, not Neon or B2.
- `GET /health/db` — readiness. Tries every configured DB env var in
  order (`DATABASE_URL` → `DATABASE_URL_UNPOOLED` → `POSTGRES_URL` →
  `POSTGRES_URL_NON_POOLING` → `NEON_DATABASE_URL`) and reports which one
  actually connected. Public response is deliberately generic
  (`{"ok":false,"database":"unreachable"}`) so no connection details ever
  leak to a random visitor.

## 3. Debugging without a CLI

Set the optional `DEBUG_KEY` secret (any random string), then visit:

```
https://communitylib.talesapi.workers.dev/health/db?debug_key=YOUR_KEY
```

in a normal browser tab. On failure you'll get the exact reason —
which env var was tried, which host it resolved to, and the specific
connection error — right there in the JSON response. No `wrangler tail`,
no Logs dashboard tab, no local anything. Leave `DEBUG_KEY` unset and the
endpoint behaves exactly like the generic version above; nothing is
exposed by default.

---

## 4. Design notes (why things are structured this way)

- **Units are the spine.** A unit = one course/unit code + title
  (`MAT201 — Linear Algebra`). Every resource (notes/CAT/exam) hangs off a
  unit, so search, feeds, and stats all roll up naturally.
- **Auto-publish, no queue.** Uploads go live immediately (as requested) —
  `is_flagged` exists on `resources` so reporting/moderation can be added
  later without a schema change.
- **Chunked notes stay together.** A single "resource" can hold many files
  (`resource_files`, ordered) — so "Chapter 1–6 notes" uploaded as 6 PDFs
  displays and downloads as one coherent unit, not six separate list items.
- **Duplicate detection, two layers:**
  - Per-file: SHA-256 hash of every uploaded file is checked against
    `resource_files.file_hash` before anything is stored, and the column
    itself carries a unique index as a backstop against a same-instant
    race between two uploaders — that race is caught explicitly in
    `upload.js` and turned into a clean `409`, not a `500`.
  - Per-resource: an order-independent combined hash of the whole file set
    catches "the same CAT re-uploaded" even if filenames differ.
- **Image sets → one clean PDF.** If a resource is 2+ image files (e.g. a
  phone-scanned CAT), the API auto-combines them into a single PDF via
  `pdf-lib` (works fine on Workers — pure JS, no native canvas needed) and
  stores it as `combined_pdf_url`. Downloading such a resource returns that
  PDF instead of loose images. WebP is excluded from PDF-combining
  (pdf-lib can only embed PNG/JPEG) but still allowed as a standalone
  stored image.
- **Thumbnails without extra infra.** Rather than run image processing on
  the Worker, the first image of an image-set is used directly as the
  thumbnail. For a real resize/crop pipeline later, front the B2 public
  URL with **Cloudflare Image Resizing** (`/cdn-cgi/image/width=300/...`) —
  zero extra backend code.
- **Search = code OR title OR both**, autocomplete via Postgres
  trigram similarity (`pg_trgm`) — same idea as a predictive search box,
  no external search service needed at this scale.
- **Feed "learns" via logged signals**, not a black-box model: every
  search and download is logged (`search_logs`, `download_logs`) and the
  feed ranks `trending` by a recency-weighted blend of the two. `discover`
  mixes in random units so the feed doesn't calcify around only the
  popular ones.

## 5. API surface

```
GET  /health
GET  /health/db[?debug_key=...]

POST /api/upload                 multipart/form-data

GET  /api/search?q=...
GET  /api/search/suggest?q=...

GET  /api/feed

GET  /api/units/:id

GET  /api/resource/:id
GET  /api/resource/:id/download
GET  /api/resource/:id/comments
POST /api/resource/:id/comments

GET  /api/files/*                streaming proxy into private B2 bucket
```
