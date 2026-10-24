# CommunityLib remote MCP server

## Endpoint

After deployment, use `https://YOUR-WORKER.workers.dev/mcp` as the remote MCP URL. The endpoint is stateless and accepts JSON-RPC POST requests. `GET /mcp` returns a human-readable discovery manifest, not an SSE stream.

## Supported protocol methods

- `initialize`
- `notifications/initialized` (HTTP 202)
- `notifications/cancelled` (HTTP 202)
- `ping`
- `tools/list`
- `tools/call`

## Available tools

| Tool | Access | Purpose |
|---|---|---|
| `library_health` | Public read | Check Worker liveness |
| `api_capabilities` | Public read | Discover API tool inventory |
| `unit_suggest` | Public read | Autocomplete unit codes/titles |
| `library_search` | Public read | Search units and resources |
| `registry_search` | Public read | Search verified unit registry |
| `resource_inspect` | Public read | Inspect resource and files |
| `resource_preview` | Public read | Preview metadata and snippet |
| `content_search` | Public read | Search extracted pages |
| `document_analyze` | Suggestions | Classify supplied text; does not mutate resources |
| `processing_jobs` | Admin | List processing jobs |
| `resource_extract_text` | Admin | Persist client-extracted text; not OCR |
| `metadata_apply` | Admin | Apply reviewed metadata |
| `segment_list` | Admin | List segmentation suggestions |
| `segment_save` | Admin | Save reviewed segmentation suggestions |
| `pdf_split` | Admin | Create derived PDFs from reviewed ranges |
| `publish_segments` | Admin | Publish generated segments after review |
| `pdf_merge` | Admin | Merge selected compatible PDFs |
| `study_assistant` | Admin | Call the existing study endpoint |

The MCP adapter dispatches to the existing API routes so that route validation, authorization, database operations, and rate limits remain centralized. Do not add an admin token to prompts or a shared guide file. Configure it using the MCP client's secure header/authentication facility and scope it to this Worker only.

## Deployment checks

1. Configure `DATABASE_URL`, B2 secrets, `ADMIN_API_KEY`, and the rate-limit bindings in `wrangler.toml`.
2. Deploy the Worker and confirm `/health`, `/health/db`, `/api/ai/tools`, and `/mcp`.
3. Configure a remote MCP client and verify `initialize` and `tools/list`.
4. Verify a public `library_search` call.
5. Verify an admin tool without credentials returns an authorization error, and with valid credentials succeeds.
6. Confirm the `MCP_LIMITER` Cloudflare rate-limit binding is active. Do not deploy a public MCP endpoint without configured rate-limit bindings.

## Known compatibility boundaries

- This is a stateless Streamable HTTP POST transport; it does not provide an SSE GET stream or long-lived MCP sessions.
- Remote MCP availability differs by AI provider, plan, client, and platform. An instruction file cannot add missing network or tool-calling capabilities to a chat.
- File upload and ZIP extraction are not yet exposed as MCP tools. The current upload API expects multipart form data, while MCP tool arguments are JSON. Do not claim ZIP imports are automated until a separately validated batch-import pipeline is implemented.
