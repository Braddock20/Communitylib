# CommunityLib 5.0.0 — Cloudflare OCR Engine

## Deployment architecture

Cloudflare Worker remains the public API, security boundary and orchestrator. A Cloudflare Durable Object starts a Linux Cloudflare Container for OCR and document conversion. The container polls the existing PostgreSQL-backed job queue and submits bounded page batches through the existing lease API. Cron checks job state every minute and wakes processors only while work is queued or running; idle containers may sleep.

## Included

- Container/DO binding and private proxy at `/api/ocr/*`.
- PDF text-first extraction; Tesseract OCR fallback for scanned pages and image files.
- LibreOffice conversion for common Office/OpenDocument formats.
- Text extraction for common plain-text, markup, tabular, email and EPUB formats.
- ZIP import API with nested archives, path traversal/symlink protection, entry-count/expanded-size/depth guards and per-file uploads.
- Archive members are submitted as ordinary unclassified CommunityLib resources; the existing Worker classification pipeline assigns units only when its verified evidence rules are strong enough.
- Three independently named processing shards; bounded concurrency and page submissions.
- Render-specific deployment files removed.

## API

- `GET /api/ocr/health` (public edge/config liveness; does not start the Container)
- `GET /api/ocr/v1/health` (admin-only live Container health)
- `GET /api/ocr/v1/capabilities`
- `GET /api/ocr/v1/import/status?resource_ids=...` (admin-only batch status; up to 200 resource IDs per call)
- `POST /api/ocr/v1/ingest/file` (multipart `file`)
- `POST /api/ocr/v1/ingest/archive` (multipart `file` containing ZIP)

Ingestion endpoints require `Authorization: Bearer <ADMIN_API_KEY>`. The Worker injects `PROCESSOR_SHARED_SECRET` when forwarding to the Container. Never expose either secret to browser code.

## Known operational boundaries

No OCR service can be literally unlimited. Cloudflare request-body, container CPU/RAM/disk, PostgreSQL/B2, file-size, page-count, language-model, and billing limits still apply. Archive and page limits are configurable guardrails. Tesseract supports many installed languages but does not guarantee perfect automatic language identification or handwriting/equation recognition. Documents with ambiguous unit evidence remain unclassified/reviewable.

The new Container binding requires a Cloudflare account/plan with Containers enabled. The Container image is built from `processor/Dockerfile` by `npx wrangler deploy`; the build requires a Docker-compatible environment. Configure `PROCESSOR_SHARED_SECRET` as a Worker secret before using the service.
