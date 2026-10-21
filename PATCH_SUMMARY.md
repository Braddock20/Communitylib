# Communitylib AI reliability patch summary

## Applied in this source snapshot
- AI fallback model updated to `@cf/meta/llama-3.1-8b-instruct-fast`; Wrangler `AI_MODEL` aligned to `@cf/meta/llama-3.2-3b-instruct`.
- Full registry code scan added after AI/fallback classification, with `detected_units` and `is_multi_unit_document` returned both inside `suggestions` and at top level.
- Multi-unit documents force `suggestions.requires_review = true`.
- Unit code detection supports spaces, underscores, and hyphens, while enforcing alphanumeric boundaries.
- AI segment suggestions with missing, fractional, negative, or reversed page boundaries are marked invalid and sent for review rather than silently repaired.
- Admin segment save validates all ranges before writing, preventing partially saved suggestions.
- Physical split validates integer boundaries, page count, and overlap before extraction.
- Physical split writes segment metadata in one SQL statement; audit-log failure does not invalidate successfully generated PDFs; replaced objects are only cleaned up when no library file references them.
- Added admin-only `POST /api/ai/publish-segments/:resourceId` to explicitly publish generated PDFs into normal library resources after review. It checks file hashes to avoid duplicate publishing.
- Added regression tests for unit-code detection and page-boundary safety.
- `AI_JSON_MODE=true` can opt into `response_format: { type: "json_object" }`; it is off by default because model support must be verified against the active Workers AI model.

## Local validation completed
- `node --check` on JavaScript source files.
- `node --test`: 8 tests passed, 0 failed.

## Not performed from this environment
- No live Cloudflare deployment was attempted.
- No live Neon/B2 integration request was run; credentials are not present in the source archive and should not be shared here.
- No claim is made that this GitHub ZIP is byte-for-byte identical to the currently deployed Worker bundle.
