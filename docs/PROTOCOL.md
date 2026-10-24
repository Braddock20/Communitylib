# Job protocol v1 and shared module contracts

This is the contract between the Worker (server), the browser processing client,
the optional external processor and the console UI. Everything here is binding.

## 1. Canonical page (wire format)

Defined and validated by `src/lib/shared/canonical.js` (`validatePage`, `buildPage`).
Fields: `location_kind` (page|sheet|slide|section|image|file), `page_number` (1-based),
`label`, `status` (ok|empty|low_text|failed|skipped), `method` (lowercase token such as
`pdf-text`, `ocr`, `docx`, `xlsx`, `pptx`, `csv`, `html`, `text`, `vision`), `text`,
`confidence` (0..1|null), `blocks[]`, `equations[]`, `warnings[]` (codes `^[A-Z][A-Z0-9_]+$`),
`language`, `rotation`, `width`, `height`, `ocr{engine,engine_version,languages,dpi,psm,preprocess,cache_key,cache_hit}`,
`signature` (64 int32 MinHash or null), `error{code,message,retryable}` (required if failed).
The server recomputes char/word counts and text hash, re-runs `assessPage`, and decides
`index_state`. Producers never set those.

Standard warning codes: BLANK_PAGE, LOW_TEXT, LOW_CONFIDENCE, GARBLED_TEXT,
MATH_REGIONS_DETECTED, EQUATIONS_UNVERIFIED, ROTATED_PAGE_CORRECTED, OCR_FALLBACK_USED,
PARTIAL_TEXT_LAYER, TABLE_STRUCTURE_LOST, TRUNCATED, DIAGRAM_PRESENT.

## 2. Job lifecycle (all executors use the same calls)

States: `queued, running, completed, partial, failed, cancelled, retry_wait`.
Auth: `admin` = `Authorization: Bearer <ADMIN_API_KEY>` (or `X-Admin-Key`);
`lease` = `Authorization: Bearer <lease token>` returned by claim (one job only).

| Call | Auth | Body | Result |
|---|---|---|---|
| `POST /api/ai/jobs` | admin | `{resource_id, file_id?, operation, mode?, languages?, pages?, executor?, activate?, idempotency_key?}` | 201 `{job, deduplicated:false}` / 200 `{job, deduplicated:true}` |
| `POST /api/ai/jobs/:id/claim` | admin | `{executor, client?}` | `{lease:{token, expires_at, heartbeat_every_s}, plan}` or 409 |
| `GET  /api/ai/jobs/:id/source` | lease | - | streams the ORIGINAL file (Range supported). Read-only. |
| `POST /api/ai/jobs/:id/pages` | lease | `{pages:[canonical page...], progress?:{stage,done,total}, run?:{page_count,title,language,metadata}}` | `{accepted:[n], rejected:[{page_number,reason}], cancel_requested, lease_expires_at}` (also a heartbeat) |
| `POST /api/ai/jobs/:id/heartbeat` | lease | `{stage?, progress?}` | `{cancel_requested, lease_expires_at}` |
| `POST /api/ai/jobs/:id/complete` | lease | `{}` | `{job, run}`; server aggregates (completed / partial / failed) |
| `POST /api/ai/jobs/:id/fail` | lease | `{code, message, retryable, details?}` | `{job}` (retry_wait with backoff, or failed/dead-lettered) |
| `GET  /api/ai/jobs/:id` | admin | - | `{job, attempts, run}` |
| `POST /api/ai/jobs/:id/cancel` | admin | - | `{job}` (running jobs see `cancel_requested:true` on next call) |
| `POST /api/ai/jobs/:id/retry` | admin | `{mode?}` | `{job}` re-queued (failed/partial/cancelled only) |

`plan` (returned by claim):
```json
{ "job_id":"uuid", "operation":"ocr", "mode":"standard", "languages":["eng"],
  "resource_id":"1", "file":{"id":"1","name":"x.pdf","ext":"pdf","kind":"pdf","size":123,"sha256":"..."},
  "run_id": 7, "pages": null,              // null = all pages; otherwise explicit sorted list
  "existing_pages":[{"page_number":1,"status":"ok","confidence":0.9}],   // pages already stored in this run (skip unless retrying)
  "settings": {"dpi":200,"psm":3,"preprocess":["grayscale","contrast"],"timeout_ms":60000},
  "limits":{"max_pages_per_submission":50,"max_pages_per_run":1000,"max_text_chars":30000},
  "source_url":"/api/ai/jobs/<id>/source" }
```
Rules:
* Submit pages in batches of <= 50 and <= 1.5 MB JSON. Submissions are idempotent per
  `(run, location_kind, page_number)`: resubmitting replaces that page.
* Send a heartbeat (or pages) at least every `heartbeat_every_s` (default 30 s). Lease TTL is 120 s.
* If a response says `cancel_requested:true`, stop and do not call complete.
* A client that cannot finish calls `fail` with `retryable:true`; pages already sent are kept.
* Never send the original file back; derived images/thumbnails are not part of v1 protocol.
* Source files are untrusted: enforce size/page/time limits locally too.

Quality profiles (`mode`): `fast` = text layer only, no OCR (dpi n/a);
`standard` = OCR pages lacking a text layer at 200 dpi; `high` = 300 dpi, psm 3, extra preprocess (denoise, adaptive threshold).
Languages default `["eng"]`.

