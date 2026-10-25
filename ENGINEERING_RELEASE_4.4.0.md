# CommunityLib 4.4.0 — Engineering Release Notes

## What changed

This release hardens the existing document-classification pipeline rather than replacing the app with a second service.

### Classification path

1. Load the current unit registry from Postgres, including aliases.
2. Scan the document body for registered unit codes (normalizing spaces, hyphens and underscores).
3. Compare official titles and registered aliases against the body; treat filename evidence as weaker.
4. Extract conservative, explainable topic labels from recognized subject vocabulary.
5. Use optional Workers AI only as an additional suggestion source. The response is independently checked against the registry and source text.
6. Return all supported unit matches, a primary suggestion, evidence tier, filename-conflict signal and review requirement.

### Evidence policy

- A registered code in the document body outranks a filename-only code.
- A title or alias can support a match when no code is printed.
- A code-like string absent from the registry is not verified.
- A model cannot add unrelated units to the detected-unit list when body evidence exists.
- Multi-unit documents and filename conflicts are review-required; the API caps confidence rather than implying certainty.
- `confidence` is a conservative operational score, not a statistically calibrated probability.
- Suggested page ranges are not physically validated merely because their numbers look valid. Splitting must validate ranges against the actual PDF page count and overlap constraints.
- Upload now attempts to enqueue supported PDF/image/TXT files automatically as extraction jobs. Unsupported office/archive formats are reported as not queued rather than silently pretending they will be processed. Queue creation failures do not roll back a successful upload; they are returned in the upload response and logged.
- The protected processing console can automatically run queued jobs sequentially in the browser while it remains open. This can be switched off on that device. Completed extraction runs are not automatically activated for public search; the review/activation gate remains intact.

### Processing architecture already present in the base project

The existing Worker has durable job/run records, leases, idempotent submissions, retry/backoff state, stale-lease recovery on a five-minute cron, page-level OCR/text results, quality checks, controlled indexing, and explicit run activation. The Worker is intentionally not the PDF rasterization engine; browser PDF.js or a configured external processor submits bounded page results. That avoids forcing large PDFs into the Worker memory/runtime envelope.

## Configuration remains deliberately safe

- `AI_PUBLIC_ENABLED` remains `false` in the checked-in `wrangler.toml`.
- `PDF_PROCESSING_ENABLED` remains `false` until the operator validates the configured processing path.
- OCR is still performed by the browser processor, not by the Cloudflare Worker itself. Queue automation requires the protected Processing Console to be unlocked and kept open; a true always-on backend OCR executor is not enabled by this release.
- No production deploy was performed by this patch.
- No database migration is required for this classifier patch.
- The timetable-extracted catalogue remains provisional; it must not be treated as the complete current official catalogue without review.

## Verification

Run from the project directory:

```sh
npm test
```

Current local result for this archive: **65 tests total, 56 passed, 0 failed, 9 skipped**. The nine skipped tests require a reachable Postgres test database configured with `PGTEST_URL`; they are not claimed as passed.

Before a public release, run the skipped DB-backed tests against a disposable test database, verify Cloudflare bindings/secrets, validate B2 upload/download and CORS from a real client, run the documented upload → extraction → review → activation flow, and deploy only after those checks pass.
