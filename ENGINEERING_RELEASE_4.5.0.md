# CommunityLib 4.5.0 — backend-first document classification

This release changes automatic document processing from a browser-operated queue to an external server-side processor.

## User-facing flow

1. Upload a PDF, TXT, JPG, JPEG, PNG or WEBP through `/api/upload`. Unit code/title are optional; without them, the resource enters `UNCLASSIFIED` until processing has evidence to assign it.
2. The Worker stores the original in B2 and queues an `external` job.
3. The backend processor polls the queue, claims the job with its private credentials, downloads the source through the Worker, checks SHA-256, extracts text and OCRs scanned pages.
4. The Worker persists page results, evaluates text quality, classifies registered unit codes/titles/topics/type from extracted text, and assigns a single strong unit match. Multiple-unit/weak matches are not forced into one unit.
5. When processing succeeds, the run is activated under the existing quality/indexing rules, making indexed pages searchable. Resource processing status moves through processing, ready, needs_review or failed.

## Processor deployment

This v4.5.0 deployment note is superseded by `ENGINEERING_RELEASE_5.0.0.md`. The OCR engine now deploys only as a Cloudflare Container attached to the existing Worker; Render deployment files were removed.

The Neon database must have the existing additive document-intelligence migration (`migrations/006_document_intelligence.sql`) installed, alongside its prerequisites. Do not replace the existing database or B2 bucket. Deploy the Worker from this project and the processor together so queued jobs use the same API contract.

## Current scope

The v4.5.0 capability list is historical. See `ENGINEERING_RELEASE_5.0.0.md` for current Cloudflare Container support, expanded document formats, ZIP ingestion, configurable processing guardrails and remaining limitations.

## Verification

- JavaScript syntax checks: passed.
- Python processor syntax compilation: passed.
- Automated Node suite: 65 total, 56 passed, 0 failed, 9 skipped because PostgreSQL integration was not configured.
- Live Cloudflare/Neon/B2 end-to-end deployment was not performed from this environment.
