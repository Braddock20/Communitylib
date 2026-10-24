import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, dbAvailable, seedResource } from './helpers/db.js';
import { createProcessingRouter } from '../src/routes/processing.js';
import { BrowserProcessor, ApiClient, itemsToText } from '../frontend/console/js/processor.js';

const ADMIN = 'test-admin-key-0123456789';
const skip = (await dbAvailable()) ? false : 'no Postgres reachable; DB-backed tests NOT executed';
const PROSE = 'Gauss law relates the electric flux through a closed surface to the charge enclosed by that surface.';

test('itemsToText joins by line position', () => {
  const t = itemsToText([{ str: 'Hello', transform: [1, 0, 0, 1, 0, 700] }, { str: 'world', transform: [1, 0, 0, 1, 50, 700] }, { str: 'Next', transform: [1, 0, 0, 1, 0, 680] }]);
  assert.equal(t, 'Hello world\nNext');
});

async function harness(bytes) {
  const db = await createTestDb();
  const router = createProcessingRouter();
  const env = { ADMIN_API_KEY: ADMIN, __sql: db.sql, __storage: { async fetchObject() { return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }); } } };
  const fetchImpl = async (url, init) => { const res = await router.handle(new Request(url, init), env, {}); return res || new Response('{}', { status: 404 }); };
  const api = new ApiClient({ base: 'https://api.test', adminKey: ADMIN, fetchImpl });
  return { db, api };
}
const sha = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

test('browser processor: text pages + OCR fallback + blank page, end to end against the real router', { skip }, async () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 fake');
  const { db, api } = await harness(bytes);
  try {
    const ids = await seedResource(db.sql, { hash: await sha(bytes), size: bytes.length });
    const { job } = await api.req('/api/ai/jobs', { method: 'POST', body: { resource_id: ids.resourceId, operation: 'ocr', mode: 'standard', activate: true } });
    const texts = { 1: PROSE, 2: '', 3: '' };
    const loadPdf = async () => ({ numPages: 3, getText: async (n) => texts[n], render: async (n) => ({ page: n }), destroy() {} });
    const createOcr = async () => ({ recognize: async (img) => img.page === 2 ? { text: 'Scanned page about Faraday induction and magnetic flux through a loop of wire.', confidence: 0.91 } : { text: '', confidence: 0 }, terminate() {} });
    const progress = [];
    const proc = new BrowserProcessor({ api, loadPdf, createOcr, batchSize: 2 });
    const summary = await proc.run(job.id, { onProgress: (p) => progress.push(p.stage) });
    assert.equal(summary.pages, 3); assert.equal(summary.ocr_pages, 2);
    assert.ok(progress.includes('done'));
    const got = await api.req(`/api/ai/jobs/${job.id}`);
    assert.equal(got.job.state, 'completed', 'a genuinely blank page is not a failure');
    const pages = await api.req(`/api/ai/runs/${got.run.id}/pages`);
    const by = Object.fromEntries(pages.pages.map((p) => [p.page_number, p]));
    assert.equal(by[1].method, 'pdf-text'); assert.equal(by[2].method, 'ocr'); assert.equal(by[3].status, 'empty'); assert.notEqual(by[3].index_state, 'indexed');
  } finally { await db.drop(); }
});

test('browser processor: changed source and corrupt PDF fail the job with permanent codes', { skip }, async () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 fake');
  const { db, api } = await harness(bytes);
  try {
    const ids = await seedResource(db.sql, { hash: 'a'.repeat(64), size: bytes.length });
    const { job } = await api.req('/api/ai/jobs', { method: 'POST', body: { resource_id: ids.resourceId, operation: 'ocr' } });
    const proc = new BrowserProcessor({ api, loadPdf: async () => { throw new Error('x'); }, createOcr: async () => ({}) });
    await assert.rejects(proc.run(job.id), /changed/);
    const got = await api.req(`/api/ai/jobs/${job.id}`);
    assert.equal(got.job.state, 'failed');
  } finally { await db.drop(); }
});
