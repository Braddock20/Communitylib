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

### Notes metadata
For `type=notes`, `note_scope` can be `complete` or `topical`. It defaults to
`complete`. When `note_scope=topical`, `topics` is optional and may contain
one or many topic names. Clients may send `topics` repeatedly or send a
comma-separated value. `unit_code` remains compulsory for every upload.

Examples:
- Complete notes: `type=notes`, `note_scope=complete`, `unit_code=MAT201`
- One topic: `type=notes`, `note_scope=topical`, `topics=Integration`, `unit_code=MAT201`
- Multiple topics: repeat `topics` or use `topics=Integration,Differentiation`,
  `unit_code=MAT201`

Topical note resources are returned separately as `grouped.topical_notes`,
while complete notes remain in `grouped.notes`. Topic names are also included
in resource responses and are searchable through `/api/search`.

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


---

## 6. Communitylib v4 AI + preview edition

Version 4 keeps the existing resource IDs, original file names, B2 object keys,
download proxy and existing API routes. Apply the original `schema.sql` only
for a fresh database. For an existing installation, run **only**
`migrations/004_ai_library.sql` in the Neon SQL Editor after confirming the
backup/maintenance window. The migration is additive; it does not delete
resources or rewrite storage URLs.

### AI provider and safe behaviour

The Worker can use Cloudflare Workers AI through the `AI` binding. The default
model is `@cf/meta/llama-3.1-8b-instruct`; override it with an `AI_MODEL` Worker
variable if you select a compatible model available to your account. AI is
optional: `/api/ai/analyze` falls back to deterministic filename/text matching
when the binding is absent or fails. A model response is a suggestion, not a
database write. A unit code is marked verified only when it matches the
registry. Unknown codes are returned separately as unverified candidates.

Workers AI usage and model availability are subject to Cloudflare account
limits and pricing. The application does not train a foundation model. Public Workers AI inference is disabled by default to reduce quota-abuse risk; enable it only with an appropriate Cloudflare rate limit. It
combines the model with the unit registry, provenance, deterministic checks,
and reviewable suggestions.

### New environment settings

Add these in Workers & Pages → your Worker → Settings → Variables and Secrets:

- `ADMIN_API_KEY` — **secret**, required for registry imports, saving split
  suggestions, and processing-job inspection. Use a long random value.
- `AI_MODEL` — optional plain-text variable; defaults to the model above.
- `AI_PUBLIC_ENABLED` — defaults to `false`; set to `true` only after adding a Cloudflare rate-limit rule for `/api/ai/analyze`. With it disabled, deterministic fallback analysis still works and no public request consumes Workers AI quota.
- Keep `DATABASE_URL`, `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`,
  `B2_ENDPOINT`, and `B2_REGION` as configured already.

Do not put credentials in the repository, browser JavaScript, or a public
frontend. `ADMIN_API_KEY` must only be used by a trusted admin environment.

### New endpoints

```
GET  /api/ai/registry?q=...
POST /api/ai/registry/import        admin; JSON unit registry import
POST /api/ai/analyze                AI/deterministic metadata suggestions
POST /api/ai/segments               admin; save proposed page ranges for review
GET  /api/ai/segments/:resourceId   saved page-range suggestions
POST /api/ai/split/:resourceId      admin; physically split a PDF by page ranges
POST /api/ai/merge                  admin; merge 2-20 PDFs from same unit/type
GET  /api/ai/jobs?status=queued     admin; recent processing-job status
GET  /api/resource/:id/preview      frontend-ready preview metadata
```

Registry import body:

```json
{
  "source_name": "UoE supplementary examination timetable, revised 2026-07-20",
  "source_type": "official_timetable",
  "source_date": "2026-07-20",
  "source_reference": "Replace with the actual document URL or filename",
  "units": [
    {
      "code": "PHYS 121",
      "title": "Title exactly as printed in the source",
      "aliases": ["PHYS121"],
      "confidence": 0.7,
      "notes": "Extracted from timetable; confirm against the official catalogue"
    }
  ]
}
```

Accepted source types are `official_catalogue`, `official_timetable`,
`faculty_list`, `manual`, and `unverified`. A timetable entry is not
automatically treated as proof that a unit is currently offered. Keep the
source and confidence. Imports upsert a unit by normalized code + title;
they do not delete older titles or aliases.

Analysis request:

```json
{
  "filename": "PHYS121_CAT_2025.pdf",
  "text": "Paste text extracted from the document here..."
}
```

The response contains suggested unit/type/year/title/topics, confidence,
whether the unit code is verified against the registry, and optional segment
suggestions. It never applies the metadata automatically. PDF text extraction
and OCR are not silently claimed to happen on the Worker: send extracted text
to the endpoint, or add a separately configured extraction/OCR provider.

