// Browser-side document processor (job protocol v1, see docs/PROTOCOL.md).
// All heavy work (PDF text layer, canvas rendering, OCR) happens here, never in the Worker.
// Dependencies are injected so the same code runs in the console and in Node tests.
import { detectMathRegions } from './shared/textquality.js';
import { minhash } from './shared/fingerprint.js';

const MIN_CHARS = 20;

export class ProcessingError extends Error {
  constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
}

export async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Join pdf.js text items into lines using their vertical position. */
export function itemsToText(items) {
  let out = ''; let lastY = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const y = it.transform ? Math.round(it.transform[5]) : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) out += '\n';
    else if (out && !out.endsWith('\n') && !out.endsWith(' ') && it.str && !it.str.startsWith(' ')) out += ' ';
    out += it.str;
    if (it.hasEOL) out += '\n';
    if (y !== null) lastY = y;
  }
  return out;
}

function enrich(page, text) {
  const regions = detectMathRegions(text);
  page.equations = regions.slice(0, 40).map((r, idx) => ({ idx, bbox: null, source_text: r.text.slice(0, 500), latex: null, engine: null, confidence: null, warnings: ['UNVERIFIED'] }));
  page.signature = minhash(text);
  return page;
}

export class BrowserProcessor {
  /**
   * @param {object} o
   * @param {object} o.api  {claim, fetchSource, submitPages, heartbeat, complete, fail}
   * @param {Function} o.loadPdf  async (ArrayBuffer) -> {numPages, getText(n), render(n, dpi) -> imageLike, destroy()}
   * @param {Function} o.createOcr async ({languages}) -> {recognize(image,{psm}) -> {text, confidence 0..1}, terminate()}
   * @param {Function} [o.decodeImage] async (ArrayBuffer, kind) -> imageLike
   */
  constructor({ api, loadPdf, createOcr, decodeImage, batchSize = 5 }) { Object.assign(this, { api, loadPdf, createOcr, decodeImage, batchSize }); }

  async run(jobId, { onProgress = () => {}, signal } = {}) {
    const { lease, plan } = await this.api.claim(jobId);
    const tok = lease.token;
    const summary = { job_id: jobId, pages: 0, ocr_pages: 0, failed: 0, cancelled: false };
    let ocr = null; let doc = null;
    const hb = setInterval(() => { this.api.heartbeat(jobId, tok).then((r) => { if (r?.cancel_requested) summary.cancelled = true; }).catch(() => {}); }, Math.max(5, (lease.heartbeat_every_s || 30)) * 1000);
    try {
      onProgress({ stage: 'downloading', done: 0, total: 0 });
      const data = await this.api.fetchSource(jobId, tok);
      if (plan.file.sha256 && (await sha256Hex(data)) !== plan.file.sha256) throw new ProcessingError('SOURCE_CHANGED', 'the original file changed since the job was created');
      const kind = plan.file.kind;
      let total; let produce;
      if (kind === 'pdf') {
        try { doc = await this.loadPdf(data); }
        catch (e) { throw e instanceof ProcessingError ? e : new ProcessingError(/password/i.test(e?.name + e?.message) ? 'PASSWORD_PROTECTED' : 'CORRUPT_FILE', 'could not open the PDF'); }
        total = doc.numPages;
        if (total > plan.limits.max_pages_per_run) throw new ProcessingError('TOO_MANY_PAGES', `document has ${total} pages`);
        const wanted = plan.pages ? new Set(plan.pages) : null;
        const done = new Set(plan.existing_pages.filter((p) => p.status === 'ok' || p.status === 'empty').map((p) => p.page_number));
        const list = [];
        for (let n = 1; n <= total; n++) if (wanted ? wanted.has(n) : !done.has(n)) list.push(n);
        produce = { list, one: (n) => this.pdfPage(doc, n, plan, () => (ocr ||= this.createOcr({ languages: plan.languages })), summary) };
      } else if (kind === 'txt') {
        total = 1;
        produce = { list: [1], one: async () => ({ page_number: 1, location_kind: 'section', status: 'ok', method: 'text', text: new TextDecoder().decode(data) }) };
      } else {
        total = 1;
        produce = { list: [1], one: (n) => this.imagePage(data, kind, plan, () => (ocr ||= this.createOcr({ languages: plan.languages })), summary) };
      }
      let batch = []; let first = true; let processed = 0;
      const flush = async () => {
        if (!batch.length) return;
        const res = await this.api.submitPages(jobId, tok, { pages: batch, progress: { stage: 'extracting', done: processed, total: produce.list.length }, ...(first ? { run: { page_count: total } } : {}) });
        first = false; batch = [];
        if (res.cancel_requested) { summary.cancelled = true; }
      };
      for (const n of produce.list) {
        if (signal?.aborted) { summary.cancelled = true; }
        if (summary.cancelled) break;
        let page;
        try { page = await produce.one(n); }
        catch (e) { summary.failed++; page = { page_number: n, status: 'failed', method: 'ocr', text: '', error: { code: e.code || 'INTERNAL_ERROR', message: String(e.message || e).slice(0, 200), retryable: e.retryable !== false } }; }
        batch.push(page); processed++; summary.pages++;
        onProgress({ stage: 'extracting', done: processed, total: produce.list.length, pageNumber: n, status: page.status });
        if (batch.length >= this.batchSize) await flush();
      }
      await flush();
      if (summary.cancelled) return summary;
      await this.api.complete(jobId, tok);
      onProgress({ stage: 'done', done: summary.pages, total: produce.list.length });
      return summary;
    } catch (e) {
      const code = e.code && /^[A-Z_]+$/.test(e.code) ? e.code : 'INTERNAL_ERROR';
      try { await this.api.fail(jobId, tok, { code, message: String(e.message || e).slice(0, 250), retryable: e.retryable ?? !['SOURCE_CHANGED', 'PASSWORD_PROTECTED', 'CORRUPT_FILE', 'TOO_MANY_PAGES'].includes(code) }); } catch { /* lease may be gone */ }
      throw e;
    } finally {
      clearInterval(hb);
      try { await doc?.destroy(); } catch { /* ignore */ }
      try { (await ocr)?.terminate?.(); } catch { /* ignore */ }
    }
  }

