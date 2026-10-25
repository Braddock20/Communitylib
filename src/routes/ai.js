import { Hono } from 'hono';
import { getDb } from '../db.js';
import { normalizeCode, normalizeText, sha256Hex, combineHashes } from '../utils/hash.js';
import { getStorage } from '../storage.js';
import { PDFDocument } from 'pdf-lib';
import { detectUnitCodeMentions, sanitizeSuggestedSegments, validateSegmentBoundaries, classifyDocumentEvidence } from '../utils/ai-classification.js';


const ai = new Hono();
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const MAX_TEXT = 24000;

function clientRateLimitKey(c) {
  // Cloudflare supplies this header to requests handled by its Worker.
  // Do not accept a client-supplied forwarding header as the identity.
  const ip = c.req.header('cf-connecting-ip');
  return ip ? `ip:${ip}` : null;
}

ai.use('*', async (c, next) => {
  // CORS preflight requests should not consume API rate-limit tokens.
  if (c.req.method === 'OPTIONS') return next();

  const path = new URL(c.req.url).pathname
  .replace(/^\/api\/ai(?=\/|$)/, '') || '/';
  const method = c.req.method;

  let binding;

  if (path === '/analyze' && method === 'POST') {
    binding = c.env.AI_CLASSIFY_LIMITER;
  } else if (
    path === '/registry/import' ||
    path === '/extract-text' ||
    path === '/apply-metadata' ||
    path === '/study' ||
    path === '/segments' ||
    /^\/segments\/\d+$/.test(path) ||
    /^\/split\/\d+$/.test(path) ||
    /^\/publish-segments\/\d+$/.test(path) ||
    path === '/merge' ||
    path === '/jobs'
  ) {
    binding = c.env.AI_ADMIN_LIMITER;
  } else {
    binding = c.env.AI_SEARCH_LIMITER;
  }

  // Fail closed if the required Cloudflare binding is missing.
  if (!binding || typeof binding.limit !== 'function') {
    console.error('AI rate-limit binding is missing', { path, method });
    return c.json({ error: 'rate_limit_unavailable' }, 503);
  }

  const key = clientRateLimitKey(c);

  // Avoid putting all requests into one shared "unknown" bucket.
  if (!key) {
    return c.json({ error: 'client_identity_unavailable' }, 503);
  }

  try {
    const { success } = await binding.limit({ key });

    if (!success) {
      return c.json(
        { error: 'rate_limit_exceeded', retry_after_seconds: 60 },
        429,
        { 'Retry-After': '60' }
      );
    }
  } catch (err) {
    // Fail closed rather than accidentally exposing unprotected AI routes.
    console.error('AI rate-limit check failed', err?.message || String(err));
    return c.json({ error: 'rate_limit_unavailable' }, 503);
  }

  await next();
});

function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}
function authorized(c) {
  const key = c.env.ADMIN_API_KEY;
  const supplied = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ||
    c.req.header('x-admin-key');
  return Boolean(key && supplied && constantTimeEqual(supplied, key));
}
function clampConfidence(value, fallback = 0.35) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}
function parseJson(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(s); } catch {}
  const match = s.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  return null;
}
function fallbackAnalysis({ text, filename, registry }) {
  return classifyDocumentEvidence({ text, filename, registry });
}

/**
 * GET /api/ai/tools
 * Machine-readable inventory of the library agent's tools and approval levels.
 * This endpoint only describes capabilities; it does not execute them.
 */
ai.get('/tools', (c) => c.json({
  name: 'Communitylib Library Agent',
  version: '1.0.0',
  execution_model: 'explicit tool calls; no destructive action is automatic',
  tools: [
    { name: 'registry_search', method: 'GET', path: '/api/ai/registry?q=', approval: 'read', description: 'Search verified unit codes, titles, aliases and provenance.' },
    { name: 'resource_inspect', method: 'GET', path: '/api/resource/:id', approval: 'read', description: 'Read resource metadata and attached files.' },
    { name: 'resource_preview', method: 'GET', path: '/api/resource/:id/preview', approval: 'read', description: 'Read preview, snippet and page-count status.' },
    { name: 'library_search', method: 'GET', path: '/api/search?q=', approval: 'read', description: 'Search units and their grouped resources.' },
    { name: 'pdf_extract_text', method: 'POST', path: '/api/ai/extract-text', approval: 'admin', description: 'Persist page text extracted client-side by PDF.js; updates page count and snippet.' },
    { name: 'document_analyze', method: 'POST', path: '/api/ai/analyze', approval: 'review', description: 'Suggest unit, document type, year, topics and possible segments from supplied text.' },
    { name: 'metadata_apply', method: 'POST', path: '/api/ai/apply-metadata', approval: 'admin_explicit', description: 'Apply metadata only after a human has reviewed the verified unit match and title.' },
    { name: 'segment_list', method: 'GET', path: '/api/ai/segments/:resourceId', approval: 'admin', description: 'Read saved page-range suggestions.' },
    { name: 'segment_save', method: 'POST', path: '/api/ai/segments', approval: 'admin', description: 'Save reviewed page-range suggestions without modifying the original.' },
    { name: 'pdf_split', method: 'POST', path: '/api/ai/split/:resourceId', approval: 'admin_and_enabled_processing', description: 'Create derived PDFs for approved page ranges; preserves the source PDF.' },
    { name: 'publish_segments', method: 'POST', path: '/api/ai/publish-segments/:resourceId', approval: 'admin_explicit', description: 'Publish generated segments as library resources.' },
    { name: 'pdf_merge', method: 'POST', path: '/api/ai/merge', approval: 'admin_and_enabled_processing', description: 'Merge selected PDFs that belong to the same unit and resource type.' },
    { name: 'processing_jobs', method: 'GET', path: '/api/ai/jobs', approval: 'admin', description: 'Inspect processing job records.' },
    { name: 'study_assistant', method: 'POST', path: '/api/ai/study', approval: 'admin', description: 'Answer a question or create a summary, flashcards or quiz from extracted resource text.' },
  ],
  safety: {
    source_preservation: true,
    suggestions_require_review: true,
    publish_requires_explicit_call: true,
    automatic_page_boundaries: 'never assumed; use page markers and review confidence',
    server_side_pdf_extraction: false,
    pdf_extraction_mode: 'browser PDF.js extracts text, then sends bounded page text to the protected API',
  },
}));

export default ai;