Error codes producers should use: PASSWORD_PROTECTED, CORRUPT_FILE, UNSUPPORTED_FORMAT, TYPE_MISMATCH,
FILE_TOO_LARGE, TOO_MANY_PAGES, ARCHIVE_UNSAFE, OCR_TIMEOUT, PROVIDER_UNAVAILABLE, INTERNAL_ERROR
(see `ERROR_GUIDE` in `src/lib/jobs/state.js`; the first seven except OCR_TIMEOUT are permanent).

## 3. Shared module APIs (ES modules, no Node-only APIs unless stated)

### `src/lib/shared/zipsafe.js`
```js
export const ZIP_LIMITS = { maxEntries:500, maxEntryBytes:50*2**20, maxTotalBytes:200*2**20, maxRatio:100, maxDepth:2, maxPathChars:240 };
export class ZipSafetyError extends Error { code /* 'ARCHIVE_UNSAFE'|'CORRUPT_FILE' */; reason }
export function safeEntryName(name) // -> normalized relative path or null (rejects ../, absolute, backslash tricks, NUL, drive letters)
export async function openZip(bytes /*Uint8Array*/, limits = ZIP_LIMITS)
  // -> { entries:[{name,size,compressedSize,method,isDirectory,encrypted}], has(name), read(name)->Uint8Array, readText(name)->string }
  // Central-directory reader; inflates with DecompressionStream('deflate-raw') under hard byte caps;
  // rejects zip64 / encrypted / unsupported methods / overlapping or out-of-range entries / ratio bombs.
```
### `src/lib/shared/filetype.js`
```js
export const FILE_TYPES // registry: kind -> {label, exts[], mimes[], operations[], executors:{browser,worker,external}, previewer, converters[]}
export function sniffHeader(bytes, {filename}) // sync, header-only -> {kind, mime, declared_ext, ext_matches, confidence, notes[]}
export async function inspectBytes(bytes, {filename}) // deep (zip central directory, OOXML content types, PDF /Encrypt, page/sheet/slide counts when cheap)
  // -> {kind,mime,declared_ext,ext_matches,size,encrypted,page_count,sheet_count,slide_count,text_layer:'unknown',validation:{ok,errors[],warnings[]}}
export function capabilitiesFor(kind) // -> {operations[], executors[]}
```
`kind` values: pdf, docx, xlsx, pptx, doc, xls, ppt (legacy OLE; external only), csv, tsv, txt, md, html, jpeg, png, webp, zip, unknown.
Mismatch examples that must be reported with `ext_matches:false`: PDF bytes named .docx, ZIP named .pdf, text named .png.

### `src/lib/docparse/index.js`
```js
export async function parseDocument(bytes, { kind, filename, limits }) 
  // kind in docx,xlsx,pptx,csv,tsv,txt,md,html,zip
  // -> { pages:[buildPage(...)], metadata:{title?,author?,created?,...}, warnings:[], extractor:{name,version} }
```
* docx -> `location_kind:'section'`, one page per top-level heading section (or one page if none); blocks: heading(level)/paragraph/list/table.
* xlsx -> `location_kind:'sheet'`, label = sheet name, text = tab-separated rows, table block; formulas: cached value only.
* pptx -> `location_kind:'slide'`, slide title + text + notes (notes appended after `\n\nNotes: `).
* csv/tsv -> `location_kind:'sheet'` single page, RFC-4180 quoting, table block capped by block limits (text capped by page limit).
* html -> sanitized readable text (script/style/iframe/object/event handlers dropped) as `section`s.
* txt/md -> sections split on blank-line-delimited headings (md) or a single section.
* zip -> each supported member parsed recursively (depth limit), `location_kind:'file'`, label = member path; unsupported members get a `skipped` page with warning.
No network, no eval, no external entity resolution. XML parsing is a small hand-written tokenizer (no DOM, no DTD).

### `src/lib/shared/latex.js`
```js
export function sanitizeLatex(src) // -> {ok, latex, errors[]}  (allow-list of commands/environments, length/depth caps; rejects \input,\include,\write,\def,\href,\url,\catcode,...)
```

### Browser client `frontend/console/js/processing/` (ES modules, DOM-optional, injectable engines)
```js
export class BrowserProcessor {
  constructor({ api /* ApiClient */, pdfjs, createOcrEngine /* async ({languages}) -> {recognize(canvasOrImageData,{psm}) -> {text,confidence,lines?}, terminate()} */,
                createCanvas /* (w,h)->canvas-like */, cache /* get/put keyed by ocrCacheKey */, now, parsers /* parseDocument */ })
  async run(jobId, { onProgress, signal })  // claim -> fetch source -> per-page extract (text layer first, OCR only if needed) -> submit batches -> complete
}
```

### External processor `processor/` (Node 20+, uses poppler-utils, qpdf, tesseract, libreoffice)
`POST /v1/jobs` (Bearer `PROCESSOR_TOKEN`) body `{job_id, api_base, lease_token, plan}` -> 202 immediately; runs the job by calling the Worker protocol above
with `lease_token`. `GET /healthz` -> `{ok, tools:{pdftotext,pdftoppm,qpdf,tesseract,soffice}, version}`.
`GET /v1/capabilities` (Bearer) -> formats + versions. Never writes outside its temp dir; deletes it after each job.