  async pdfPage(doc, n, plan, getOcr, summary) {
    const text = (await doc.getText(n)) || '';
    const compact = text.replace(/\s+/g, '');
    const mode = plan.mode;
    if (compact.length >= MIN_CHARS || !plan.settings.ocr) {
      return enrich({ page_number: n, status: compact ? 'ok' : 'empty', method: 'pdf-text', text }, text);
    }
    const dpi = plan.settings.dpi || 200;
    const ocr = await getOcr();
    const image = await doc.render(n, dpi);
    const timeout = plan.settings.timeout_ms || 60000;
    let timer;
    const res = await Promise.race([
      ocr.recognize(image, { psm: plan.settings.psm || 3 }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new ProcessingError('OCR_TIMEOUT', `OCR exceeded ${timeout} ms`, true)), timeout); }),
    ]).finally(() => clearTimeout(timer));
    summary.ocr_pages++;
    const page = { page_number: n, status: 'ok', method: 'ocr', text: res.text || '', confidence: res.confidence ?? null, rotation: 0,
      ocr: { engine: 'tesseract.js', engine_version: plan.settings.engine_version || null, languages: plan.languages, dpi, psm: plan.settings.psm || 3, preprocess: plan.settings.preprocess || [] } };
    page.warnings = compact.length ? ['PARTIAL_TEXT_LAYER'] : [];
    return enrich(page, page.text);
  }

  async imagePage(data, kind, plan, getOcr, summary) {
    if (!this.decodeImage) throw new ProcessingError('UNSUPPORTED_FORMAT', 'image decoding is unavailable');
    const ocr = await getOcr();
    const image = await this.decodeImage(data, kind);
    const res = await ocr.recognize(image, { psm: plan.settings.psm || 3 });
    summary.ocr_pages++;
    const page = { page_number: 1, location_kind: 'image', status: 'ok', method: 'ocr', text: res.text || '', confidence: res.confidence ?? null,
      ocr: { engine: 'tesseract.js', languages: plan.languages, dpi: null, psm: plan.settings.psm || 3, preprocess: plan.settings.preprocess || [] } };
    return enrich(page, page.text);
  }
}

// ---------------------------------------------------------------- real-browser adapters
export function browserAdapters({ pdfjs, Tesseract, workerSrc }) {
  if (workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const loadPdf = async (data) => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
    return {
      numPages: doc.numPages,
      async getText(n) { const p = await doc.getPage(n); const c = await p.getTextContent(); p.cleanup?.(); return itemsToText(c.items); },
      async render(n, dpi) {
        const p = await doc.getPage(n);
        const vp = p.getViewport({ scale: dpi / 72 });
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        await p.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport: vp }).promise;
        p.cleanup?.();
        return canvas;
      },
      destroy: () => doc.destroy(),
    };
  };
  const createOcr = async ({ languages }) => {
    const worker = await Tesseract.createWorker(languages.join('+'));
    return {
      async recognize(canvas, { psm }) {
        await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
        const { data } = await worker.recognize(canvas);
        canvas.width = canvas.height = 0; // release memory
        return { text: data.text, confidence: Math.max(0, Math.min(1, (data.confidence || 0) / 100)) };
      },
      terminate: () => worker.terminate(),
    };
  };
  const decodeImage = async (data, kind) => {
    const bmp = await createImageBitmap(new Blob([data], { type: kind === 'jpg' ? 'image/jpeg' : `image/${kind}` }));
    const canvas = document.createElement('canvas'); canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    return canvas;
  };
  return { loadPdf, createOcr, decodeImage };
}

/** Thin API client for the protocol. Admin key lives only in memory. */
export class ApiClient {
  constructor({ base = '', adminKey = '', fetchImpl = (...a) => fetch(...a) } = {}) { this.base = base.replace(/\/+$/, ''); this.adminKey = adminKey; this.fetchImpl = fetchImpl; }
  async req(path, { method = 'GET', body, token, raw = false } = {}) {
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...((token || this.adminKey) ? { Authorization: `Bearer ${token || this.adminKey}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (raw) { if (!res.ok) throw new ProcessingError('INTERNAL_ERROR', `download failed (${res.status})`, true); return res.arrayBuffer(); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new ProcessingError(data.error || 'INTERNAL_ERROR', data.message || `request failed (${res.status})`, res.status >= 500 || res.status === 429); e.status = res.status; throw e; }
    return data;
  }
  claim(id) { return this.req(`/api/ai/jobs/${id}/claim`, { method: 'POST', body: { client: { name: 'console-browser', extractor: 'pdfjs+tesseract.js', version: '1' } } }); }
  fetchSource(id, token) { return this.req(`/api/ai/jobs/${id}/source`, { token, raw: true }); }
  submitPages(id, token, body) { return this.req(`/api/ai/jobs/${id}/pages`, { method: 'POST', token, body }); }
  heartbeat(id, token) { return this.req(`/api/ai/jobs/${id}/heartbeat`, { method: 'POST', token, body: {} }); }
  complete(id, token) { return this.req(`/api/ai/jobs/${id}/complete`, { method: 'POST', token, body: {} }); }
  fail(id, token, body) { return this.req(`/api/ai/jobs/${id}/fail`, { method: 'POST', token, body }); }
}
