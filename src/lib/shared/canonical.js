// Canonical document-representation helpers.
//
// Pure ES module with NO runtime-specific APIs (only WebCrypto, available in
// browsers, Cloudflare Workers and Node >= 20). The same file is imported by the
// Worker, the browser processing client and the optional external processor so
// that every producer and consumer agrees on one page format.
//
// Terminology
//   location  - where a piece of text came from inside a source file:
//               page (PDF/image), sheet (XLSX), slide (PPTX), section (DOCX/HTML/TXT),
//               image (a standalone picture inside an archive), file (whole file).
//   page      - the canonical unit of extraction output: one location + its text,
//               structure, quality signals and provenance. PDF pages are never merged
//               into one blob; the page boundary is part of the data model.
//
// Source text and interpretations are kept apart: `text` is exactly what the
// extractor produced; reviewer corrections live in `corrected_text` (server side).

export const LOCATION_KINDS = Object.freeze(['page', 'sheet', 'slide', 'section', 'image', 'file']);
export const PAGE_STATUSES = Object.freeze(['ok', 'empty', 'low_text', 'failed', 'skipped']);
export const BLOCK_TYPES = Object.freeze(['heading', 'paragraph', 'list', 'table', 'equation', 'figure', 'caption', 'code', 'other']);
export const ROTATIONS = Object.freeze([0, 90, 180, 270]);

export const PAGE_LIMITS = Object.freeze({
  maxTextChars: 30000,
  maxBlocks: 400,
  maxBlockTextChars: 8000,
  maxTableRows: 200,
  maxTableCols: 40,
  maxListItems: 200,
  maxWarnings: 20,
  maxEquationsPerPage: 60,
  maxLabelChars: 200,
  signatureLength: 64,
  maxPagesPerSubmission: 50,
  maxPagesPerRun: 1000,
});

const LIGATURES = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st' };

/**
 * Normalise extracted text without destroying meaning.
 * - NFC (NOT NFKC: NFKC would turn x² into x2 and Ω into the wrong code point).
 * - strips NUL / C0 controls (except \n and \t), soft hyphens and zero-width characters.
 * - expands typographic ligatures, unifies line endings, trims trailing blanks,
 *   collapses runs of 3+ newlines to a single blank line.
 */
