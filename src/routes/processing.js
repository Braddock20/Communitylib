// Document-processing API: job protocol v1, runs/pages, activation, review, public
// page reads and page-level full-text search. See docs/PROTOCOL.md.
//
// CPU note (Workers Free = 10 ms CPU/request): handlers only validate, move small JSON
// and delegate all heavy work to Postgres (FTS, ranking, aggregation) or to the client
// that does OCR. No document parsing happens inside the Worker.
import { getDb } from '../db.js';
import { getStorage } from '../storage.js';
import {
  createRouter, json, err, HttpError, readJson, requireAdmin, bearer, sha256Hex, randomToken, validId,
} from '../lib/http.js';
import { validatePage, parsePageSpec, countWords, sha256Hex as textHash, settingsHash, PAGE_LIMITS } from '../lib/shared/canonical.js';
import { assessPage, indexDecision, summarizeQuality } from '../lib/shared/textquality.js';
import { aggregateRun, failureOutcome, dedupeKey, requestHash, normalizeState, PERMANENT_ERROR_CODES, ERROR_GUIDE } from '../lib/jobs/state.js';
import { classifyDocumentEvidence, inferDocumentType } from '../utils/ai-classification.js';

const LEASE_SECONDS = 120;
const HEARTBEAT_SECONDS = 30;
const OPERATIONS = ['extract', 'ocr', 'reprocess'];
const MODES = {
  fast: { ocr: false, dpi: null, psm: null, preprocess: [], timeout_ms: 30000 },
  standard: { ocr: true, dpi: 200, psm: 3, preprocess: ['grayscale', 'contrast'], timeout_ms: 60000 },
  high: { ocr: true, dpi: 300, psm: 3, preprocess: ['grayscale', 'contrast', 'denoise', 'threshold', 'deskew'], timeout_ms: 120000 },
};
// Browser processing stays deliberately small; the Cloudflare Container handles heavier formats.
const BROWSER_KINDS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt']);
const EXTERNAL_KINDS = new Set(['pdf','png','jpg','jpeg','webp','tif','tiff','bmp','gif','txt','md','markdown','csv','tsv','html','htm','json','xml','yaml','yml','log','ini','rtf','doc','docx','ppt','pptx','xls','xlsx','odt','ods','odp','epub','eml']);
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain; charset=utf-8', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', gif: 'image/gif' };
const EXTERNAL_MIME = Object.fromEntries([...EXTERNAL_KINDS].map((ext) => [ext, ({txt:'text/plain; charset=utf-8',md:'text/markdown',markdown:'text/markdown',csv:'text/csv',tsv:'text/tab-separated-values',html:'text/html',htm:'text/html',json:'application/json',xml:'application/xml',yaml:'text/yaml',yml:'text/yaml',log:'text/plain',ini:'text/plain',rtf:'application/rtf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',odt:'application/vnd.oasis.opendocument.text',ods:'application/vnd.oasis.opendocument.spreadsheet',odp:'application/vnd.oasis.opendocument.presentation',epub:'application/epub+zip',eml:'message/rfc822'})[ext] || MIME[ext] || 'application/octet-stream']));

function keyFromUrl(fileUrl) {
  const marker = '/api/files/';
  const i = String(fileUrl || '').indexOf(marker);
  if (i < 0) return null;
  try { return decodeURIComponent(String(fileUrl).slice(i + marker.length).split('?')[0]); } catch { return null; }
}

async function audit(sql, c, actor, action, entityType, entityId, details = {}) {
  await sql`INSERT INTO ai_audit_log(action,actor,actor_role,entity_type,entity_id,details,request_id)
    VALUES(${action},${actor.actor},${actor.role},${entityType},${String(entityId)},${JSON.stringify(details)}::jsonb,${c.requestId})`;
}

function publicJob(j) {
  if (!j) return j;
  const { lease_token_hash, request_hash, ...rest } = j;
  return { ...rest, state: normalizeState(j.status) };
}

