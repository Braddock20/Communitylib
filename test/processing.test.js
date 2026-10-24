import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbAvailable, seedResource } from './helpers/db.js';
import { createProcessingRouter, recoverStale } from '../src/routes/processing.js';

const ADMIN = 'test-admin-key-0123456789';
const available = await dbAvailable();
const skip = available ? false : 'no Postgres reachable (set PGTEST_URL); DB-backed tests NOT executed';

function fakeStorage(bytes = new TextEncoder().encode('%PDF-1.4 fake')) {
  return { async fetchObject(key, range) { return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }); } };
}

async function setup() {
  const db = await createTestDb();
  const router = createProcessingRouter();
  const env = { ADMIN_API_KEY: ADMIN, __sql: db.sql, __storage: fakeStorage() };
  const call = async (method, path, { body, token = ADMIN, headers = {} } = {}) => {
    const req = new Request(`https://api.test${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const res = await router.handle(req, env, {});
    if (!res) return { status: 404, json: null, res: null };
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, json: ct.includes('json') ? await res.json() : null, res };
  };
  return { db, env, call };
}

const T = (n, text, extra = {}) => ({ page_number: n, status: 'ok', method: 'pdf-text', text, ...extra });
const PROSE = 'Gauss law relates the electric flux through a closed surface to the charge enclosed by that surface.';

test('admin auth is enforced on every protected route and lease tokens are scoped to one job', { skip }, async () => {
  const { db, call } = await setup();
  try {
    assert.equal((await call('GET', '/api/ai/jobs', { token: null })).status, 401);
    assert.equal((await call('GET', '/api/ai/jobs', { token: 'wrong' })).status, 401);
    assert.equal((await call('POST', '/api/ai/jobs', { token: null, body: {} })).status, 401);
    assert.equal((await call('POST', '/api/ai/jobs/00000000-0000-0000-0000-000000000000/pages', { token: 'nope', body: { pages: [] } })).status, 401);
    assert.equal((await call('GET', '/api/ai/processing/capabilities', { token: null })).status, 200, 'capabilities are public');
    assert.equal((await call('GET', '/api/ai/jobs/not-a-uuid')).status, 400);
  } finally { await db.drop(); }
});

test('full job protocol: create, dedupe, claim, pages, complete, activate, search, public read', { skip }, async () => {
  const { db, call } = await setup();
  try {
    const ids = await seedResource(db.sql);
    const created = await call('POST', '/api/ai/jobs', { body: { resource_id: ids.resourceId, operation: 'extract', mode: 'standard' } });
    assert.equal(created.status, 201);
    const jobId = created.json.job.id;
    assert.equal(created.json.job.state, 'queued');
    assert.equal(created.json.job.lease_token_hash, undefined, 'lease hash never leaks');

    const dup = await call('POST', '/api/ai/jobs', { body: { resource_id: ids.resourceId, operation: 'extract', mode: 'standard' } });
    assert.equal(dup.status, 200); assert.equal(dup.json.deduplicated, true); assert.equal(dup.json.job.id, jobId);

    // pages before claim are refused
    assert.equal((await call('POST', `/api/ai/jobs/${jobId}/pages`, { token: 'x', body: { pages: [T(1, PROSE)] } })).status, 401);

    const claim = await call('POST', `/api/ai/jobs/${jobId}/claim`, { body: { client: { name: 'test-browser' } } });
    assert.equal(claim.status, 200);
    const lease = claim.json.lease.token;
    assert.equal(claim.json.plan.file.sha256, ids.hash);
    assert.equal(claim.json.plan.source_url, `/api/ai/jobs/${jobId}/source`);
    assert.equal((await call('POST', `/api/ai/jobs/${jobId}/claim`)).status, 409, 'cannot double-claim a live lease');

    const src = await call('GET', `/api/ai/jobs/${jobId}/source`, { token: lease });
    assert.equal(src.status, 200); assert.equal(src.res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await call('GET', `/api/ai/jobs/${jobId}/source`, { token: ADMIN })).status, 401, 'admin key is not a lease');

    const sub = await call('POST', `/api/ai/jobs/${jobId}/pages`, { token: lease, body: {
      run: { page_count: 4 },
      pages: [
        { page_number: 1, status: 'ok', method: 'ocr', text: '   ', confidence: 0.9 },             // blank -> empty
        T(2, PROSE),
        { page_number: 3, status: 'ok', method: 'ocr', text: 'Faraday induction e.m.f. equals negative rate of change of magnetic flux linkage', confidence: 0.2 }, // held
        { page_number: 4, status: 'weird', method: 'ocr' },                                      // rejected by validation
      ] } });
    assert.equal(sub.status, 200);
    assert.deepEqual(sub.json.accepted, [1, 2, 3]);
    assert.equal(sub.json.rejected.length, 1);

    const pages = await db.sql`SELECT page_number,status,index_state,review_state,char_count,text_sha256 FROM extraction_pages WHERE run_id=(SELECT run_id FROM document_processing_jobs WHERE id=${jobId}) ORDER BY 1`;
    assert.deepEqual(pages.map((p) => [p.page_number, p.status, p.index_state]), [[1, 'empty', 'rejected'], [2, 'ok', 'indexed'], [3, 'ok', 'held']]);
    assert.equal(pages[2].review_state, 'needs_review');
    assert.equal(pages[0].text_sha256, null, 'empty page is not hashed as content');

    // idempotent resubmission replaces, never duplicates
    await call('POST', `/api/ai/jobs/${jobId}/pages`, { token: lease, body: { pages: [T(2, PROSE)] } });
    assert.equal((await db.sql`SELECT count(*)::int n FROM extraction_pages`)[0].n, 3);

    const done = await call('POST', `/api/ai/jobs/${jobId}/complete`, { token: lease, body: {} });
    assert.equal(done.status, 200);
    assert.equal(done.json.job.state, 'partial', 'a held page + missing page 4 makes the run partial, not completed');
    assert.equal(done.json.run.pages_held, 1);
    assert.equal(done.json.run.pages_empty, 1);
    assert.notEqual(done.json.run.quality, 'unknown');
    assert.equal((await call('POST', `/api/ai/jobs/${jobId}/pages`, { token: lease, body: { pages: [T(2, PROSE)] } })).status, 401, 'lease is revoked after completion');

    // nothing is searchable until a run is explicitly activated
    assert.equal((await call('GET', '/api/search/content?q=flux', { token: null })).json.results.length, 0);
    const runId = done.json.run.id;
    assert.equal((await call('GET', `/api/resource/${ids.resourceId}/pages`, { token: null })).json.pages.length, 0);
    const act = await call('POST', `/api/ai/runs/${runId}/activate`, { body: {} });
    assert.equal(act.status, 200);

    const s = await call('GET', '/api/search/content?q=electric+flux', { token: null });
    assert.equal(s.status, 200);
    assert.equal(s.json.results.length, 1);
    assert.equal(s.json.results[0].hits[0].page, 2);
    assert.match(s.json.results[0].hits[0].snippet_html, /<mark>/);
    assert.equal(s.json.results[0].unit.code, 'PHY 121');
    // held page 3 is not searchable; reviewer acceptance makes it so
    assert.equal((await call('GET', '/api/search/content?q=Faraday', { token: null })).json.results.length, 0);
    const rev = await call('POST', `/api/ai/runs/${runId}/pages/review`, { body: { actions: [{ page: 3, action: 'accept' }, { page: 9, action: 'accept' }] } });
    assert.deepEqual(rev.json.results.map((r) => r.ok), [true, false]);
    assert.equal((await call('GET', '/api/search/content?q=Faraday', { token: null })).json.results.length, 1);
    // corrections are stored separately and searched; source text is preserved
    await call('POST', `/api/ai/runs/${runId}/pages/review`, { body: { actions: [{ page: 3, action: 'edit', corrected_text: 'Lenz law: induced current opposes the change in flux.' }] } });
    assert.equal((await call('GET', '/api/search/content?q=Lenz', { token: null })).json.results.length, 1);
    const [row] = await db.sql`SELECT text, corrected_text FROM extraction_pages WHERE run_id=${runId} AND page_number=3`;
    assert.match(row.text, /Faraday/); assert.match(row.corrected_text, /Lenz/);

    const pub = await call('GET', `/api/resource/${ids.resourceId}/pages/2`, { token: null });
    assert.equal(pub.status, 200); assert.match(pub.json.disclaimer, /not verified/);
    assert.equal((await call('GET', `/api/resource/${ids.resourceId}/pages/1`, { token: null })).status, 404, 'blank page is not exposed');

    // original resource untouched
    const [file] = await db.sql`SELECT file_hash FROM resource_files WHERE id=${ids.fileId}`;
    assert.equal(file.file_hash, ids.hash);
    const [legacy] = await db.sql`SELECT extracted_text FROM resources WHERE id=${ids.resourceId}`;
    assert.equal(legacy.extracted_text, null, 'activation does not rewrite legacy extracted_text unless asked');

    // flagging the resource hides everything immediately
    await db.sql`UPDATE resources SET is_flagged=true WHERE id=${ids.resourceId}`;
    assert.equal((await call('GET', '/api/search/content?q=electric+flux', { token: null })).json.results.length, 0);
    assert.equal((await call('GET', `/api/resource/${ids.resourceId}/pages/2`, { token: null })).status, 404);
    const audit = await db.sql`SELECT action FROM ai_audit_log ORDER BY id`;
    for (const a of ['job_created', 'job_completed', 'run_activated', 'pages_reviewed']) assert.ok(audit.some((x) => x.action === a), a);
  } finally { await db.drop(); }
});

test('an extraction that recovers no text fails honestly instead of storing empty text', { skip }, async () => {
  const { db, call } = await setup();
  try {
    const ids = await seedResource(db.sql);
    const { json: c1 } = await call('POST', '/api/ai/jobs', { body: { resource_id: ids.resourceId } });
    const claim = await call('POST', `/api/ai/jobs/${c1.job.id}/claim`);
    const lease = claim.json.lease.token;
    await call('POST', `/api/ai/jobs/${c1.job.id}/pages`, { token: lease, body: { pages: [{ page_number: 1, status: 'ok', method: 'ocr', text: '' }, { page_number: 2, status: 'ok', method: 'ocr', text: ' \n ' }] } });
    const done = await call('POST', `/api/ai/jobs/${c1.job.id}/complete`, { token: lease });
    assert.equal(done.json.job.state, 'failed');
    assert.equal(done.json.job.error_code, 'NO_TEXT_RECOVERED');
    assert.equal((await call('POST', `/api/ai/runs/${done.json.run.id}/activate`)).status, 409, 'failed runs cannot be activated');
  } finally { await db.drop(); }
});

test('failures: retryable goes to retry_wait with backoff, permanent fails, dead-letter after max attempts, stale leases recover', { skip }, async () => {
  const { db, call, env } = await setup();
  try {
    const ids = await seedResource(db.sql);
    const { json: c1 } = await call('POST', '/api/ai/jobs', { body: { resource_id: ids.resourceId } });
    const id = c1.job.id;
    let claim = await call('POST', `/api/ai/jobs/${id}/claim`);
    let f = await call('POST', `/api/ai/jobs/${id}/fail`, { token: claim.json.lease.token, body: { code: 'OCR_TIMEOUT', message: 'slow', retryable: true } });
    assert.equal(f.json.job.state, 'retry_wait');
    assert.ok(new Date(f.json.job.next_attempt_at) > new Date());
    assert.equal((await call('POST', `/api/ai/jobs/${id}/claim`)).status, 409, 'backoff is honoured');
    await db.sql`UPDATE document_processing_jobs SET next_attempt_at=now() - interval '1 second' WHERE id=${id}`;
    claim = await call('POST', `/api/ai/jobs/${id}/claim`);
    assert.equal(claim.status, 200);
    assert.equal((await call('GET', `/api/ai/jobs/${id}`)).json.attempts.length, 2);

    // expired lease -> recovered by the scheduled task
    await db.sql`UPDATE document_processing_jobs SET lease_expires_at=now() - interval '1 minute' WHERE id=${id}`;
    assert.equal((await recoverStale(env)).recovered, 1);
    assert.equal((await call('GET', `/api/ai/jobs/${id}`)).json.job.state, 'retry_wait');
    assert.equal((await call('POST', `/api/ai/jobs/${id}/pages`, { token: claim.json.lease.token, body: { pages: [T(1, PROSE)] } })).status, 401);

    // permanent error: no retry
    await db.sql`UPDATE document_processing_jobs SET next_attempt_at=NULL WHERE id=${id}`;
    claim = await call('POST', `/api/ai/jobs/${id}/claim`);
    f = await call('POST', `/api/ai/jobs/${id}/fail`, { token: claim.json.lease.token, body: { code: 'PASSWORD_PROTECTED', message: 'locked', retryable: true } });
    assert.equal(f.json.job.state, 'failed');
    assert.ok(f.json.guide.action);
    // manual retry reopens it; completed jobs cannot be retried
    assert.equal((await call('POST', `/api/ai/jobs/${id}/retry`)).json.job.state, 'queued');
    assert.equal((await call('POST', `/api/ai/jobs/${id}/cancel`)).json.job.state, 'cancelled');
    assert.equal((await call('POST', `/api/ai/jobs/${id}/cancel`)).status, 409);

    // dead-letter after max attempts
    await call('POST', `/api/ai/jobs/${id}/retry`);
    await db.sql`UPDATE document_processing_jobs SET max_attempts=1, attempts=0 WHERE id=${id}`;
    claim = await call('POST', `/api/ai/jobs/${id}/claim`);
    f = await call('POST', `/api/ai/jobs/${id}/fail`, { token: claim.json.lease.token, body: { code: 'INTERNAL_ERROR', retryable: true } });
    assert.equal(f.json.job.state, 'failed');
    assert.ok(f.json.job.dead_lettered_at);
  } finally { await db.drop(); }
});

test('cancellation is observed by a running worker and idempotency keys are enforced', { skip }, async () => {
  const { db, call } = await setup();
  try {
    const ids = await seedResource(db.sql);
    const body = { resource_id: ids.resourceId, idempotency_key: 'abc' };
    const a = await call('POST', '/api/ai/jobs', { body });
    const b = await call('POST', '/api/ai/jobs', { body });
    assert.equal(b.json.deduplicated, true); assert.equal(b.json.job.id, a.json.job.id);
    assert.equal((await call('POST', '/api/ai/jobs', { body: { ...body, mode: 'high' } })).status, 422, 'same key, different request');
    const claim = await call('POST', `/api/ai/jobs/${a.json.job.id}/claim`);
    await call('POST', `/api/ai/jobs/${a.json.job.id}/cancel`);
    const hb = await call('POST', `/api/ai/jobs/${a.json.job.id}/heartbeat`, { token: claim.json.lease.token, body: {} });
    assert.equal(hb.json.cancel_requested, true);
    const pg = await call('POST', `/api/ai/jobs/${a.json.job.id}/pages`, { token: claim.json.lease.token, body: { pages: [T(1, PROSE)] } });
    assert.equal(pg.json.cancel_requested, true); assert.deepEqual(pg.json.accepted, []);
    assert.equal((await call('POST', `/api/ai/jobs/${a.json.job.id}/complete`, { token: claim.json.lease.token })).status, 409);
  } finally { await db.drop(); }
});

test('validation: unsupported formats, unknown resources, flagged resources, bad page specs', { skip }, async () => {
  const { db, call } = await setup();
  try {
    const docx = await seedResource(db.sql, { filename: 'a.docx', ext: 'docx', code: 'MAT101', title: 'Calculus' });
    const r1 = await call('POST', '/api/ai/jobs', { body: { resource_id: docx.resourceId } });
    assert.equal(r1.status, 422); assert.equal(r1.json.error, 'UNSUPPORTED_FORMAT');
    assert.equal((await call('POST', '/api/ai/jobs', { body: { resource_id: '999999' } })).status, 404);
    assert.equal((await call('POST', '/api/ai/jobs', { body: { resource_id: 'abc' } })).status, 400);
    const ok = await seedResource(db.sql, { code: 'PHY121' });
    assert.equal((await call('POST', '/api/ai/jobs', { body: { resource_id: ok.resourceId, pages: '5-2' } })).status, 400);
    assert.equal((await call('POST', '/api/ai/jobs', { body: { resource_id: ok.resourceId, executor: 'external' } })).status, 400);
    assert.equal((await call('POST', '/api/ai/jobs', { body: { resource_id: ok.resourceId, operation: 'drop' } })).status, 400);
    const flagged = await seedResource(db.sql, { code: 'PHY121', flagged: true });
    assert.equal((await call('POST', '/api/ai/jobs', { body: { resource_id: flagged.resourceId } })).status, 404);
    const big = await call('POST', '/api/ai/jobs', { body: { resource_id: ok.resourceId, note: 'x'.repeat(3_000_000) } });
    assert.equal(big.status, 413);
  } finally { await db.drop(); }
});

test('legacy text sync is opt-in, refuses to overwrite silently, and keeps history', { skip }, async () => {
  const { db, call } = await setup();
  try {
    const ids = await seedResource(db.sql);
    await db.sql`UPDATE resources SET extracted_text='OLD TEXT' WHERE id=${ids.resourceId}`;
    const { json: j } = await call('POST', '/api/ai/jobs', { body: { resource_id: ids.resourceId } });
    const claim = await call('POST', `/api/ai/jobs/${j.job.id}/claim`);
    await call('POST', `/api/ai/jobs/${j.job.id}/pages`, { token: claim.json.lease.token, body: { run: { page_count: 1 }, pages: [T(1, PROSE)] } });
    const done = await call('POST', `/api/ai/jobs/${j.job.id}/complete`, { token: claim.json.lease.token });
    const runId = done.json.run.id;
    assert.equal(done.json.job.state, 'completed');
    assert.equal((await call('POST', `/api/ai/runs/${runId}/activate`, { body: { sync_legacy: true } })).status, 409);
    assert.equal((await db.sql`SELECT extracted_text FROM resources WHERE id=${ids.resourceId}`)[0].extracted_text, 'OLD TEXT');
    assert.equal((await call('POST', `/api/ai/runs/${runId}/activate`, { body: { sync_legacy: true, confirm_replace_legacy: true } })).status, 200);
    const [r] = await db.sql`SELECT extracted_text, preview_snippet FROM resources WHERE id=${ids.resourceId}`;
    assert.match(r.extracted_text, /^===== PAGE 1 =====\nGauss law/);
    assert.match(r.preview_snippet, /^Gauss law/);
    assert.equal((await db.sql`SELECT previous_text FROM resource_text_history WHERE resource_id=${ids.resourceId}`)[0].previous_text, 'OLD TEXT');
    // activating another run replaces the previous active run for the file (one active per file)
    const second = await call('POST', '/api/ai/jobs', { body: { resource_id: ids.resourceId, mode: 'high' } });
    const c2 = await call('POST', `/api/ai/jobs/${second.json.job.id}/claim`);
    await call('POST', `/api/ai/jobs/${second.json.job.id}/pages`, { token: c2.json.lease.token, body: { run: { page_count: 1 }, pages: [T(1, PROSE + ' Second run.')] } });
    const d2 = await call('POST', `/api/ai/jobs/${second.json.job.id}/complete`, { token: c2.json.lease.token });
    await call('POST', `/api/ai/runs/${d2.json.run.id}/activate`);
    assert.equal((await db.sql`SELECT count(*)::int n FROM extraction_runs WHERE is_active`)[0].n, 1);
    assert.equal((await db.sql`SELECT count(DISTINCT run_id)::int n FROM extraction_pages WHERE is_active`)[0].n, 1);
  } finally { await db.drop(); }
});
