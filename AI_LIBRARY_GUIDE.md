# CommunityLib — Portable AI Library Guide

This file is a portable instruction sheet for AI chats that cannot connect to remote MCP directly. Upload it into a conversation alongside your task. It explains the API, but **does not grant the AI network access or credentials**.

## Service details

- Base URL: `https://YOUR-COMMUNITYLIB-WORKER.workers.dev`
- MCP endpoint: `https://YOUR-COMMUNITYLIB-WORKER.workers.dev/mcp`
- MCP discovery: `GET https://YOUR-COMMUNITYLIB-WORKER.workers.dev/mcp`
- API tools inventory: `GET https://YOUR-COMMUNITYLIB-WORKER.workers.dev/api/ai/tools`
- Health check: `GET https://YOUR-COMMUNITYLIB-WORKER.workers.dev/health`

Replace the placeholder with the actual Worker URL after deployment. Never paste secret keys into this guide or upload a permanent admin key to an untrusted AI service.

## Working rules for the AI

1. Start by checking `/health`, `/mcp`, and `/api/ai/tools` if external requests are available.
2. Use the verified unit registry before assigning a unit code. Never invent a code or silently overwrite a verified match.
3. Search before creating resources; check likely duplicates and report uncertainty.
4. Preserve originals. Treat classification, extracted metadata, topics, and segmentation as suggestions until reviewed.
5. For bulk jobs, produce a manifest with filename, detected type, unit candidate, confidence, duplicate candidate, action, and reason. Ask for approval before publishing, deleting, merging, or changing many records.
6. Use bounded batches and report successes, skips, failures, and retryable items separately.
7. Do not expose private keys, tokens, database URLs, signed storage URLs, or personal data in summaries.
8. If you cannot call external APIs, work on uploaded files locally in the conversation and return a structured manifest or an importable JSON/CSV result. Be explicit about any step the user must apply manually.

## Public read tools

- `GET /api/search?q=QUERY` — search resources grouped by unit.
- `GET /api/search/suggest?q=QUERY` — unit autocomplete.
- `GET /api/ai/registry?q=QUERY` — verified unit registry search.
- `GET /api/resource/ID` — inspect resource metadata and attached files.
- `GET /api/resource/ID/preview` — preview metadata and snippet.
- `GET /api/search/content?q=QUERY` — search extracted document pages.

## Administrative tools

Administrative endpoints require `Authorization: Bearer ADMIN_API_KEY` (or `X-Admin-Key` where supported). Send the token only to the exact trusted CommunityLib origin over HTTPS, never to a model prompt or third-party URL.

- `POST /api/ai/extract-text` — persist client-extracted page text; not OCR by itself.
- `POST /api/ai/analyze` — suggest classification from filename and extracted text.
- `POST /api/ai/apply-metadata` — apply reviewed metadata.
- `GET /api/ai/segments/ID` and `POST /api/ai/segments` — inspect/save segmentation suggestions.
- `POST /api/ai/split/ID` and `POST /api/ai/publish-segments/ID` — create/publish derived segments where enabled.
- `POST /api/ai/merge` — merge selected compatible PDFs where enabled.
- `GET /api/ai/jobs` — inspect processing jobs.
- `POST /api/ai/study` — use existing study assistance endpoint.

## ZIP and large-batch workflow

Do not assume that uploading a ZIP to a chat automatically uploads its contents to CommunityLib. If the current AI client cannot invoke the API, ask it to inspect the archive and return a manifest. Before a production bulk import, validate archive paths, entry count, uncompressed size, actual file signatures, duplicates, and resource metadata. The Worker must enforce these checks server-side; AI instructions alone are not a security boundary.

## MCP-capable clients

Configure the remote MCP URL above in the client's supported connector settings and provide the admin token through the client's secure authentication mechanism if administrative tools are needed. Clients that cannot connect to remote MCP can still use this guide as instructions, but cannot perform remote writes unless they have another authorized API-calling capability.


## Backend OCR and bulk ZIP ingestion (CommunityLib 5.0.0)

Use the Cloudflare-native backend described in `processor/README.md`. ZIP archives are submitted to `/api/ocr/v1/ingest/archive` with the admin bearer key; supported files are created as individual resources, processed by the Container OCR workers, then classified by the existing verified-unit pipeline. Do not deploy a Render service.
