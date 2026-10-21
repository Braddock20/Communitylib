# Communitylib v4.2.0 deployment checklist

## Before deployment

1. Back up the Neon database and keep the current live Worker unchanged.
2. Apply `migrations/004_ai_library.sql` if not already applied, then apply `migrations/005_performance_safety.sql` in the Neon SQL Editor. Do not deploy the new search code before migration 005 succeeds.
3. In Cloudflare Worker secrets, confirm `DATABASE_URL`, `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT`, `B2_REGION`, and `ADMIN_API_KEY`. `DEBUG_KEY` is optional. Never put actual secret values in GitHub.
4. This source defaults `AI_PUBLIC_ENABLED` to `false` and uses `@cf/meta/llama-3.1-8b-instruct-fast` consistently. This protects AI quota on a fresh deploy. If you intentionally want live public Workers AI classification, enable `AI_PUBLIC_ENABLED=true` in Cloudflare after confirming the AI rate limiter is active and monitoring is in place.
5. The code caps uploads at 25 MB. Synchronous image-to-PDF conversion and PDF split/merge are disabled by default because measured CPU use can exceed the Free Workers budget. PDF processing is additionally capped at 15 MB per source and 15 MB total for merges; only enable `PDF_PROCESSING_ENABLED=true` and `IMAGE_PDF_COMBINE_ENABLED=true` after confirming the Worker plan supports synchronous processing.
6. Do not expose `ADMIN_API_KEY` in a public frontend bundle. The included `frontend/agentic-tools.js` accepts the key in memory only; use a private admin page or trusted server proxy. Browser extraction uses PDF.js and supports text-based PDFs; scanned/image-only PDFs need OCR. The PHY121 source is about 20.5 MB, so browser extraction is supported but synchronous split/merge still rejects it under the existing 15 MiB limit.
7. Generate and commit `package-lock.json` on a network-enabled machine: `npm install --package-lock-only`. The audit sandbox could not reach npm's registry, so this archive deliberately does not invent a lockfile or integrity hashes.

## Local checks

```sh
npm ci
npm test
npx wrangler deploy --dry-run
```

Do not deploy if the migration, lockfile generation, test, or dry run fails.

## Post-deploy smoke tests

- `GET /health` returns `{"ok":true}`.
- `GET /health/db` reports the database reachable.
- `GET /api/ai/registry?q=PHY` returns registry data.
- `GET /api/ai/tools` returns the tool inventory and approval levels.
- With `ADMIN_API_KEY` configured, test `POST /api/ai/extract-text` using a small, text-based PDF and page markers; verify `GET /api/resource/:id/preview` now has `page_count` and a snippet.
- With the Workers AI binding available, test `POST /api/ai/study` with `ask`, `summarize`, `flashcards`, and `quiz`; ensure results stay grounded in extracted text.
- Test `POST /api/ai/apply-metadata` only on a test resource, with a verified registry unit code, then verify `unit_id`, resource counts, and topics.
- With `AI_PUBLIC_ENABLED=true`, test `/api/ai/analyze` using a known single-unit sample and a combined PHY121 + AGRI111 sample. Confirm both appear in `detected_units`, and the combined document sets `is_multi_unit_document=true` and `requires_review=true`.
- `GET /api/ai/segments/<resourceId>` without admin credentials returns 401.
- Try a malformed file key and confirm it returns 400; try a flagged/unpublished object's key and confirm it returns 404.
- Upload a `.txt` file with a spoofed `text/html` client MIME type. The stored and served content type must remain `text/plain; charset=utf-8`, with `X-Content-Type-Options: nosniff`.
- Only if the plan has been confirmed and `PDF_PROCESSING_ENABLED=true`, test one small PDF split with known page ranges and verify the output pages, then test an over-limit PDF and confirm it is rejected before downloading its body.

## Operational notes

- The new browser extraction route stores text supplied by PDF.js; the Worker does not parse or buffer the original PDF. It supports one PDF per resource and a 700,000-character cap.
- `POST /api/ai/study` sends at most 24,000 characters to Workers AI in this version. For longer notes, answers/summaries may be based on the beginning of the document; chunked retrieval is a future improvement.

- New Cloudflare rate-limit bindings are declared in `wrangler.toml`: `PUBLIC_UPLOAD_LIMITER`, `PUBLIC_COMMENT_LIMITER`, and `PUBLIC_SEARCH_LIMITER`. Watch 429s because users behind one campus NAT share an IP bucket.
- `B2_PUBLIC_BASE_URL` is no longer required; files are served through the same-origin proxy.
- The source has been syntax-checked and its pure Node tests pass, but the sandbox could not install dependencies or run a real Wrangler build. Live Neon, B2, Workers AI, and Cloudflare deployment have not been verified from this environment.