### Document preview / thumbnail system

`GET /api/resource/:id/preview` returns the title, first available preview URL,
snippet, file count, file metadata and the renderer recommendation. The included
`frontend/document-preview.js` defines a reusable
`<communitylib-document-preview resource-id="123">` component that displays a
compact chat-app-style file card. With PDF.js loaded it renders page one of a
PDF in the browser; images are shown directly; other types receive a fallback.
The preview demo is `frontend/preview-demo.html`.

Example embedding:

```html
<script type="module">
  import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
  globalThis.pdfjsLib = pdfjsLib;
  await import('/frontend/document-preview.js');
</script>
<communitylib-document-preview api-base="https://YOUR-WORKER.example"
  resource-id="123"></communitylib-document-preview>
```

PDF first-page rendering is client-side; it is not represented as a permanently
generated B2 thumbnail. The component can be extended later to post a generated
thumbnail to a private storage pipeline. Text snippets are drawn from the
resource note/text metadata when available. Existing PDFs may show a fallback
snippet until text extraction is configured.

### Split/merge and ingestion safety

The AI endpoint can propose page-range segments, and `/api/ai/segments` stores
those suggestions with a `suggested` status for an admin to review. **This
version does not physically split arbitrary PDFs or automatically merge
separate PDF fragments.** The original file remains unchanged. A production
split/merge worker needs a PDF page manipulation implementation, file-size
limits, and an approval flow; do not auto-publish a guessed page boundary.

Existing uploads remain compatible. Current duplicate checks still use SHA-256
for each file and an order-independent resource hash. Failed upload cleanup
remains in place. Existing B2 object keys and the `/api/files/*` proxy are
unchanged.

### Smoke tests

Install Node.js dependencies and run:

```sh
npm install
npm test
npm run dev
```

Then check `GET /health`, `GET /health/db`, and (with database access)
`GET /api/ai/registry`. The included tests cover deterministic normalization,
stable hashing and image/PDF extension decisions. Live Neon/B2/Workers AI
integration requires the deployment's actual secrets and resources.


## AI classification and safe PDF segmentation (updated)

`POST /api/ai/analyze` now scans the complete unit registry for explicit unit-code mentions, even when the AI's primary classification query only found one likely unit. Its response preserves the existing `suggestions` object and adds `detected_units` and `is_multi_unit_document` both inside `suggestions` and at the top level. A multi-unit result always requires manual review.

Suggested page ranges are never silently repaired. Missing, fractional, zero/negative, or reversed page boundaries are marked invalid for review. The admin-only split endpoint validates integer page ranges against the actual PDF page count and rejects overlaps before writing derived PDFs. The original file remains unchanged.

After reviewing a successful split, an administrator may publish the generated PDFs as normal library resources:

```http
POST /api/ai/publish-segments/:resourceId
Authorization: Bearer <ADMIN_API_KEY>
```

This endpoint publishes only segments already stored with `status='generated'`. It is a separate, explicit action; splitting does not automatically make generated files appear in ordinary library search. Repeating the request is safe for files with matching SHA-256 hashes.

### Model configuration

`wrangler.toml` uses `@cf/meta/llama-3.2-3b-instruct` as `AI_MODEL`, matching the current configured production model described by the project maintainer. The hardcoded fallback is `@cf/meta/llama-3.1-8b-instruct-fast`. JSON response mode is opt-in via `AI_JSON_MODE="true"` because support depends on the selected Workers AI model; leave it unset until tested against the active model. The classifier still requests valid JSON and uses the existing parser/fallback path.

### Safe deployment checklist

1. Back up the currently deployed Worker source/configuration and preserve a copy of its non-secret variable names/values. Never export or commit `ADMIN_API_KEY`, database URLs, or B2 application keys.
2. Review this source against the live Worker before deploying; this ZIP is a GitHub source snapshot, not a guaranteed export of the live deployed bundle.
3. Verify Cloudflare Workers Builds/automatic deployment settings. A GitHub commit may deploy automatically if that integration is enabled.
4. Install dependencies and run `npm test`; then run `npx wrangler deploy` only after confirming the target Worker, bindings, variables, and secrets.
5. Test `/api/ai/analyze` using a combined document mentioning two registry codes. Confirm both appear in `detected_units`, `is_multi_unit_document` is `true`, and `suggestions.requires_review` is `true`.
6. For an authorized PDF split, test invalid and overlapping ranges first and confirm they return HTTP 400 without generating files. Then split a valid range and verify the original still downloads.
7. Publish generated segments only after human review using the endpoint above.

No database migration is added by these code changes; the publishing endpoint uses the existing `resources`, `resource_files`, `units`, `document_segments`, and `ai_audit_log` schema introduced by the current project migrations.