async function leaseJob(c, sql) {
  const token = bearer(c.req);
  if (!token) throw new HttpError(401, 'unauthorized', 'lease token required');
  const hash = await sha256Hex(token);
  const [job] = await sql`SELECT * FROM document_processing_jobs WHERE id=${c.params.id}::uuid AND lease_token_hash=${hash}`;
  if (!job) throw new HttpError(401, 'unauthorized', 'invalid lease token');
  if (job.status !== 'running') throw new HttpError(409, 'job_not_running', `job is ${job.status}`);
  if (new Date(job.lease_expires_at).getTime() < Date.now()) throw new HttpError(409, 'lease_expired', 'lease expired; claim the job again');
  return job;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkJobId(c) { if (!UUID_RE.test(c.params.id)) throw new HttpError(400, 'invalid_id', 'invalid job id'); }

async function refreshIndexState(sql, resourceId) {
  await sql`
    INSERT INTO search_index_state(resource_id, active_run_id, pages_indexed, pages_held, last_indexed_at)
    SELECT ${resourceId}, (SELECT id FROM extraction_runs WHERE resource_id=${resourceId} AND is_active LIMIT 1),
      count(*) FILTER (WHERE index_state='indexed' AND is_active), count(*) FILTER (WHERE index_state='held' AND is_active), now()
    FROM extraction_pages WHERE resource_id=${resourceId}
    ON CONFLICT (resource_id) DO UPDATE SET active_run_id=EXCLUDED.active_run_id, pages_indexed=EXCLUDED.pages_indexed,
      pages_held=EXCLUDED.pages_held, last_indexed_at=now()`;
}

function highlightToHtml(s) {
  const esc = String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return esc.replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>');
}

export function createProcessingRouter() {
  const r = createRouter();

  // ------------------------------------------------------------ capabilities (public, no secrets)
  r.add('GET', '/api/ai/processing/capabilities', async (c) => json({
    release: '4.4.0',
    executors: { browser: { available: true, kinds: [...BROWSER_KINDS], note: 'legacy manual processor' },
      external: { available: Boolean(c.env.PROCESSOR_SHARED_SECRET), kinds: [...EXTERNAL_KINDS], note: 'Cloudflare Container: OCR, Office conversion and text extraction' },
      worker: { available: false, note: 'Workers Free CPU budget is too small for document parsing' } },
    operations: OPERATIONS, modes: MODES,
    limits: { max_pages_per_submission: PAGE_LIMITS.maxPagesPerSubmission, max_pages_per_run: PAGE_LIMITS.maxPagesPerRun, max_text_chars_per_page: PAGE_LIMITS.maxTextChars },
    unsupported_in_this_release: ['zip as a single resource (use /api/ocr/v1/ingest/archive; nested ZIPs are unpacked safely)'],
    math: 'Equation regions are flagged for review; no LaTeX is generated or verified automatically.',
  }));

  r.add('GET', '/api/ai/processing/health', async (c) => {
    requireAdmin(c);
    const sql = await getDb(c.env);
    const jobs = await sql`SELECT status, count(*)::int AS n FROM document_processing_jobs GROUP BY status`;
    const [stale] = await sql`SELECT count(*)::int AS n FROM document_processing_jobs WHERE status='running' AND lease_expires_at < now()`;
    const [usage] = await sql`SELECT count(*)::int AS pages FROM extraction_pages WHERE created_at > now() - interval '1 day'`;
    return json({ ok: true, jobs_by_status: Object.fromEntries(jobs.map((j) => [j.status, j.n])), stale_running_jobs: stale.n, pages_last_24h: usage.pages,
      error_guide: ERROR_GUIDE });
  });

  // ------------------------------------------------------------ jobs
  r.add('POST', '/api/ai/jobs', async (c) => {
    const actor = requireAdmin(c);
    const body = await readJson(c.req);
    const sql = await getDb(c.env);
    const operation = String(body.operation || 'extract');
    const mode = String(body.mode || 'standard');
    if (!OPERATIONS.includes(operation)) throw new HttpError(400, 'invalid_operation', `operation must be one of ${OPERATIONS.join(', ')}`);
    if (!MODES[mode]) throw new HttpError(400, 'invalid_mode', `mode must be one of ${Object.keys(MODES).join(', ')}`);
    if (!validId(body.resource_id)) throw new HttpError(400, 'invalid_resource_id', 'resource_id required');
    const executor = String(body.executor || 'external');
    if (!['browser', 'external'].includes(executor) || (executor === 'external' && !c.env.PROCESSOR_SHARED_SECRET)) throw new HttpError(400, 'executor_not_available', 'requested processor is not configured');
    const languages = Array.isArray(body.languages) && body.languages.length ? body.languages.map((l) => String(l).replace(/[^a-z_]/gi, '').slice(0, 8)).filter(Boolean).slice(0, 4) : ['eng'];
    let pages = null;
    if (body.pages != null && body.pages !== '') {
      try { pages = parsePageSpec(body.pages); } catch (e) { throw new HttpError(400, 'invalid_pages', e.message); }
    }

    const [resource] = await sql`SELECT id, is_flagged FROM resources WHERE id=${body.resource_id}`;
    if (!resource || resource.is_flagged) throw new HttpError(404, 'resource_not_found', 'resource not found or unavailable');
    const files = await sql`SELECT id, file_ext, file_hash FROM resource_files WHERE resource_id=${body.resource_id} ORDER BY order_index`;
    let file;
    if (body.file_id != null) file = files.find((f) => String(f.id) === String(body.file_id));
    else if (files.length === 1) file = files[0];
    else throw new HttpError(409, 'file_id_required', 'resource has several files; specify file_id');
    if (!file) throw new HttpError(404, 'file_not_found', 'file not found in this resource');
    const ext = String(file.file_ext).toLowerCase();
    const supportedKinds = executor === 'external' ? EXTERNAL_KINDS : BROWSER_KINDS;
    if (!supportedKinds.has(ext)) throw new HttpError(422, 'UNSUPPORTED_FORMAT', `.${ext} files cannot be processed by the selected executor`, { guide: ERROR_GUIDE.UNSUPPORTED_FORMAT });

    const settings = { mode, languages, ...MODES[mode], pages, activate: Boolean(body.activate), ...(body.run_id ? { run_id: String(body.run_id) } : {}) };
    const dKey = await dedupeKey({ resource_id: body.resource_id, file_id: file.id, operation, settings: { mode, languages }, pages });
    const idem = body.idempotency_key ? String(body.idempotency_key).slice(0, 128) : null;
    const rHash = await requestHash({ r: body.resource_id, f: String(file.id), operation, mode, languages, pages, a: Boolean(body.activate) });

    const [created] = await sql`
      INSERT INTO document_processing_jobs(resource_id,file_id,job_type,operation,executor,status,input_json,settings,dedupe_key,idempotency_key,request_hash,requested_by,request_id,pages_total)
      VALUES(${body.resource_id},${file.id},${operation},${operation},${executor},'queued',${JSON.stringify({ source_sha256: file.file_hash })}::jsonb,${JSON.stringify(settings)}::jsonb,
        ${dKey},${idem},${rHash},${actor.actor},${c.requestId},${pages ? pages.length : null})
      ON CONFLICT DO NOTHING RETURNING *`;
    if (created) {
      await audit(sql, c, actor, 'job_created', 'job', created.id, { resource_id: body.resource_id, operation, mode });
      return json({ job: publicJob(created), deduplicated: false }, 201);
    }
    if (idem) {
      const [byKey] = await sql`SELECT * FROM document_processing_jobs WHERE idempotency_key=${idem}`;
      if (byKey) {
        if (byKey.request_hash !== rHash) throw new HttpError(422, 'idempotency_conflict', 'idempotency_key was used with a different request');
        return json({ job: publicJob(byKey), deduplicated: true }, 200);
      }
    }
    const [active] = await sql`SELECT * FROM document_processing_jobs WHERE dedupe_key=${dKey} AND status IN ('queued','running','retry_wait')`;
    if (active) return json({ job: publicJob(active), deduplicated: true }, 200);
    throw new HttpError(409, 'job_conflict', 'could not create job; retry');
  });

  r.add('GET', '/api/ai/jobs', async (c) => {
    requireAdmin(c);
    const sql = await getDb(c.env);
    const status = (c.url.searchParams.get('status') || '').trim();
    const resourceId = c.url.searchParams.get('resource_id');
    const limit = Math.min(100, Math.max(1, Number(c.url.searchParams.get('limit')) || 50));
    const before = c.url.searchParams.get('before'); // ISO created_at cursor
    const rows = await sql`
      SELECT * FROM document_processing_jobs
      WHERE (${status} = '' OR status = ${status})
        AND (${resourceId || ''} = '' OR resource_id = NULLIF(${resourceId || ''}, '')::bigint)
        AND (${before || ''} = '' OR created_at < NULLIF(${before || ''}, '')::timestamptz)
      ORDER BY created_at DESC LIMIT ${limit}`;
    return json({ jobs: rows.map(publicJob), next_before: rows.length === limit ? rows[rows.length - 1].created_at : null });
  });

  r.add('GET', '/api/ai/jobs/:id', async (c) => {
    requireAdmin(c); checkJobId(c);
    const sql = await getDb(c.env);
    const [job] = await sql`SELECT * FROM document_processing_jobs WHERE id=${c.params.id}::uuid`;
    if (!job) throw new HttpError(404, 'not_found', 'job not found');
    const attempts = await sql`SELECT attempt_no, executor, client, started_at, finished_at, outcome, error_code, error_message, duration_ms FROM job_attempts WHERE job_id=${job.id} ORDER BY attempt_no`;
    const [run] = job.run_id ? await sql`SELECT * FROM extraction_runs WHERE id=${job.run_id}` : [null];
    const guide = job.error_code ? ERROR_GUIDE[job.error_code] || null : null;
    return json({ job: publicJob(job), attempts, run: run || null, guide });
  });

  r.add('POST', '/api/ai/jobs/:id/claim', async (c) => {
    const actor = requireAdmin(c); checkJobId(c);
    const body = await readJson(c.req);
    const sql = await getDb(c.env);
    const token = randomToken();
    const hash = await sha256Hex(token);
    const clientName = String(body.client?.name || 'browser').slice(0, 60);
    const executor = String(body.executor || body.client?.executor || 'browser');
    if (!['browser','external'].includes(executor)) throw new HttpError(400, 'invalid_executor', 'invalid processor executor');
    if (executor === 'external' && !c.env.PROCESSOR_SHARED_SECRET) throw new HttpError(503, 'processor_not_configured', 'backend processor is not configured');
    if (executor === 'external' && c.req.header('x-processor-key') !== c.env.PROCESSOR_SHARED_SECRET) throw new HttpError(401, 'processor_unauthorized', 'backend processor authentication failed');
    const [job] = await sql`
      UPDATE document_processing_jobs SET status='running', attempts=attempts+1, started_at=COALESCE(started_at, now()),
        lease_token_hash=${hash}, lease_expires_at=now() + make_interval(secs => ${LEASE_SECONDS}), heartbeat_at=now(),
        leased_by=${clientName}, stage='claimed', updated_at=now(), error_code=NULL, error_message=NULL
      WHERE id=${c.params.id}::uuid AND cancel_requested_at IS NULL AND executor=${executor}
        AND ((status IN ('queued','retry_wait') AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
             OR (status='running' AND lease_expires_at < now()))
      RETURNING *`;
    if (!job) {
      const [cur] = await sql`SELECT status, cancel_requested_at FROM document_processing_jobs WHERE id=${c.params.id}::uuid`;
      if (!cur) throw new HttpError(404, 'not_found', 'job not found');
      throw new HttpError(409, 'not_claimable', `job is ${cur.status}${cur.cancel_requested_at ? ' (cancel requested)' : ''}`);
    }
    await sql`INSERT INTO job_attempts(job_id,attempt_no,executor,client) VALUES(${job.id},${job.attempts},${executor},${clientName}) ON CONFLICT (job_id, attempt_no) DO NOTHING`;

    const [file] = await sql`SELECT id, file_name, file_ext, file_size_bytes, file_hash FROM resource_files WHERE id=${job.file_id}`;
    if (!file) throw new HttpError(404, 'file_not_found', 'file no longer exists');
    let runId = job.run_id || job.settings?.run_id || null;
    if (!runId) {
      const sh = await settingsHash({ mode: job.settings.mode, languages: job.settings.languages });
      const [run] = await sql`
        INSERT INTO extraction_runs(resource_id,file_id,job_id,source_sha256,source_size,source_kind,executor,extractor,extractor_version,settings,settings_hash,created_by)
        VALUES(${job.resource_id},${file.id},${job.id},${file.file_hash},${file.file_size_bytes},${String(file.file_ext).toLowerCase()},${executor},
          ${String(body.client?.extractor || 'pdfjs+tesseract.js').slice(0, 60)},${String(body.client?.version || 'unknown').slice(0, 40)},
          ${JSON.stringify({ mode: job.settings.mode, languages: job.settings.languages, dpi: job.settings.dpi, psm: job.settings.psm, preprocess: job.settings.preprocess })}::jsonb,
          ${sh},${actor.actor}) RETURNING id`;
      runId = run.id;
    }
    await sql`UPDATE document_processing_jobs SET run_id=${runId} WHERE id=${job.id}`;
    const existing = await sql`SELECT page_number, status, confidence FROM extraction_pages WHERE run_id=${runId} AND location_kind='page' ORDER BY page_number`;
    const s = job.settings || {};
    return json({
      lease: { token, expires_at: job.lease_expires_at, heartbeat_every_s: HEARTBEAT_SECONDS },
      plan: {
        job_id: job.id, operation: job.operation, mode: s.mode, languages: s.languages, resource_id: String(job.resource_id),
        file: { id: String(file.id), name: file.file_name, ext: file.file_ext, kind: String(file.file_ext).toLowerCase(), size: file.file_size_bytes == null ? null : Number(file.file_size_bytes), sha256: file.file_hash },
        run_id: String(runId), pages: s.pages || null,
        existing_pages: existing.map((p) => ({ page_number: p.page_number, status: p.status, confidence: p.confidence == null ? null : Number(p.confidence) })),
        settings: { dpi: s.dpi, psm: s.psm, preprocess: s.preprocess, ocr: s.ocr, timeout_ms: s.timeout_ms },
        limits: { max_pages_per_submission: PAGE_LIMITS.maxPagesPerSubmission, max_pages_per_run: PAGE_LIMITS.maxPagesPerRun, max_text_chars: PAGE_LIMITS.maxTextChars },
        source_url: `/api/ai/jobs/${job.id}/source`,
      },
    });
  });

  r.add('GET', '/api/ai/jobs/:id/source', async (c) => {
    checkJobId(c);
    const sql = await getDb(c.env);
    const job = await leaseJob(c, sql);
    const [file] = await sql`SELECT file_url, file_ext FROM resource_files WHERE id=${job.file_id}`;
    const key = file && keyFromUrl(file.file_url);
    if (!key) throw new HttpError(404, 'file_not_found', 'source file unavailable');
    const upstream = await getStorage(c.env).fetchObject(key, c.req.headers.get('range') || undefined);
    if (!upstream.ok && upstream.status !== 206) throw new HttpError(502, 'storage_unavailable', 'source file unavailable');
    const h = new Headers();
    for (const n of ['content-length', 'content-range', 'accept-ranges']) { const v = upstream.headers.get(n); if (v) h.set(n, v); }
    h.set('content-type', EXTERNAL_MIME[String(file.file_ext).toLowerCase()] || MIME[String(file.file_ext).toLowerCase()] || 'application/octet-stream');
    h.set('x-content-type-options', 'nosniff');
    h.set('cache-control', 'private, no-store');
    return new Response(upstream.body, { status: upstream.status, headers: h });
  });

  r.add('POST', '/api/ai/jobs/:id/pages', async (c) => {
    checkJobId(c);
    const sql = await getDb(c.env);
    const job = await leaseJob(c, sql);
    const body = await readJson(c.req, { maxBytes: 2 * 1024 * 1024 });
    if (!Array.isArray(body.pages) || body.pages.length < 1 || body.pages.length > PAGE_LIMITS.maxPagesPerSubmission) {
      throw new HttpError(400, 'invalid_pages', `pages must contain 1-${PAGE_LIMITS.maxPagesPerSubmission} entries`);
    }
    if (job.cancel_requested_at) return json({ accepted: [], rejected: [], cancel_requested: true, lease_expires_at: job.lease_expires_at });
    const [run] = await sql`SELECT id, is_active, page_count FROM extraction_runs WHERE id=${job.run_id}`;
    const allowed = job.settings?.pages ? new Set(job.settings.pages) : null;
    const accepted = []; const rejected = [];
    const statements = [];
    for (const raw of body.pages) {
      const v = validatePage(raw);
      if (!v.ok) { rejected.push({ page_number: Number(raw?.page_number) || null, reason: v.errors.join('; ') }); continue; }
      const p = v.page;
      if (allowed && p.location_kind === 'page' && !allowed.has(p.page_number)) { rejected.push({ page_number: p.page_number, reason: 'page not part of this job' }); continue; }
      const a = assessPage({ text: p.text, confidence: p.confidence, method: p.method, claimedStatus: p.status });
      const warnings = [...new Set([...p.warnings, ...a.warnings])];
      const status = p.status === 'ok' || p.status === 'empty' || p.status === 'low_text' ? a.status : p.status;
      const decision = indexDecision({ status, warnings });
      const reviewState = decision.index_state === 'held' ? 'needs_review' : 'none';
      const hash = p.text ? await textHash(p.text) : null;
      statements.push(sql`
        INSERT INTO extraction_pages(run_id,location_kind,page_number,resource_id,file_id,label,status,method,text,char_count,word_count,confidence,blocks,warnings,
          language,rotation,width,height,text_sha256,ocr,signature,index_state,review_state,error,is_active)
        VALUES(${job.run_id},${p.location_kind},${p.page_number},${job.resource_id},${job.file_id},${p.label},${status},${p.method},${p.text},${p.text.length},${countWords(p.text)},
          ${p.confidence},${JSON.stringify(p.blocks)}::jsonb,${JSON.stringify(warnings)}::jsonb,${p.language},${p.rotation},${p.width},${p.height},${hash},
          ${p.ocr ? JSON.stringify(p.ocr) : null}::jsonb,${p.signature},${decision.index_state},${reviewState},${p.error ? JSON.stringify(p.error) : null}::jsonb,${Boolean(run?.is_active)})
        ON CONFLICT (run_id,location_kind,page_number) DO UPDATE SET label=EXCLUDED.label,status=EXCLUDED.status,method=EXCLUDED.method,text=EXCLUDED.text,
          corrected_text=NULL,char_count=EXCLUDED.char_count,word_count=EXCLUDED.word_count,confidence=EXCLUDED.confidence,blocks=EXCLUDED.blocks,warnings=EXCLUDED.warnings,
          language=EXCLUDED.language,rotation=EXCLUDED.rotation,width=EXCLUDED.width,height=EXCLUDED.height,text_sha256=EXCLUDED.text_sha256,ocr=EXCLUDED.ocr,
          signature=EXCLUDED.signature,index_state=EXCLUDED.index_state,review_state=EXCLUDED.review_state,reviewed_by=NULL,reviewed_at=NULL,error=EXCLUDED.error,updated_at=now()`);
      statements.push(sql`DELETE FROM page_equations WHERE run_id=${job.run_id} AND location_kind=${p.location_kind} AND page_number=${p.page_number}`);
      for (const eq of p.equations) {
        statements.push(sql`INSERT INTO page_equations(run_id,location_kind,page_number,idx,bbox,source_text,latex,latex_valid,engine,confidence,status,warnings)
          VALUES(${job.run_id},${p.location_kind},${p.page_number},${eq.idx},${eq.bbox ? JSON.stringify(eq.bbox) : null}::jsonb,${eq.source_text},NULL,false,${eq.engine},${eq.confidence},'needs_review',${JSON.stringify(eq.warnings)}::jsonb)`);
      }
      accepted.push(p.page_number);
    }
    const progress = body.progress && typeof body.progress === 'object' ? body.progress : {};
    const pageCount = Number.isInteger(body.run?.page_count) && body.run.page_count > 0 && body.run.page_count <= PAGE_LIMITS.maxPagesPerRun ? body.run.page_count : null;
    const stage = String(progress.stage || 'extracting').slice(0, 40);
    if (statements.length) await sql.transaction(statements);
    if (pageCount) {
      await sql`UPDATE extraction_runs SET page_count=${pageCount},
        title=COALESCE(${body.run?.title ? String(body.run.title).slice(0, 300) : null}, title),
        language=COALESCE(${body.run?.language ? String(body.run.language).slice(0, 12) : null}, language) WHERE id=${job.run_id}`;
    }
    const [upd] = await sql`
      UPDATE document_processing_jobs SET
        pages_done=(SELECT count(*)::int FROM extraction_pages WHERE run_id=${job.run_id} AND status<>'failed'),
        pages_failed=(SELECT count(*)::int FROM extraction_pages WHERE run_id=${job.run_id} AND status='failed'),
        pages_total=COALESCE(${pageCount}, pages_total), stage=${stage},
        progress=LEAST(1, COALESCE((SELECT count(*)::numeric FROM extraction_pages WHERE run_id=${job.run_id}) / NULLIF(COALESCE(${pageCount}, pages_total, ${Number(progress.total) || null}), 0), 0)),
        heartbeat_at=now(), lease_expires_at=now() + make_interval(secs => ${LEASE_SECONDS}), updated_at=now()
      WHERE id=${job.id} RETURNING lease_expires_at, cancel_requested_at`;
    return json({ accepted, rejected, cancel_requested: Boolean(upd.cancel_requested_at), lease_expires_at: upd.lease_expires_at });
  });

  r.add('POST', '/api/ai/jobs/:id/heartbeat', async (c) => {
    checkJobId(c);
    const sql = await getDb(c.env);
    const job = await leaseJob(c, sql);
    const body = await readJson(c.req);
    const [u] = await sql`UPDATE document_processing_jobs SET heartbeat_at=now(), lease_expires_at=now() + make_interval(secs => ${LEASE_SECONDS}),
      stage=COALESCE(${body.stage ? String(body.stage).slice(0, 40) : null}, stage), updated_at=now() WHERE id=${job.id} RETURNING lease_expires_at, cancel_requested_at`;
    return json({ cancel_requested: Boolean(u.cancel_requested_at), lease_expires_at: u.lease_expires_at });
  });

  r.add('POST', '/api/ai/jobs/:id/complete', async (c) => {
    checkJobId(c);
    const sql = await getDb(c.env);
    const job = await leaseJob(c, sql);
    if (job.cancel_requested_at) throw new HttpError(409, 'cancel_requested', 'job was cancelled');
    const [run] = await sql`SELECT * FROM extraction_runs WHERE id=${job.run_id}`;
    const pages = await sql`SELECT status, index_state, warnings, confidence FROM extraction_pages WHERE run_id=${run.id}`;
    const agg = aggregateRun(pages, { expectedPages: run.page_count });
    const q = summarizeQuality(pages);
    const runWarnings = agg.warnings;
    const err_ = agg.status === 'failed' ? { code: agg.code, guide: ERROR_GUIDE[agg.code] || null } : null;
    await sql.transaction([
      sql`UPDATE extraction_runs SET status=${agg.status}, completed_at=now(), pages_ok=${q.pages_ok}, pages_empty=${q.pages_empty}, pages_failed=${q.pages_failed},
          pages_held=${q.pages_held}, avg_confidence=${q.avg_confidence}, quality=${q.quality}, warnings=${JSON.stringify(runWarnings)}::jsonb,
          error_code=${agg.status === 'failed' ? agg.code : null}, error_details=${err_ ? JSON.stringify(err_) : null}::jsonb WHERE id=${run.id}`,
      sql`UPDATE document_processing_jobs SET status=${agg.status}, completed_at=now(), progress=1, stage='done', lease_token_hash=NULL, lease_expires_at=NULL,
          error_code=${agg.status === 'failed' ? agg.code : null}, error_message=${agg.status === 'failed' ? (ERROR_GUIDE[agg.code]?.message || agg.code) : null},
          result_json=${JSON.stringify({ code: agg.code, quality: q.quality, pages: q })}::jsonb, updated_at=now() WHERE id=${job.id}`,
      sql`UPDATE job_attempts SET finished_at=now(), outcome=${agg.status === 'completed' ? 'success' : agg.status === 'partial' ? 'partial' : 'failed'},
          error_code=${agg.status === 'failed' ? agg.code : null}, duration_ms=(extract(epoch FROM (now()-started_at))*1000)::int WHERE job_id=${job.id} AND attempt_no=${job.attempts}`,
    ]);
    // Deterministic classification runs on the server from persisted extracted text.
    // Only a single strong body match may change the canonical unit; multi-unit and
    // weak cases retain the uploader's fallback and are surfaced for review.
    if (agg.status !== 'failed') {
      try {
        const [resource] = await sql`SELECT id, title, type, academic_year, unit_id FROM resources WHERE id=${job.resource_id}`;
        const [file] = await sql`SELECT file_name FROM resource_files WHERE id=${job.file_id}`;
        const pageRows = await sql`SELECT text FROM extraction_pages WHERE run_id=${run.id} AND status IN ('ok','low_text') ORDER BY page_number`;
        const documentText = pageRows.map((p) => p.text || '').join('\n').slice(0, 250000);
        const registry = await sql`SELECT u.id, u.code, u.code_display, u.title, COALESCE(a.aliases, ARRAY[]::text[]) AS aliases
          FROM units u LEFT JOIN (SELECT unit_id, array_agg(alias ORDER BY alias) AS aliases FROM unit_aliases GROUP BY unit_id) a ON a.unit_id=u.id
          WHERE u.code <> 'UNCLASSIFIED' ORDER BY u.code`;
        const classification = classifyDocumentEvidence({ text: documentText, filename: file?.file_name || resource?.title || '', registry });
        const inferredType = inferDocumentType(documentText, file?.file_name || resource?.title || '');
        const primary = classification.primary_unit;
        const mayAssignUnit = !classification.multi_unit && primary && ['strong','moderate'].includes(classification.evidence_tier) && classification.evidence_tier === 'strong';
        const type = ['notes','cat','exam','assignment','other'].includes(inferredType) ? inferredType : resource.type;
        const topics = classification.topics || [];
        const filenameYear = String(file?.file_name || '').match(/\b(19\d{2}|20\d{2})\b/);
        const bodyYear = ['cat', 'exam'].includes(type) ? documentText.match(/\b(19\d{2}|20\d{2})\b/) : null;
        const yearMatch = filenameYear || bodyYear;
        const inferredYear = yearMatch ? Number(yearMatch[1]) : resource.academic_year;
        if (mayAssignUnit) {
          await sql`UPDATE resources SET unit_id=${primary.id}, type=${type}::resource_type,
            academic_year=${inferredYear}, topics=${topics},
            title=CASE WHEN title LIKE 'Unclassified - %' THEN ${String(file?.file_name || resource.title).replace(/\.[^.]+$/, '').slice(0,180)} ELSE title END
            WHERE id=${job.resource_id}`;
          await sql`UPDATE units SET resource_count=GREATEST(0, resource_count-1) WHERE id=${resource.unit_id} AND id <> ${primary.id}`;
          await sql`UPDATE units SET resource_count=(SELECT count(*)::int FROM resources WHERE unit_id=${primary.id}) WHERE id=${primary.id}`;
        } else {
          await sql`UPDATE resources SET type=${type}::resource_type, academic_year=${inferredYear}, topics=${topics} WHERE id=${job.resource_id}`;
        }
        await sql`INSERT INTO ai_audit_log(action,actor,entity_type,entity_id,details)
          VALUES('document_classified','backend-processor','resource',${String(job.resource_id)},${JSON.stringify({detected_units:classification.detected_units,primary_unit:classification.primary_unit?.code || null,multi_unit:classification.multi_unit,evidence_tier:classification.evidence_tier,filename_conflict:classification.filename_conflict,topics:classification.topics,type,academic_year:inferredYear,assigned_unit:Boolean(mayAssignUnit)})}::jsonb)`;
      } catch (classificationError) {
        console.error('post-extraction classification failed', { job_id: job.id, message: classificationError?.message || String(classificationError) });
      }
    }
    await sql`UPDATE resources SET processing_status=${agg.status === 'failed' ? 'failed' : agg.status === 'partial' ? 'needs_review' : 'ready'} WHERE id=${job.resource_id}`;
    await sql`UPDATE resource_files SET processing_status=${agg.status === 'failed' ? 'failed' : agg.status === 'partial' ? 'needs_review' : 'ready'} WHERE id=${job.file_id}`;
    let activated = false;
    if ((job.settings?.activate || job.executor === 'external') && agg.status !== 'failed') {
      const [hasActive] = await sql`SELECT 1 AS x FROM extraction_runs WHERE file_id=${run.file_id} AND is_active`;
      if (!hasActive) { await activateRun(sql, run.id, { actor: 'admin', role: 'admin' }, c); activated = true; }
    }
    await audit(sql, c, { actor: 'job:' + job.id, role: 'lease' }, 'job_completed', 'job', job.id, { status: agg.status, code: agg.code, quality: q.quality, activated });
    const [finalJob] = await sql`SELECT * FROM document_processing_jobs WHERE id=${job.id}`;
    const [finalRun] = await sql`SELECT * FROM extraction_runs WHERE id=${run.id}`;
    return json({ job: publicJob(finalJob), run: finalRun, activated });
  });

  r.add('POST', '/api/ai/jobs/:id/fail', async (c) => {
    checkJobId(c);
    const sql = await getDb(c.env);
    const job = await leaseJob(c, sql);
    const body = await readJson(c.req);
    const code = /^[A-Z][A-Z0-9_]{1,39}$/.test(body.code || '') ? body.code : 'INTERNAL_ERROR';
    const message = String(body.message || ERROR_GUIDE[code]?.message || 'Processing failed').slice(0, 300);
    const retryable = body.retryable !== false && !PERMANENT_ERROR_CODES.includes(code);
    const out = failureOutcome({ attempts: job.attempts, max_attempts: job.max_attempts, retryable });
    await sql.transaction([
      sql`UPDATE document_processing_jobs SET status=${out.status}, error_code=${code}, error_message=${message}, lease_token_hash=NULL, lease_expires_at=NULL,
          next_attempt_at=${out.delay_ms ? new Date(Date.now() + out.delay_ms).toISOString() : null}, dead_lettered_at=${out.dead_letter ? new Date().toISOString() : null},
          completed_at=${out.status === 'failed' ? new Date().toISOString() : null}, error_details=${body.details ? JSON.stringify(body.details).slice(0, 2000) : null}::jsonb, updated_at=now() WHERE id=${job.id}`,
      sql`UPDATE job_attempts SET finished_at=now(), outcome='failed', error_code=${code}, error_message=${message}, duration_ms=(extract(epoch FROM (now()-started_at))*1000)::int
          WHERE job_id=${job.id} AND attempt_no=${job.attempts}`,
      sql`UPDATE extraction_runs SET status=${out.status === 'failed' ? 'failed' : 'running'}, error_code=${out.status === 'failed' ? code : null} WHERE id=${job.run_id}`,
    ]);
    if (out.status === 'failed') {
      await sql`UPDATE resources SET processing_status='failed' WHERE id=${job.resource_id}`;
      await sql`UPDATE resource_files SET processing_status='failed' WHERE id=${job.file_id}`;
    }
    const [j] = await sql`SELECT * FROM document_processing_jobs WHERE id=${job.id}`;
    return json({ job: publicJob(j), guide: ERROR_GUIDE[code] || null });
  });

  r.add('POST', '/api/ai/jobs/:id/cancel', async (c) => {
    const actor = requireAdmin(c); checkJobId(c);
    const sql = await getDb(c.env);
    const [j] = await sql`
      UPDATE document_processing_jobs SET cancel_requested_at=now(),
        status=CASE WHEN status IN ('queued','retry_wait') THEN 'cancelled' ELSE status END,
        completed_at=CASE WHEN status IN ('queued','retry_wait') THEN now() ELSE completed_at END, updated_at=now()
      WHERE id=${c.params.id}::uuid AND status IN ('queued','retry_wait','running') RETURNING *`;
    if (!j) throw new HttpError(409, 'not_cancellable', 'job is not active');
    await audit(sql, c, actor, 'job_cancel_requested', 'job', j.id, {});
    return json({ job: publicJob(j) });
  });

  r.add('POST', '/api/ai/jobs/:id/retry', async (c) => {
    const actor = requireAdmin(c); checkJobId(c);
    const sql = await getDb(c.env);
    let j;
    try {
      [j] = await sql`
        UPDATE document_processing_jobs SET status='queued', cancel_requested_at=NULL, next_attempt_at=NULL, completed_at=NULL, dead_lettered_at=NULL,
          error_code=NULL, error_message=NULL, attempts=0, max_attempts=GREATEST(max_attempts,1), updated_at=now()
        WHERE id=${c.params.id}::uuid AND status IN ('failed','partial','cancelled') RETURNING *`;
    } catch (e) {
      if (e?.code === '23505') throw new HttpError(409, 'job_conflict', 'an identical job is already active');
      throw e;
    }
    if (!j) throw new HttpError(409, 'not_retryable', 'only failed, partial or cancelled jobs can be retried');
    await audit(sql, c, actor, 'job_retried', 'job', j.id, {});
    return json({ job: publicJob(j) });
  });

  // ------------------------------------------------------------ runs / pages (admin)
  r.add('GET', '/api/ai/resources/:id/runs', async (c) => {
    requireAdmin(c);
    if (!validId(c.params.id)) throw new HttpError(400, 'invalid_id', 'invalid resource id');
    const sql = await getDb(c.env);
    const runs = await sql`SELECT id,file_id,job_id,status,is_active,page_count,pages_ok,pages_empty,pages_failed,pages_held,avg_confidence,quality,extractor,extractor_version,executor,settings,warnings,error_code,created_at,completed_at,activated_at
      FROM extraction_runs WHERE resource_id=${c.params.id} ORDER BY created_at DESC LIMIT 50`;
    return json({ runs });
  });

  r.add('GET', '/api/ai/runs/:id', async (c) => {
    requireAdmin(c);
    if (!validId(c.params.id)) throw new HttpError(400, 'invalid_id', 'invalid run id');
    const sql = await getDb(c.env);
    const [run] = await sql`SELECT * FROM extraction_runs WHERE id=${c.params.id}`;
    if (!run) throw new HttpError(404, 'not_found', 'run not found');
    return json({ run });
  });

  r.add('GET', '/api/ai/runs/:id/pages', async (c) => {
    requireAdmin(c);
    if (!validId(c.params.id)) throw new HttpError(400, 'invalid_id', 'invalid run id');
    const sql = await getDb(c.env);
    const withText = c.url.searchParams.get('include') === 'text';
    const status = c.url.searchParams.get('status') || '';
    const review = c.url.searchParams.get('review_state') || '';
    const after = Number(c.url.searchParams.get('after')) || 0;
    const limit = Math.min(200, Math.max(1, Number(c.url.searchParams.get('limit')) || 100));
    const rows = await sql`
      SELECT location_kind,page_number,label,status,method,confidence,warnings,language,rotation,char_count,word_count,index_state,review_state,error,
        CASE WHEN ${withText} THEN coalesce(corrected_text, text) ELSE left(coalesce(corrected_text, text), 200) END AS text
      FROM extraction_pages WHERE run_id=${c.params.id} AND page_number > ${after}
        AND (${status} = '' OR status = ${status}) AND (${review} = '' OR review_state = ${review})
      ORDER BY page_number LIMIT ${limit}`;
    return json({ pages: rows, next_after: rows.length === limit ? rows[rows.length - 1].page_number : null });
  });

  r.add('GET', '/api/ai/runs/:id/pages/:n', async (c) => {
    requireAdmin(c);
    if (!validId(c.params.id) || !validId(c.params.n)) throw new HttpError(400, 'invalid_id', 'invalid id');
    const sql = await getDb(c.env);
    const [page] = await sql`SELECT * FROM extraction_pages WHERE run_id=${c.params.id} AND location_kind='page' AND page_number=${c.params.n}`;
    if (!page) throw new HttpError(404, 'not_found', 'page not found');
    const equations = await sql`SELECT idx,bbox,source_text,latex,status,confidence,warnings FROM page_equations WHERE run_id=${c.params.id} AND page_number=${c.params.n} ORDER BY idx`;
    const { tsv, signature, ...rest } = page;
    return json({ page: rest, equations });
  });

  r.add('POST', '/api/ai/runs/:id/pages/review', async (c) => {
    const actor = requireAdmin(c);
    if (!validId(c.params.id)) throw new HttpError(400, 'invalid_id', 'invalid run id');
    const body = await readJson(c.req);
    if (!Array.isArray(body.actions) || body.actions.length < 1 || body.actions.length > 100) throw new HttpError(400, 'invalid_actions', '1-100 actions required');
    const sql = await getDb(c.env);
    const [run] = await sql`SELECT id, resource_id FROM extraction_runs WHERE id=${c.params.id}`;
    if (!run) throw new HttpError(404, 'not_found', 'run not found');
    const results = [];
    for (const a of body.actions) {
      const n = Number(a.page);
      if (!Number.isInteger(n) || n < 1 || !['accept', 'reject', 'edit'].includes(a.action)) { results.push({ page: a.page, ok: false, reason: 'invalid action' }); continue; }
      const [p] = await sql`SELECT status, warnings FROM extraction_pages WHERE run_id=${run.id} AND location_kind='page' AND page_number=${n}`;
      if (!p) { results.push({ page: n, ok: false, reason: 'page not found' }); continue; }
      const state = a.action === 'accept' ? 'accepted' : a.action === 'reject' ? 'rejected' : 'edited';
      let corrected = null;
      if (a.action === 'edit') {
        corrected = String(a.corrected_text ?? '').replace(/\u0000/g, '').slice(0, PAGE_LIMITS.maxTextChars);
        if (!corrected.trim()) { results.push({ page: n, ok: false, reason: 'corrected_text required' }); continue; }
      }
      const idx = indexDecision({ status: a.action === 'edit' ? 'ok' : p.status, warnings: p.warnings, review_state: state }).index_state;
      await sql`UPDATE extraction_pages SET review_state=${state}, index_state=${idx}, reviewed_by=${actor.actor}, reviewed_at=now(),
        review_note=${a.note ? String(a.note).slice(0, 300) : null}, corrected_text=COALESCE(${corrected}, corrected_text), updated_at=now()
        WHERE run_id=${run.id} AND location_kind='page' AND page_number=${n}`;
      results.push({ page: n, ok: true, review_state: state, index_state: idx });
    }
    await refreshIndexState(sql, run.resource_id);
    await audit(sql, c, actor, 'pages_reviewed', 'run', run.id, { count: results.filter((x) => x.ok).length });
    return json({ results });
  });

  async function activateRun(sql, runId, actor, c, { syncLegacy = false, confirmReplace = false } = {}) {
    const [run] = await sql`SELECT * FROM extraction_runs WHERE id=${runId}`;
    if (!run) throw new HttpError(404, 'not_found', 'run not found');
    if (!['completed', 'partial'].includes(run.status)) throw new HttpError(409, 'run_not_activatable', `run is ${run.status}; only completed or partial runs can be activated`);
    const statements = [
      sql`UPDATE extraction_pages SET is_active=false WHERE file_id=${run.file_id} AND is_active AND run_id<>${run.id}`,
      sql`UPDATE extraction_runs SET is_active=false WHERE file_id=${run.file_id} AND is_active AND id<>${run.id}`,
      sql`UPDATE extraction_runs SET is_active=true, activated_at=now(), activated_by=${actor.actor} WHERE id=${run.id}`,
      sql`UPDATE extraction_pages SET is_active=true WHERE run_id=${run.id}`,
    ];
    if (syncLegacy) {
      const [res] = await sql`SELECT extracted_text FROM resources WHERE id=${run.resource_id}`;
      if (res?.extracted_text && String(res.extracted_text).trim() && !confirmReplace) {
        throw new HttpError(409, 'legacy_text_exists', 'resources.extracted_text already has content; resend with confirm_replace_legacy:true (the old text is saved to resource_text_history)');
      }
      statements.push(sql`INSERT INTO resource_text_history(resource_id,previous_text,previous_snippet,replaced_by_run,actor)
        SELECT id, extracted_text, preview_snippet, ${run.id}, ${actor.actor} FROM resources WHERE id=${run.resource_id} AND extracted_text IS NOT NULL`);
      statements.push(sql`UPDATE resources SET
        extracted_text=(SELECT string_agg('===== PAGE ' || page_number || E' =====\n' || coalesce(corrected_text, text), E'\n\n' ORDER BY page_number)
          FROM extraction_pages WHERE run_id=${run.id} AND location_kind='page' AND index_state='indexed'),
        preview_snippet=left(regexp_replace((SELECT string_agg(coalesce(corrected_text, text), ' ' ORDER BY page_number) FROM extraction_pages WHERE run_id=${run.id} AND location_kind='page' AND index_state='indexed'), '\\s+', ' ', 'g'), 360),
        processing_status='ready' WHERE id=${run.resource_id}`);
    }
    await sql.transaction(statements);
    await refreshIndexState(sql, run.resource_id);
    await audit(sql, c, actor, 'run_activated', 'run', run.id, { sync_legacy: syncLegacy });
    return run;
  }

  r.add('POST', '/api/ai/runs/:id/activate', async (c) => {
    const actor = requireAdmin(c);
    if (!validId(c.params.id)) throw new HttpError(400, 'invalid_id', 'invalid run id');
    const body = await readJson(c.req);
    const sql = await getDb(c.env);
    const run = await activateRun(sql, c.params.id, actor, c, { syncLegacy: Boolean(body.sync_legacy), confirmReplace: Boolean(body.confirm_replace_legacy) });
    return json({ ok: true, run_id: String(run.id), resource_id: String(run.resource_id), note: 'Search now uses this extraction. The original file was not changed.' });
  });

  r.add('POST', '/api/ai/runs/:id/deactivate', async (c) => {
    const actor = requireAdmin(c);
    if (!validId(c.params.id)) throw new HttpError(400, 'invalid_id', 'invalid run id');
    const sql = await getDb(c.env);
    const [run] = await sql`SELECT resource_id FROM extraction_runs WHERE id=${c.params.id} AND is_active`;
    if (!run) throw new HttpError(409, 'not_active', 'run is not active');
    await sql.transaction([
      sql`UPDATE extraction_pages SET is_active=false WHERE run_id=${c.params.id}`,
      sql`UPDATE extraction_runs SET is_active=false WHERE id=${c.params.id}`,
    ]);
    await refreshIndexState(sql, run.resource_id);
    await audit(sql, c, actor, 'run_deactivated', 'run', c.params.id, {});
    return json({ ok: true });
  });

  // ------------------------------------------------------------ public reads + search
  r.add('GET', '/api/resource/:id/pages', async (c) => {
    if (!validId(c.params.id)) throw new HttpError(400, 'invalid_id', 'invalid resource id');
    const sql = await getDb(c.env);
    const [res] = await sql`SELECT id FROM resources WHERE id=${c.params.id} AND is_flagged=false`;
    if (!res) throw new HttpError(404, 'resource_not_found', 'resource not found');
    const pages = await sql`SELECT page_number, char_count, confidence, warnings, review_state FROM extraction_pages
      WHERE resource_id=${c.params.id} AND is_active AND index_state='indexed' AND location_kind='page' ORDER BY page_number`;
    return json({ resource_id: String(c.params.id), pages, note: 'Recognised text; may contain errors, especially in equations.' });
  });

  r.add('GET', '/api/resource/:id/pages/:n', async (c) => {
    if (!validId(c.params.id) || !validId(c.params.n)) throw new HttpError(400, 'invalid_id', 'invalid id');
    const sql = await getDb(c.env);
    const [p] = await sql`SELECT p.page_number, coalesce(p.corrected_text, p.text) AS text, p.confidence, p.warnings, p.review_state, p.method
      FROM extraction_pages p JOIN resources r ON r.id=p.resource_id
      WHERE p.resource_id=${c.params.id} AND r.is_flagged=false AND p.is_active AND p.index_state='indexed' AND p.location_kind='page' AND p.page_number=${c.params.n}`;
    if (!p) throw new HttpError(404, 'not_found', 'page not found or not indexed');
    return json({ resource_id: String(c.params.id), page: p, disclaimer: 'Recognised text, not verified. Check the original page.' });
  });

  r.add('GET', '/api/search/content', async (c) => {
    const q = (c.url.searchParams.get('q') || '').trim().slice(0, 200);
    if (q.length < 2) throw new HttpError(400, 'q_required', 'q must be at least 2 characters');
    const unit = c.url.searchParams.get('unit') || '';
    const type = c.url.searchParams.get('type') || '';
    const year = c.url.searchParams.get('year') || '';
    const limit = Math.min(50, Math.max(1, Number(c.url.searchParams.get('limit')) || 20));
    const offset = Math.max(0, Number(c.url.searchParams.get('offset')) || 0);
    if (type && !['notes', 'cat', 'exam', 'assignment', 'other'].includes(type)) throw new HttpError(400, 'invalid_type', 'invalid type');
    if (year && !/^\d{4}$/.test(year)) throw new HttpError(400, 'invalid_year', 'invalid year');
    const sql = await getDb(c.env);
    const rows = await sql`
      WITH query AS (SELECT websearch_to_tsquery('english', ${q}) AS tsq)
      SELECT p.resource_id, p.page_number, p.confidence, p.warnings, r.title AS resource_title, r.type, r.academic_year,
        u.id AS unit_id, u.code_display AS unit_code, u.title AS unit_title,
        ts_rank_cd(p.tsv, query.tsq) AS rank,
        ts_headline('english', coalesce(p.corrected_text, p.text), query.tsq, 'StartSel=[[, StopSel=]], MaxWords=30, MinWords=12, MaxFragments=1') AS snippet
      FROM query, extraction_pages p
      JOIN resources r ON r.id = p.resource_id
      JOIN units u ON u.id = r.unit_id
      WHERE p.is_active AND p.index_state='indexed' AND p.tsv @@ query.tsq AND r.is_flagged=false
        AND (${unit} = '' OR u.code = upper(regexp_replace(${unit}, '[\\s_-]+', '', 'g')))
        AND (${type} = '' OR r.type = ${type || 'notes'}::resource_type)
        AND (${year} = '' OR r.academic_year = NULLIF(${year}, '')::smallint)
      ORDER BY rank DESC, p.resource_id, p.page_number
      LIMIT ${limit} OFFSET ${offset}`;
    const grouped = new Map();
    for (const row of rows) {
      const key = String(row.resource_id);
      if (!grouped.has(key)) {
        grouped.set(key, { resource_id: key, resource_title: row.resource_title, type: row.type, academic_year: row.academic_year,
          unit: { id: row.unit_id, code: row.unit_code, title: row.unit_title }, best_rank: Number(row.rank), hits: [] });
      }
      grouped.get(key).hits.push({ page: row.page_number, snippet_html: highlightToHtml(row.snippet), rank: Number(row.rank),
        low_confidence: (row.warnings || []).includes('LOW_CONFIDENCE'), source: `/api/resource/${key}/pages/${row.page_number}` });
    }
    return json({ query: q, mode: 'lexical', count: rows.length, offset, limit, results: [...grouped.values()],
      note: 'Matches recognised (OCR) text and may miss or misread words.' });
  });

  return r;
}

/** Scheduled task: leases that expired (closed tab, crash) go back to the queue or fail permanently. */
export async function recoverStale(env) {
  const sql = await getDb(env);
  const stale = await sql`UPDATE document_processing_jobs SET
      status=CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
      dead_lettered_at=CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
      error_code='LEASE_EXPIRED', error_message='worker stopped reporting progress',
      next_attempt_at=now() + interval '30 seconds', lease_token_hash=NULL, lease_expires_at=NULL, updated_at=now()
    WHERE status='running' AND lease_expires_at < now() RETURNING id, attempts`;
  for (const j of stale) {
    await sql`UPDATE job_attempts SET finished_at=now(), outcome='lease_expired', error_code='LEASE_EXPIRED' WHERE job_id=${j.id} AND attempt_no=${j.attempts} AND finished_at IS NULL`;
  }
  return { recovered: stale.length };
}
