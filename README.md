# University of Eldoret — Student Resources API

Backend for a public student resource-sharing platform: notes, CATs, and
exams organized by unit/course code, with search-as-you-type, a
library-style discovery feed, comments, duplicate detection, and automatic
multi-image → PDF conversion.

**Stack:** Cloudflare Workers (Hono) · Neon (Postgres, serverless) ·
Backblaze B2 (S3-compatible storage)

---

## 1. Setup

### 1.1 Database (Neon)
1. Create a Neon project → copy the connection string.
2. Run the schema:
   ```bash
   psql "$DATABASE_URL" -f schema.sql
   ```

### 1.2 Storage (Backblaze B2)
1. Create a B2 bucket, set it **public** (so files serve directly without
   signed URLs — approval-free uploads means anyone can read).
2. Create an Application Key with read/write access to that bucket.
3. Note your S3-compatible endpoint (Bucket → Endpoint), e.g.
   `https://s3.eu-central-003.backblazeb2.com`.

### 1.3 Cloudflare Worker
```bash
npm install
wrangler secret put DATABASE_URL
wrangler secret put B2_KEY_ID
wrangler secret put B2_APPLICATION_KEY
wrangler secret put B2_BUCKET
wrangler secret put B2_ENDPOINT
wrangler secret put B2_REGION
wrangler secret put B2_PUBLIC_BASE_URL   # e.g. your bucket's friendly url or a CDN in front of it
npm run dev      # local dev
npm run deploy   # goes live on your workers.dev / custom route
```
Edit `wrangler.toml` → `[[routes]]` with your real domain, or delete that
block to just use the default `*.workers.dev` subdomain.

---

## 2. Design notes (why things are structured this way)

- **Units are the spine.** A unit = one course/unit code + title
  (`MAT201 — Linear Algebra`). Every resource (notes/CAT/exam) hangs off a
  unit, so search, feeds, and stats all roll up naturally.
- **Auto-publish, no queue.** Uploads go live immediately (as requested) —
  `is_flagged` exists on `resources` so you can bolt on reporting/moderation
  later without a schema change.
- **Chunked notes stay together.** A single "resource" can hold many files
  (`resource_files`, ordered) — so "Chapter 1–6 notes" uploaded as 6 PDFs
  displays and downloads as one coherent unit, not six separate list items.
- **Duplicate detection, two layers:**
  - Per-file: SHA-256 hash of every uploaded file is checked against
    `resource_files.file_hash` before anything is stored.
  - Per-resource: an order-independent combined hash of the whole file set
    catches "the same CAT re-uploaded" even if filenames differ.
- **Image sets → one clean PDF.** If a resource is 2+ image files (e.g. a
  phone-scanned CAT), the API auto-combines them into a single PDF via
  `pdf-lib` (works fine on Workers — pure JS, no native canvas needed) and
  stores it as `combined_pdf_url`. Downloading such a resource returns that
  PDF instead of loose images.
- **Thumbnails without extra infra.** Rather than run image processing on
  the Worker (heavy), the first image of an image-set is used directly as
  the thumbnail. For a real resize/crop pipeline later, front the B2 public
  URL with **Cloudflare Image Resizing** (`/cdn-cgi/image/width=300/...`) —
  zero extra backend code.
- **Search = code OR title OR both**, autocomplete via Postgres
  trigram similarity (`pg_trgm`) — same idea as Google's predictive list,
  no external search service needed at this scale.
- **Feed "learns" via logged signals**, not a black-box model: every
  search and download is logged (`search_logs`, `download_logs`) and the
  feed ranks `trending` by a recency-weighted blend of the two. `discover`
  mixes in random units so the feed doesn't calcify around only the
  popular ones.

---

## 3. API Reference

Base URL: `https://<your-worker>/api`

### Upload
`POST /upload` — `multipart/form-data`

| field | required | notes |
|---|---|---|
| `unit_code` | ✅ | e.g. `MAT 201` (auto-normalized) |
| `unit_title` | ✅ | e.g. `Linear Algebra` |
| `type` | | `notes` \| `cat` \| `exam` \| `assignment` \| `other` (default `notes`) |
| `academic_year` | required for cat/exam | e.g. `2023` |
| `title` | | resource title; auto-generated if omitted |
| `uploader_name` | | defaults to "Anonymous" |
| `note` | | short note from the uploader |
| `files` | ✅ (1–20) | repeat the field for multiple files |

Responses: `201` with `{ resource, unit }` · `409` on duplicate
(`duplicate_files` or `duplicate_resource`) · `400` on validation errors.

### Search
- `GET /search/suggest?q=` → up to 8 autocomplete matches, Google-style,
  as the user types.
- `GET /search?q=` → full results: matching units, each with resources
  pre-grouped into `notes`, `cats` (by year), `exams` (by year),
  `assignments`, `other` — ready to render directly.

### Feed
- `GET /feed` → `{ trending, most_downloaded, recently_added, discover }`

### Units
- `GET /units/:id` → unit info + all its resources, grouped (same shape as
  one search result).

### Resource
- `GET /resource/:id` → full detail + every underlying file.
- `GET /resource/:id/download` → logs the download, returns the right
  link: single file URL, the combined PDF, or a file list for mixed sets.

### Comments
- `GET /resource/:id/comments`
- `POST /resource/:id/comments` — `{ author_name?, content }`

---

## 4. Next steps worth considering
- Add lightweight abuse controls (rate-limit uploads per IP via Workers KV,
  a simple profanity/report flag on comments) since there's no upload
  review step.
- Add a `DELETE`/report endpoint once you're ready for moderation.
- Put Cloudflare Image Resizing in front of B2 for real thumbnails/crops.
- If the corpus grows large, swap `pg_trgm` search for Postgres full-text
  (`tsvector`) or an external search index — trigram is plenty fast at
  university-department scale.


## 5. Robust environment handling

`DATABASE_URL` accepts normal PostgreSQL/Neon URLs in either `postgres://` or
`postgresql://` form. Neon pooled (`-pooler`) and direct/unpooled endpoints are
both supported; the API does not rewrite either one.

The worker also tolerates common copy/paste mistakes such as:

```text
DATABASE_URL="postgresql://..."
"DATABASE_URL=postgresql://..."
'postgres://...'
```

If `DATABASE_URL` is missing/invalid, it will also try the common names
`DATABASE_URL_UNPOOLED`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, and
`NEON_DATABASE_URL`.

Use `/health` for liveness and `/health/db` to verify that the configured
database is actually reachable. Database credentials are never returned by
either endpoint.

## 6. Reliability hardening

- DB writes that update multiple counters/logs use Neon HTTP transactions.
- Upload DB insertion of a resource, its files, and the unit counter is
  atomic.
- B2 objects are cleaned up if a later upload or database step fails.
- Upload object names use UUIDs rather than timestamps, preventing collisions
  under concurrent uploads.
- Duplicate files are detected both against the database and within the same
  upload request.
- WebP images are accepted as files but are not incorrectly fed to `pdf-lib`;
  automatic image-to-PDF conversion is limited to JPEG/PNG.
- Public API errors no longer expose raw database/B2 exception messages.
- Uploads have both per-file and total-size limits.
- The schema is safer to re-run because the enum creation is idempotent.
