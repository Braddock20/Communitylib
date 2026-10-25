# CommunityLib Cloudflare OCR Engine 5.0.0

This is the Linux OCR/document conversion engine attached to the existing `communitylib` Cloudflare Worker through a Cloudflare Container + Durable Object binding. There is no Render deployment.

## What it does

- PDF text extraction first, OCR only for pages that have little/no text.
- OCR for common image formats and Tesseract language packs installed in the image.
- Office document conversion through LibreOffice (DOC/DOCX, PPT/PPTX, XLS/XLSX, ODT/ODS/ODP, RTF), then page-level extraction/OCR.
- Text/markup/table extraction for TXT, Markdown, CSV/TSV, HTML, JSON, XML, YAML, logs and EML; EPUB text extraction.
- Secure nested ZIP import. Each supported file becomes a normal CommunityLib resource and enters the existing backend OCR → verified-unit classification → search-indexing pipeline. ZIP paths are recorded in the resource note.
- Three independently addressable Cloudflare Container instances can process jobs concurrently. Cron wakes processors only when queued/running work exists; idle instances can sleep.
- Job claims, leases, heartbeats, retries, SHA-256 source verification, original B2 objects and PostgreSQL records remain owned by the existing Worker.

## Cloudflare setup

From the repository root:

1. Confirm Cloudflare Containers is available for the account and that the Worker is on a plan that supports it.
2. Ensure existing Worker secrets `ADMIN_API_KEY`, `DATABASE_URL`, and B2 credentials are present.
3. Add a new encrypted Worker secret:

   ```sh
   npx wrangler secret put PROCESSOR_SHARED_SECRET
   ```

   Use a strong random value. Do not commit it or place it in browser code.
4. Ensure `COMMUNITYLIB_API_URL` in `wrangler.toml` points to this exact Worker. The current value is `https://communitylib.talesapi.workers.dev`.
5. Deploy from the project root with a Docker-compatible build environment:

   ```sh
   npm install
   npx wrangler deploy
   ```

   Wrangler builds `processor/Dockerfile`, publishes the container image and deploys the Worker/DO binding. The first rollout can take several minutes. If your existing project uses a different Worker name, update `wrangler.toml` and `COMMUNITYLIB_API_URL` together.
6. Check `GET https://communitylib.talesapi.workers.dev/api/ocr/health` for cheap public edge/config liveness. With the admin bearer key, check `/api/ocr/v1/health` and `/api/ocr/v1/capabilities` for live Container status and format coverage.

The Container receives `ADMIN_API_KEY` and `PROCESSOR_SHARED_SECRET` at runtime from Worker secrets. They are not baked into the Docker image.

## API

The built-in console also includes `/bulk-import.html`: enter the admin key, choose a single document or ZIP, and watch resource/job status update. The key stays in page memory only; it is not written to local storage.

All ingestion calls use the existing Worker admin credential, never the internal processor secret:

```http
GET /api/ocr/health  # public edge/config liveness; does not wake the Container
GET /api/ocr/v1/health  # admin-only live Container health
GET /api/ocr/v1/capabilities
GET /api/ocr/v1/import/status?resource_ids=1,2,3  # admin-only batch status; max 200 IDs
POST /api/ocr/v1/ingest/file
POST /api/ocr/v1/ingest/archive
Authorization: Bearer <ADMIN_API_KEY>
Content-Type: multipart/form-data
```

Use multipart field name `file` for the single file or ZIP. Example:

```sh
curl -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -F "file=@uoe-resource-bundle.zip" \
  https://communitylib.talesapi.workers.dev/api/ocr/v1/ingest/archive
```

A successful ZIP response lists uploaded/skipped/rejected files and their resource IDs. OCR and classification continue asynchronously. Do not repeatedly submit the same archive: the existing file-hash duplicate checks protect individual documents.

## Format and safety limits

Supported document formats are advertised by `/api/ocr/v1/capabilities`. ZIP ingestion has configurable guardrails in `wrangler.toml`: 90 MB compressed upload, 5,000 entries, depth 4 for nested ZIPs, 4 GB cumulative expanded data, 25 MB per extracted file, and 2,000 imported files per archive. The Worker upload endpoint currently has a 25 MB per-file cap. These are safety controls, not promises of unlimited data; increase them only after validating Cloudflare request/body limits, container disk/RAM and cost.

Tesseract has language packs installed, but automatic OCR language recognition is not perfect. The processor defaults to English + Swahili and can use explicit language settings from the existing job API. It retries a small set of language combinations only when OCR returns almost no text. Low-confidence and ambiguous/multi-unit documents remain available for review instead of being silently assigned to an incorrect unit.

## Operations

- Queue health: `GET /api/ai/jobs?status=queued&limit=20` with the admin key.
- Processor health: `GET /api/ocr/health` for cheap edge liveness and `GET /api/ocr/v1/health` with the admin key for live container status.
- Worker logs: Cloudflare dashboard → Workers & Pages → `communitylib` → Logs.
- The Container uses `standard-3` (2 vCPU, 8 GiB RAM) and up to three concurrent instances. This is intentionally a CPU-capable OCR configuration and can incur usage charges. It is not a literally unlimited or zero-cost compute service.
- Keep originals in B2. Failed extraction must never delete originals; retry through the existing job API after reviewing the job error.