export function normalizeText(input) {
  let s = String(input ?? '');
  if (!s) return '';
  s = s.normalize('NFC');
  s = s.replace(/\r\n?/g, '\n').replace(/\u2028|\u2029/g, '\n');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = s.replace(/[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g, '');
  s = s.replace(/[\uFB00-\uFB06]/g, (m) => LIGATURES[m] || m);
  s = s.replace(/\u00A0/g, ' ');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function countWords(text) {
  const m = String(text || '').match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic JSON (sorted keys) used for settings hashes and cache keys. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export async function settingsHash(settings) {
  return (await sha256Hex(stableStringify(settings || {}))).slice(0, 16);
}

/**
 * Parse a page selection such as "1-5,9,12-14" into a sorted unique array.
 * Throws RangeError on malformed input or when the selection exceeds `max`.
 * `total` (optional) bounds the highest allowed page.
 */
export function parsePageSpec(spec, { max = PAGE_LIMITS.maxPagesPerRun, total = null } = {}) {
  if (Array.isArray(spec)) {
    const arr = spec.map(Number);
    if (arr.some((n) => !Number.isInteger(n) || n < 1)) throw new RangeError('page numbers must be positive integers');
    spec = arr.join(',');
  }
  const text = String(spec ?? '').trim();
  if (!text) return [];
  const out = new Set();
  for (const part of text.split(',')) {
    const m = part.trim().match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
    if (!m) throw new RangeError(`invalid page selection "${part.trim().slice(0, 20)}"`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a) throw new RangeError(`invalid page range "${part.trim()}"`);
    if (total && b > total) throw new RangeError(`page ${b} exceeds document length ${total}`);
    if (out.size + (b - a + 1) > max) throw new RangeError(`selection exceeds ${max} pages`);
    for (let n = a; n <= b; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

export function formatPageSpec(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(',');
}

const TOKEN_RE = /^[a-z0-9][a-z0-9._+-]{0,39}$/;
const WARNING_RE = /^[A-Z][A-Z0-9_]{1,39}$/;

function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function cleanString(value, max) {
  return normalizeText(String(value ?? '')).replace(/\s+/g, ' ').slice(0, max);
}

function sanitizeBbox(b) {
  if (!b || typeof b !== 'object') return null;
  const v = ['x', 'y', 'w', 'h'].map((k) => Number(b[k]));
  if (v.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = v.map(clamp01);
  return { x, y, w, h };
}

function sanitizeBlock(raw, limits) {
  if (!raw || typeof raw !== 'object' || !BLOCK_TYPES.includes(raw.type)) return null;
  const block = { type: raw.type };
  if (typeof raw.text === 'string') block.text = normalizeText(raw.text).slice(0, limits.maxBlockTextChars);
  if (raw.type === 'heading') block.level = Math.max(1, Math.min(6, Number.parseInt(raw.level, 10) || 1));
  if (raw.type === 'list') {
    if (!Array.isArray(raw.items)) return null;
    block.ordered = Boolean(raw.ordered);
    block.items = raw.items.slice(0, limits.maxListItems).map((i) => cleanString(i, 2000));
  }
  if (raw.type === 'table') {
    if (!Array.isArray(raw.rows)) return null;
    block.rows = raw.rows.slice(0, limits.maxTableRows).map((row) =>
      (Array.isArray(row) ? row : []).slice(0, limits.maxTableCols).map((cell) => cleanString(cell, 1000)));
  }
  if (raw.type === 'equation') {
    if (Number.isInteger(raw.equation_index) && raw.equation_index >= 0) block.equation_index = raw.equation_index;
  }
  const bbox = sanitizeBbox(raw.bbox);
  if (bbox) block.bbox = bbox;
  if (raw.confidence != null && Number.isFinite(Number(raw.confidence))) block.confidence = clamp01(Number(raw.confidence));
  return block;
}

function sanitizeWarnings(list, limits) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((w) => typeof w === 'string' && WARNING_RE.test(w)))].slice(0, limits.maxWarnings);
}

/**
 * Validate and normalise one submitted page. NEVER trusts client-computed
 * counts/hashes (the server recomputes them). Returns { ok, page, errors }.
 * `page` is only meaningful when ok is true.
 */
export function validatePage(raw, limits = PAGE_LIMITS) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['page must be an object'] };

  const location_kind = raw.location_kind ?? 'page';
  if (!LOCATION_KINDS.includes(location_kind)) errors.push(`location_kind must be one of ${LOCATION_KINDS.join(', ')}`);
  const page_number = Number(raw.page_number);
  if (!Number.isInteger(page_number) || page_number < 1 || page_number > limits.maxPagesPerRun) errors.push('page_number must be an integer between 1 and 1000');
  const status = raw.status;
  if (!PAGE_STATUSES.includes(status)) errors.push(`status must be one of ${PAGE_STATUSES.join(', ')}`);
  const method = typeof raw.method === 'string' ? raw.method.toLowerCase() : '';
  if (!TOKEN_RE.test(method)) errors.push('method must be a short lowercase token');
  if (raw.text != null && typeof raw.text !== 'string') errors.push('text must be a string');
  if (errors.length) return { ok: false, errors };

  const warnings = sanitizeWarnings(raw.warnings, limits);
  let text = normalizeText(raw.text || '');
  if (text.length > limits.maxTextChars) {
    text = text.slice(0, limits.maxTextChars);
    if (!warnings.includes('TRUNCATED')) warnings.push('TRUNCATED');
  }

  let confidence = null;
  if (raw.confidence != null) {
    const c = Number(raw.confidence);
    if (!Number.isFinite(c)) return { ok: false, errors: ['confidence must be a number between 0 and 1'] };
    confidence = Math.round(clamp01(c) * 1000) / 1000;
  }

  const blocks = Array.isArray(raw.blocks)
    ? raw.blocks.slice(0, limits.maxBlocks).map((b) => sanitizeBlock(b, limits)).filter(Boolean) : [];

  const equations = [];
  if (Array.isArray(raw.equations)) {
    const seen = new Set();
    for (const eq of raw.equations.slice(0, limits.maxEquationsPerPage)) {
      if (!eq || typeof eq !== 'object') continue;
      const idx = Number.isInteger(eq.idx) && eq.idx >= 0 ? eq.idx : equations.length;
      if (seen.has(idx)) continue;
      seen.add(idx);
      equations.push({
        idx,
        bbox: sanitizeBbox(eq.bbox),
        source_text: eq.source_text == null ? null : normalizeText(String(eq.source_text)).slice(0, 2000),
        latex: eq.latex == null ? null : String(eq.latex).slice(0, 2000),
        engine: eq.engine == null ? null : String(eq.engine).slice(0, 60),
        confidence: eq.confidence == null || !Number.isFinite(Number(eq.confidence)) ? null : Math.round(clamp01(Number(eq.confidence)) * 1000) / 1000,
        warnings: sanitizeWarnings(eq.warnings, limits),
      });
    }
  }

  let signature = null;
  if (Array.isArray(raw.signature) && raw.signature.length === limits.signatureLength
    && raw.signature.every((n) => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647)) {
    signature = raw.signature;
  }

  let ocr = null;
  if (raw.ocr && typeof raw.ocr === 'object') {
    ocr = {
      engine: cleanString(raw.ocr.engine, 60) || null,
      engine_version: cleanString(raw.ocr.engine_version, 40) || null,
      languages: Array.isArray(raw.ocr.languages) ? raw.ocr.languages.map((l) => cleanString(l, 16)).filter(Boolean).slice(0, 6) : [],
      dpi: Number.isFinite(Number(raw.ocr.dpi)) ? Math.max(0, Math.min(1200, Math.round(Number(raw.ocr.dpi)))) : null,
      psm: Number.isInteger(raw.ocr.psm) ? raw.ocr.psm : null,
      preprocess: Array.isArray(raw.ocr.preprocess) ? raw.ocr.preprocess.map((p) => cleanString(p, 30)).filter(Boolean).slice(0, 10) : [],
      cache_key: cleanString(raw.ocr.cache_key, 128) || null,
      cache_hit: Boolean(raw.ocr.cache_hit),
    };
  }

  let error = null;
  if (status === 'failed') {
    const e = raw.error && typeof raw.error === 'object' ? raw.error : {};
    error = {
      code: /^[A-Z][A-Z0-9_]{1,39}$/.test(e.code || '') ? e.code : 'PAGE_FAILED',
      message: cleanString(e.message || 'Page extraction failed', 300),
      retryable: e.retryable !== false,
    };
  }

  const rotation = raw.rotation == null ? null : (ROTATIONS.includes(Number(raw.rotation)) ? Number(raw.rotation) : null);
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

  return {
    ok: true,
    errors: [],
    page: {
      location_kind,
      page_number,
      label: raw.label == null ? null : cleanString(raw.label, limits.maxLabelChars) || null,
      status,
      method,
      text,
      confidence,
      blocks,
      equations,
      warnings,
      language: raw.language == null ? null : cleanString(raw.language, 12).toLowerCase() || null,
      rotation,
      width: num(raw.width),
      height: num(raw.height),
      ocr,
      signature,
      error,
    },
  };
}

/** Convenience constructor used by extractors so they all emit the same shape. */
export function buildPage({ location_kind = 'page', page_number, label = null, method, text = '', confidence = null, blocks = [], equations = [],
  warnings = [], language = null, rotation = null, width = null, height = null, ocr = null, signature = null, status, error = null }) {
  const t = normalizeText(text);
  return {
    location_kind, page_number, label, status: status || (t ? 'ok' : 'empty'), method, text: t, confidence, blocks, equations,
    warnings, language, rotation, width, height, ocr, signature, ...(error ? { error } : {}),
  };
}

/**
 * Cache key for an OCR result: identical inputs must give an identical key, and any
 * change that can change the output (source bytes, page, engine, version, language,
 * render + preprocess settings) must change it.
 */
export async function ocrCacheKey({ sourceSha256, page, engine, engineVersion, languages, dpi, psm, preprocess = [], mode = 'standard' }) {
  return sha256Hex(stableStringify({
    s: sourceSha256, p: page, e: engine, v: engineVersion,
    l: [...(languages || [])].sort(), d: dpi, m: psm, pp: [...preprocess].sort(), q: mode,
  }));
}
