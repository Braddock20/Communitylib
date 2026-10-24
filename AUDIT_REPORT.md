# CommunityLib v4.3.0 — implementation and readiness audit

## Changes made in this pass

- Added a stateless remote MCP JSON-RPC endpoint at `POST /mcp` with `initialize`, `ping`, `tools/list`, and `tools/call`.
- Added `GET /mcp` discovery information for humans and clients that need to inspect available capabilities.
- Added a dedicated `MCP_LIMITER` rate-limit binding (60 requests/minute per client IP); MCP requests fail closed if the binding is missing.
- Added tools for health checks, capability discovery, unit suggestions, library search, registry search, resource inspection/preview, extracted-content search, metadata suggestions, processing-job inspection, reviewed metadata application, text extraction persistence, segmentation, PDF split/publish/merge, and study assistance.
- Kept authorization centralized: administrative MCP calls forward the bearer token to existing protected API routes rather than duplicating authorization logic.
- Added a portable AI guide and MCP deployment/compatibility instructions.
- Added six MCP protocol/unit tests and corrected the root endpoint's fallback version from `4.1.0` to `4.3.0`.

## Verification performed

- `node --check` passed for every JavaScript and MJS file under `src`, `frontend`, `test`, and `scripts`.
- MCP unit tests: 6 passed.
- Full `npm test`: 52 passed, 9 skipped, 0 failed. The skipped tests require a reachable PostgreSQL test database (`PGTEST_URL`).
- Dependency installation timed out in this environment, so the Hono-mounted Worker was not bundled or exercised through Wrangler. The route-level internal dispatch and Cloudflare deployment must still be smoke-tested after dependencies are installed.

## Important gaps still present

1. **ZIP/bulk import is not implemented.** The existing upload route accepts multipart file uploads with common metadata shared by the files; it is not a ZIP extraction/classification/import pipeline. MCP tool arguments are JSON, so direct binary ZIP upload is intentionally not faked as a tool.
2. **Remote MCP is not universal.** Clients must support remote Streamable HTTP MCP and allow configuring the endpoint. The portable guide helps other chats only when they can access URLs/APIs or analyze uploaded files; it cannot add tool-calling/network access to a client that lacks it.
3. **No live deployment validation.** Neon, B2, Cloudflare bindings, cron, and browser OCR were not exercised. Do not run migrations or deploy to a production account until the deployment checklist is followed.
4. **Admin token distribution needs care.** Do not include `ADMIN_API_KEY` in `AI_LIBRARY_GUIDE.md`, prompts, ZIP files, or shared documents. Configure it through a trusted client's secure credential/header mechanism. Consider adding scoped MCP tokens before allowing third-party or shared-user access; current admin calls use the existing all-admin API key.
5. **Some processing capabilities remain browser-driven.** OCR/PDF page extraction still depends on the existing browser processor and configured browser libraries. MCP does not make Cloudflare Workers execute those heavy browser tasks by itself.
6. **Dependency lockfile remains absent.** `npm install` should be run on a network-enabled machine and a lockfile committed before repeatable deployment.

## Deployment smoke test

After configuring secrets and bindings and installing dependencies:

1. Run `npm test` and `npx wrangler deploy` only after reviewing `docs/DEPLOYMENT.md`.
2. Check `/health`, `/health/db`, `/api/ai/tools`, and `/mcp`.
3. Send an MCP `initialize` request, then `tools/list`, then call `library_health` and `unit_suggest`.
4. Confirm an administrative MCP tool without a token returns an authorization error and a valid token is forwarded only to this Worker.
5. Verify the `MCP_LIMITER` binding is active and that logs do not expose credentials.
