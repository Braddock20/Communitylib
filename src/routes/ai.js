import { Hono } from 'hono';
import { getDb } from '../db.js';
import { normalizeCode, normalizeText, sha256Hex, combineHashes } from '../utils/hash.js';
import { getStorage } from '../storage.js';
import { PDFDocument } from 'pdf-lib';
import { detectUnitCodeMentions, sanitizeSuggestedSegments, validateSegmentBoundaries } from '../utils/ai-classification.js';


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
  const haystack = `${filename || ''}\n${text || ''}`;
  const codeCandidate = normalizeCode(
    haystack.match(/\b[A-Z]{2,8}[\s_-]*\d{2,4}[A-Z]?\b/i)?.[0] || ''
  );
  const detectedByCode = detectUnitCodeMentions(haystack, registry);
  const detected = [...detectedByCode];
  const already = new Set(detected.map((u) => String(u.id ?? normalizeCode(u.code))));

  // Search titles/aliases as well as explicit codes. A combined document may
  // name one unit by code and a second only by its full title.
  {
    for (const unit of registry) {
      const key = String(unit.id ?? normalizeCode(unit.code));
      const candidates = [unit.title, ...(Array.isArray(unit.aliases) ? unit.aliases : [])]
        .filter((value) => typeof value === 'string' && value.trim().length >= 5);
      const match = candidates.some((candidate) => {
        const phrase = candidate.trim().toLowerCase();
        return haystack.toLowerCase().includes(phrase);
      });
      if (match && !already.has(key)) {
        already.add(key);
        detected.push({ id: unit.id ?? null, code: unit.code, title: unit.title });
      }
    }
  }

  const isMultiUnit = detected.length > 1;
  const primary = detected[0] || null;
  const verifiedCode = primary ? normalizeCode(primary.code) : '';
  const unverifiedCandidate = codeCandidate && codeCandidate !== verifiedCode ? codeCandidate : null;
  const type = /\b(cat|continuous assessment|test)\b/i.test(haystack) ? 'cat'
    : /\b(supplementary|special|end.of.semester|final exam|examination|exam)\b/i.test(haystack) ? 'exam'
    : /\b(assignment|coursework)\b/i.test(haystack) ? 'assignment' : 'notes';
  const yearMatch = haystack.match(/\b(20(?:0\d|1\d|2[0-9]))\b/);

  return {
    unit_id: primary?.id ?? null,
    unit_code: primary?.code ?? (codeCandidate || null),
    unit_title: primary?.title ?? null,
    unit_code_verified: Boolean(primary),
    unverified_code_candidate: unverifiedCandidate,
    type,
    academic_year: yearMatch ? Number(yearMatch[1]) : null,
    display_title: filename ? filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() : (primary?.title || 'Untitled document'),
    topics: [],
    confidence: primary ? (isMultiUnit ? 0.55 : 0.62) : (codeCandidate ? 0.25 : 0.1),
    reason: isMultiUnit
      ? `Document appears to contain multiple registry units: ${detected.map((u) => u.code).join(', ')}. Manual review required.`
      : primary
        ? 'Matched filename/text to a known registry unit using deterministic fallback rules.'
        : 'No reliable registry match; human review recommended.',
    segments: [],
    requires_review: isMultiUnit || !primary,
    detected_units: detected,
    is_multi_unit_document: isMultiUnit,
    provider: 'rules-fallback',
  };
}

/**
 * GET /api/ai/registry?q=...
 * Registry entries with provenance and aliases. This endpoint is read-only.
 */
ai.get('/registry', async (c) => {
  const q = (c.req.query('q') || '').trim().slice(0, 160);
  const sql = await getDb(c.env);
  const rows = q ? await sql`
    SELECT u.id, u.code, u.code_display, u.title, u.year_of_study, u.resource_count,
      COALESCE((SELECT json_agg(json_build_object('alias', a.alias, 'source', a.source, 'confidence', a.confidence))
        FROM unit_aliases a WHERE a.unit_id = u.id), '[]'::json) AS aliases,
      COALESCE((SELECT json_agg(json_build_object('source_name', s.source_name, 'source_type', s.source_type,
        'source_date', s.source_date, 'confidence', s.confidence))
        FROM unit_sources s WHERE s.unit_id = u.id), '[]'::json) AS sources
    FROM units u
    WHERE u.code ILIKE ${'%' + normalizeCode(q) + '%'}
       OR u.code_display ILIKE ${'%' + q + '%'}
       OR u.title ILIKE ${'%' + q + '%'}
       OR EXISTS (SELECT 1 FROM unit_aliases a WHERE a.unit_id=u.id AND a.alias ILIKE ${'%' + q + '%'})
    ORDER BY u.code, u.title LIMIT 100
  ` : await sql`
    SELECT u.id, u.code, u.code_display, u.title, u.year_of_study, u.resource_count,
      COALESCE((SELECT json_agg(json_build_object('alias', a.alias, 'source', a.source, 'confidence', a.confidence))
        FROM unit_aliases a WHERE a.unit_id = u.id), '[]'::json) AS aliases,
      COALESCE((SELECT json_agg(json_build_object('source_name', s.source_name, 'source_type', s.source_type,
        'source_date', s.source_date, 'confidence', s.confidence))
        FROM unit_sources s WHERE s.unit_id = u.id), '[]'::json) AS sources
    FROM units u ORDER BY u.code, u.title LIMIT 100
  `;
  return c.json({ count: rows.length, registry: rows, truncated: rows.length === 100 });
});

/**
 * POST /api/ai/registry/import
 * Admin-only, upserts supplied registry rows and records provenance.
 * Body: {source_name, source_type, source_date, units:[{code,title,aliases?,year_of_study?,confidence?}]}
 * Imported rows are evidence, not a claim that a timetable is a definitive catalogue.
 */
ai.post('/registry/import', async (c) => {
  if (!authorized(c)) return c.json({ error: 'admin authorization required' }, 401);
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'valid JSON body required' }, 400); }
  if (!Array.isArray(body.units) || body.units.length === 0 || body.units.length > 2000) {
    return c.json({ error: 'units must be an array containing 1-2000 entries' }, 400);
  }
  const sourceName = String(body.source_name || 'unspecified import').slice(0, 200);
  const sourceType = ['official_catalogue','official_timetable','faculty_list','manual','unverified'].includes(body.source_type)
    ? body.source_type : 'unverified';
  const sourceDateCandidate = String(body.source_date || '');
  let sourceDate = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(sourceDateCandidate)) {
    const parsedDate = new Date(`${sourceDateCandidate}T00:00:00Z`);
    if (!Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0,10) === sourceDateCandidate) sourceDate = sourceDateCandidate;
  }
  const sql = await getDb(c.env);
  const imported = [], rejected = [], valid = [];
  for (let i = 0; i < body.units.length; i++) {
    const item = body.units[i] || {};
    const rawCode = String(item.code || '').trim();
    const title = String(item.title || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const code = normalizeCode(rawCode);
    if (!code || code.length > 40 || !title || title.length < 2) {
      rejected.push({ index: i, reason: 'missing or invalid code/title' }); continue;
    }
    const confidence = clampConfidence(item.confidence, sourceType === 'official_catalogue' ? 0.95 : sourceType === 'official_timetable' ? 0.7 : 0.5);
    const yearValue = Number(item.year_of_study);
    const year = Number.isInteger(yearValue) && yearValue >= 1 && yearValue <= 6 ? yearValue : null;
    valid.push({ index: i, code, code_display: rawCode.slice(0,80), title, year_of_study: year, confidence,
      notes: item.notes ? String(item.notes).slice(0,500) : null,
      aliases: Array.isArray(item.aliases) ? item.aliases.slice(0,30).map((a)=>String(a || '').trim().replace(/\s+/g,' ').slice(0,200)).filter(Boolean) : [] });
  }
  const uniqueRows = new Map();
  for (const u of valid) {
    const key = `${u.code}\u0000${u.title.toLowerCase()}`;
    if (!uniqueRows.has(key)) uniqueRows.set(key, u);
  }
  valid.length = 0; valid.push(...uniqueRows.values());
  if (valid.length) {
    const unitsJson = JSON.stringify(valid.map(({code,code_display,title,year_of_study})=>({code,code_display,title,year_of_study})));
    const saved = await sql`
      INSERT INTO units(code,code_display,title,year_of_study)
      SELECT x.code,x.code_display,x.title,x.year_of_study
      FROM jsonb_to_recordset(${unitsJson}::jsonb) AS x(code text,code_display text,title text,year_of_study smallint)
      WHERE true
      ON CONFLICT(code,title) DO UPDATE SET
        code_display=CASE WHEN length(EXCLUDED.code_display)>0 THEN EXCLUDED.code_display ELSE units.code_display END,
        year_of_study=COALESCE(EXCLUDED.year_of_study,units.year_of_study)
      RETURNING id,code,code_display,title
    `;
    const sourceRows = JSON.stringify(valid.map((u)=>({code:u.code,title:u.title,source_name:sourceName,
      source_reference:body.source_reference ? String(body.source_reference).slice(0,500) : null,
      source_date:sourceDate,source_type:sourceType,confidence:u.confidence,notes:u.notes})));
    await sql`
      INSERT INTO unit_sources(unit_id,source_name,source_reference,source_date,source_type,confidence,notes)
      SELECT u.id,x.source_name,x.source_reference,x.source_date,x.source_type,x.confidence,x.notes
      FROM jsonb_to_recordset(${sourceRows}::jsonb) AS x(code text,title text,source_name text,source_reference text,source_date date,source_type text,confidence numeric,notes text)
      JOIN units u ON u.code=x.code AND u.title=x.title
      WHERE true
    `;
    const aliasRows = [];
    for (const u of valid) for (const alias of u.aliases) aliasRows.push({code:u.code,title:u.title,alias,normalized_alias:normalizeText(alias),source:sourceName,confidence:u.confidence});
    if (aliasRows.length) {
      await sql`
        INSERT INTO unit_aliases(unit_id,alias,normalized_alias,source,confidence)
        SELECT u.id,x.alias,x.normalized_alias,x.source,x.confidence
        FROM jsonb_to_recordset(${JSON.stringify(aliasRows)}::jsonb) AS x(code text,title text,alias text,normalized_alias text,source text,confidence numeric)
        JOIN units u ON u.code=x.code AND u.title=x.title
        WHERE true
        ON CONFLICT(unit_id,normalized_alias) DO UPDATE SET
          alias=EXCLUDED.alias,source=EXCLUDED.source,confidence=GREATEST(unit_aliases.confidence,EXCLUDED.confidence)
      `;
    }
    const byKey = new Map(saved.map((u)=>[`${u.code}\u0000${u.title}`,u]));
    for (const u of valid) {
      const row = byKey.get(`${u.code}\u0000${u.title}`);
      imported.push({ id: row?.id || null, code: row?.code_display || u.code_display, title: u.title, confidence: u.confidence, source_type: sourceType });
    }
  }
  await sql`INSERT INTO ai_audit_log (action, actor, entity_type, details)
    VALUES ('registry_import', 'admin', 'unit_registry', ${JSON.stringify({source_name: sourceName, source_type: sourceType, imported: imported.length, rejected: rejected.length})}::jsonb)`;
  return c.json({ imported_count: imported.length, rejected_count: rejected.length, imported, rejected });
});

/**
 * POST /api/ai/analyze
 * Suggest metadata from extracted text/filename. Suggestions never write metadata.
 * AI binding is optional; deterministic fallback works without it.
 */
ai.post('/analyze', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'valid JSON body required' }, 400); }
  const text = String(body.text || '').slice(0, MAX_TEXT);
  const filename = String(body.filename || '').slice(0, 255);
  if (!text.trim() && !filename.trim()) return c.json({ error: 'text or filename is required' }, 400);
  const sql = await getDb(c.env);
  const searchable = `${filename} ${text.slice(0, 2400)}`.replace(/\s+/g, ' ').slice(0, 500);
  const codeCandidate = normalizeCode(searchable.match(/\b[A-Z]{2,8}[\s_-]*\d{2,4}[A-Z]?\b/i)?.[0] || '');
  let registry = await sql`
    SELECT u.id, u.code, u.code_display AS display_code, u.title,
      COALESCE((SELECT array_agg(a.alias) FROM unit_aliases a WHERE a.unit_id=u.id), ARRAY[]::text[]) AS aliases
    FROM units u
    WHERE (${codeCandidate || ''} <> '' AND u.code ILIKE ${'%' + codeCandidate + '%'})
       OR similarity(u.title, ${searchable}) > 0.12
       OR EXISTS (SELECT 1 FROM unit_aliases a WHERE a.unit_id=u.id AND (similarity(a.alias, ${searchable}) > 0.12 OR a.normalized_alias ILIKE ${'%' + normalizeText(searchable.slice(0,80)) + '%'}))
    ORDER BY (u.code ILIKE ${'%' + codeCandidate + '%'}) DESC, similarity(u.title, ${searchable}) DESC, u.resource_count DESC LIMIT 80
  `;
  if (registry.length === 0) {
    registry = await sql`
      SELECT u.id, u.code, u.code_display AS display_code, u.title,
        COALESCE((SELECT array_agg(a.alias) FROM unit_aliases a WHERE a.unit_id=u.id), ARRAY[]::text[]) AS aliases
      FROM units u ORDER BY u.resource_count DESC, u.code LIMIT 40
    `;
  }
  const known = registry.map((u) => ({ id: u.id, code: u.display_code, title: u.title, aliases: u.aliases || [] }));
  // Keep the AI candidate query small, but scan the complete registry for code mentions.
  const scanRows = await sql`
    SELECT u.id, u.code, u.code_display, u.title,
      COALESCE(a.aliases, ARRAY[]::text[]) AS aliases
    FROM units u
    LEFT JOIN (
      SELECT unit_id, array_agg(alias ORDER BY alias) AS aliases
      FROM unit_aliases GROUP BY unit_id
    ) a ON a.unit_id = u.id
    ORDER BY u.code, u.title
  `;
  const allKnown = scanRows.map((u) => ({
    id: u.id, code: u.code_display || u.code, code_display: u.code_display || u.code,
    normalized_code: normalizeCode(u.code), title: u.title, aliases: u.aliases || []
  }));
  const unitsByNormalizedCode = new Map();
  for (const unit of allKnown) {
    const code = normalizeCode(unit.code);
    if (!code) continue;
    if (!unitsByNormalizedCode.has(code)) unitsByNormalizedCode.set(code, []);
    unitsByNormalizedCode.get(code).push(unit);
  }
  let suggestion = null;
  let provider = 'rules-fallback';
  const publicAiEnabled = String(c.env.AI_PUBLIC_ENABLED || 'false').trim().toLowerCase() === 'true';
  console.info('AI analyze diagnostics', {
  aiBindingAvailable: Boolean(c.env.AI),
  publicAiEnabled,
  hasText: Boolean(text.trim()),
  model: c.env.AI_MODEL || MODEL,
});
  if (c.env.AI && publicAiEnabled && text.trim()) {
    try {
      const prompt = `You classify university study documents. Use ONLY the supplied registry to identify a unit. Never invent a code or title. If no exact/strong match exists, set unit_code and unit_title to null. Return only valid JSON with keys: unit_code, unit_title, type (notes|cat|exam|assignment|other), academic_year (integer or null), display_title (string), topics (array of strings), confidence (0..1), reason (short string), detected_units (array of registry units detected), segments (array; each has title, unit_code, page_start, page_end, confidence). Do not assert page ranges unless the text explicitly includes page markers. Segments are review suggestions only. If multiple units are present, list all of them in detected_units and require review. Registry: ${JSON.stringify(known)}\nFilename: ${filename}\nDocument text:\n${text}`;
      const result = await c.env.AI.run(c.env.AI_MODEL || MODEL, {
        messages: [
          { role: 'system', content: 'You are a cautious document metadata classifier. Never fabricate university unit codes. Output one valid JSON object only. Include every registry unit explicitly referenced in the document in detected_units. Never invent page boundaries.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1200,
        ...(String(c.env.AI_JSON_MODE || 'false').trim().toLowerCase() === 'true'
          ? { response_format: { type: 'json_object' } }
          : {}),
      });
      const output = result?.response ?? result?.output_text ?? result?.result ?? '';
      suggestion = output && typeof output === 'object' && !Array.isArray(output)
        ? output
        : parseJson(output);

if (suggestion) {
  provider = 'cloudflare-workers-ai';
} else {
  console.warn('Workers AI returned no parseable JSON', {
    model: c.env.AI_MODEL || MODEL,
    resultKeys: result && typeof result === 'object'
      ? Object.keys(result)
      : [],
    outputType: typeof output,
    outputLength: String(output).length,
  });
}
    } catch (err) {
      console.warn('Workers AI analysis unavailable; using deterministic fallback', err?.message || String(err));
    }
  }
  if (!suggestion) suggestion = fallbackAnalysis({ text, filename, registry: allKnown });

  const mentionedUnits = detectUnitCodeMentions(`${filename}\n${text}`, allKnown);
  const modelDetected = Array.isArray(suggestion.detected_units) ? suggestion.detected_units : [];
  const mergedDetected = [];
  const seenDetected = new Set();
  for (const candidate of [...modelDetected, ...(suggestion.unit_code ? [{ unit_code: suggestion.unit_code }] : []), ...(Array.isArray(suggestion.segments) ? suggestion.segments : []).map((s) => ({
    unit_code: s?.unit_code
  })), ...mentionedUnits]) {
    const candidateCode = normalizeCode(candidate?.code || candidate?.code_display || candidate?.unit_code || candidate?.normalized_code || '');
    const matchedUnit = allKnown.find((u) => (candidate?.id != null && String(u.id) === String(candidate.id)) ||
      normalizeCode(u.code) === candidateCode || normalizeCode(u.normalized_code) === candidateCode);
    if (!matchedUnit) continue;
    const key = String(matchedUnit.id);
    if (seenDetected.has(key)) continue;
    seenDetected.add(key);
    mergedDetected.push({ id: matchedUnit.id, code: matchedUnit.code, title: matchedUnit.title });
  }
  const mentionedCodeSet = new Set(mentionedUnits.map((unit) => normalizeCode(unit.code)));
  const registryAmbiguities = [...unitsByNormalizedCode.entries()]
    .filter(([code, candidates]) => candidates.length > 1 && mentionedCodeSet.has(code))
    .map(([code, candidates]) => ({
      code,
      candidates: candidates.map(({ id, code: displayCode, title }) => ({ id, code: displayCode, title })),
    }));
  const uniqueDetectedCodes = new Set(mergedDetected.map((unit) => normalizeCode(unit.code)));
  const isMultiUnitDocument = uniqueDetectedCodes.size > 1;
  // Prefer a verified AI-selected unit; if the model omitted or hallucinated
  // its primary code, fall back to the first unit independently verified in
  // the full registry scan. Unknown AI codes never override verified evidence.
  const rawCode = suggestion.unit_code ? normalizeCode(suggestion.unit_code) : '';
  const matchedByModel = rawCode
    ? allKnown.find((u) => normalizeCode(u.code) === rawCode) || null
    : null;
  const fallbackPrimary = mergedDetected[0] || null;
  const matched = matchedByModel || (fallbackPrimary
    ? allKnown.find((u) => String(u.id) === String(fallbackPrimary.id)) || fallbackPrimary
    : null);
  const rawType = ['notes','cat','exam','assignment','other'].includes(suggestion.type) ? suggestion.type : 'other';
  const year = Number.isInteger(Number(suggestion.academic_year)) && Number(suggestion.academic_year) >= 1900 && Number(suggestion.academic_year) <= 2100
    ? Number(suggestion.academic_year) : null;
  const segments = sanitizeSuggestedSegments(suggestion.segments, allKnown);

  const confidence = clampConfidence(suggestion.confidence, 0.3);
  return c.json({
    suggestions: {
      unit_id: matched?.id || null,
      unit_code: matched?.code || null,
      unit_title: matched?.title || null,
      unit_code_verified: Boolean(matched),
      unverified_code_candidate: rawCode && !matchedByModel ? String(suggestion.unit_code).slice(0,40) : null,
      type: rawType,
      academic_year: year,
      display_title: String(suggestion.display_title || filename.replace(/\.[^.]+$/, '') || 'Untitled document').slice(0,200),
      topics: Array.isArray(suggestion.topics) ? [...new Set(suggestion.topics.map((t) => String(t).trim().slice(0,120)).filter(Boolean))].slice(0,30) : [],
      confidence,
      reason: String(registryAmbiguities.length ? `Registry has conflicting titles for ${registryAmbiguities.map((x) => x.code).join(', ')}; review the unit match. ${suggestion.reason || ''}` : (isMultiUnitDocument && !/multiple/i.test(String(suggestion.reason || '')) ? `Document appears to contain multiple units: ${mergedDetected.map((x) => x.code).join(', ')}. Manual review required. ${suggestion.reason || ''}` : (suggestion.reason || 'Review this suggestion before applying it.'))).slice(0,500),
      segments,
      detected_units: mergedDetected,
      registry_ambiguities: registryAmbiguities,
      is_multi_unit_document: isMultiUnitDocument,
      requires_review: confidence < 0.8 || !matched || segments.length > 0 || isMultiUnitDocument || registryAmbiguities.length > 0,
      provider,
    },
    detected_units: mergedDetected,
    registry_ambiguities: registryAmbiguities,
    is_multi_unit_document: isMultiUnitDocument,
    registry_matches: mergedDetected.map(({id,code,title})=>({id,code,title})),
    disclaimer: 'Metadata is a suggestion only. Confirm unit and page boundaries before saving or splitting files.',
  });
});

/**
 * GET /api/ai/segments/:resourceId and POST /api/ai/segments
 * Store/retrieve AI-proposed split boundaries. Saving a suggestion does not
 * physically split the original PDF; it creates a reviewable page-range plan.
 */
ai.get('/segments/:resourceId', async (c) => {
  if (!authorized(c)) return c.json({ error: 'admin authorization required' }, 401);
  const id = c.req.param('resourceId');
  if (!/^\d+$/.test(id)) return c.json({ error: 'invalid resource id' }, 400);
  const sql = await getDb(c.env);
  const rows = await sql`SELECT * FROM document_segments WHERE resource_id=${id} ORDER BY segment_index`;
  return c.json({ resource_id: id, segments: rows });
});

ai.post('/segments', async (c) => {
  if (!authorized(c)) return c.json({ error: 'admin authorization required' }, 401);
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'valid JSON body required' }, 400); }
  if (!/^\d+$/.test(String(body.resource_id || '')) || !Array.isArray(body.segments) || body.segments.length < 1 || body.segments.length > 50) {
    return c.json({ error: 'resource_id and 1-50 segments are required' }, 400);
  }
  const boundaryErrors = validateSegmentBoundaries(body.segments, null);
  if (boundaryErrors.length) {
    return c.json({ error: 'Invalid segment boundaries', details: boundaryErrors }, 400);
  }
  const sql = await getDb(c.env);
  const [resource] = await sql`SELECT id FROM resources WHERE id=${body.resource_id}`;
  if (!resource) return c.json({ error: 'resource not found' }, 404);
  const saved = [];
  for (let i=0; i<body.segments.length; i++) {
    const seg = body.segments[i] || {};
    const start = Number(seg.page_start), end = Number(seg.page_end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return c.json({ error: `segment ${i+1} has invalid page range` }, 400);
    }
    const code = seg.unit_code ? normalizeCode(seg.unit_code) : '';
    const [unit] = code ? await sql`SELECT id FROM units WHERE code=${code} ORDER BY id LIMIT 1` : [null];
    const [row] = await sql`
      INSERT INTO document_segments(resource_id,segment_index,unit_id,title,page_start,page_end,confidence,status,notes)
      VALUES(${body.resource_id},${i+1},${unit?.id || null},${String(seg.title || `Part ${i+1}`).slice(0,200)},
        ${start},${end},${clampConfidence(seg.confidence,0.3)},'suggested',
        ${String(seg.notes || 'AI/user supplied suggestion; review before extracting pages.').slice(0,500)})
      ON CONFLICT(resource_id,segment_index) DO UPDATE SET
        unit_id=EXCLUDED.unit_id,title=EXCLUDED.title,page_start=EXCLUDED.page_start,page_end=EXCLUDED.page_end,
        confidence=EXCLUDED.confidence,status='suggested',notes=EXCLUDED.notes
      RETURNING *
    `;
    saved.push(row);
  }
  return c.json({ resource_id: body.resource_id, saved_count: saved.length, segments: saved, note: 'Page ranges are saved as suggestions; the original file has not been changed or split.' });
});

function objectKeyFromProxyUrl(value) {
  const raw = String(value || '');
  const marker = '/api/files/';
  const i = raw.indexOf(marker);
  if (i < 0) return null;
  try { return decodeURIComponent(raw.slice(i + marker.length).split('?')[0]); } catch { return null; }
}

const MAX_PDF_PROCESSING_BYTES = 15 * 1024 * 1024;
const MAX_MERGE_SOURCES = 5;

async function getResourcePdfMetadata(sql, storage, resourceId) {
  const [resource] = await sql`SELECT * FROM resources WHERE id=${resourceId} AND is_flagged=false`;
  if (!resource) throw new Error('resource not found or not available');
  let key = objectKeyFromProxyUrl(resource.combined_pdf_url);
  if (!key) {
    const files = await sql`SELECT file_url,file_ext FROM resource_files WHERE resource_id=${resourceId} ORDER BY order_index`;
    if (files.length !== 1 || String(files[0].file_ext).toLowerCase() !== 'pdf') {
      throw new Error('source must be one PDF file or a resource with a combined PDF');
    }
    key = objectKeyFromProxyUrl(files[0].file_url);
  }
  if (!key) throw new Error('source file is not stored behind the Communitylib file proxy');

  // HEAD before GET: reject oversized objects before buffering them into
  // Worker memory. A missing/unknown content length fails closed.
  const head = await storage.headObject(key);
  if (!head.exists) throw new Error('source PDF not found in storage');
  if (!Number.isFinite(head.contentLength)) throw new Error('source PDF size could not be verified');
  if (head.contentLength > MAX_PDF_PROCESSING_BYTES) {
    throw new Error('PDF exceeds the 15 MB processing limit');
  }
  return { resource, key, contentLength: head.contentLength };
}

async function loadResourcePdf(storage, metadata) {
  const bytes = await storage.getObject(metadata.key);
  if (bytes.byteLength > MAX_PDF_PROCESSING_BYTES) {
    throw new Error('PDF exceeds the 15 MB processing limit');
  }
  let pdf;
  try { pdf = await PDFDocument.load(bytes); }
  catch { throw new Error('source PDF is corrupt, password-protected, or unsupported'); }
  return { ...metadata, bytes, pdf };
}

async function getResourcePdf(sql, storage, resourceId) {
  const metadata = await getResourcePdfMetadata(sql, storage, resourceId);
  return loadResourcePdf(storage, metadata);
}

/** Admin-only physical PDF splitting. Original source remains untouched. */
ai.post('/split/:resourceId', async (c) => {
  if (!authorized(c)) return c.json({ error: 'admin authorization required' }, 401);
  if (String(c.env.PDF_PROCESSING_ENABLED || 'false').trim().toLowerCase() !== 'true') {
    return c.json({ error: 'pdf_processing_disabled', message: 'Synchronous PDF processing is disabled until the Worker CPU plan is confirmed or processing is moved off-request.' }, 503);
  }
  const resourceId = c.req.param('resourceId');
  if (!/^\d+$/.test(resourceId)) return c.json({ error: 'invalid resource id' }, 400);
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'valid JSON body required' }, 400); }
  if (!Array.isArray(body.segments) || body.segments.length < 1 || body.segments.length > 50) {
    return c.json({ error: 'segments must contain 1-50 page ranges' }, 400);
  }
  const sql = await getDb(c.env);
  const storage = getStorage(c.env);
  let source;
  try { source = await getResourcePdf(sql, storage, resourceId); }
  catch (err) {
    const status = err.message === 'resource not found or not available' ? 404
      : /processing limit/.test(err.message) ? 413 : 400;
    return c.json({ error: err.message }, status);
  }
  const pageCount = source.pdf.getPageCount();
  const boundaryErrors = validateSegmentBoundaries(body.segments, pageCount);
  if (boundaryErrors.length) {
    return c.json({ error: 'Invalid segment boundaries', details: boundaryErrors }, 400);
  }
  const ranges = body.segments.map((seg, i) => ({
    index: i + 1, title: String(seg.title || `Part ${i+1}`).slice(0,200),
    unit_code: seg.unit_code ? normalizeCode(seg.unit_code) : '',
    start: Number(seg.page_start), end: Number(seg.page_end), confidence: clampConfidence(seg.confidence, 1),
  }));
  for (const r of ranges) {
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 1 || r.end < r.start || r.end > pageCount) {
      return c.json({ error: `segment ${r.index} must have a valid page range between 1 and ${pageCount}` }, 400);
    }
    if (r.unit_code) {
      const [u] = await sql`SELECT id FROM units WHERE code=${r.unit_code} ORDER BY id LIMIT 1`;
      if (!u) return c.json({ error: `unknown unit code for segment ${r.index}; import/verify it first` }, 400);
      r.unit_id = u.id;
    } else r.unit_id = source.resource.unit_id;
  }
  const ordered = [...ranges].sort((a,b)=>a.start-b.start);
  for (let i=1;i<ordered.length;i++) if (ordered[i].start <= ordered[i-1].end) {
    return c.json({ error: 'segment page ranges overlap; adjust them before splitting' }, 400);
  }
  const uploaded = [];
  let totalGeneratedBytes = 0;
  const previousGenerated = await sql`
    SELECT segment_index, generated_file_key
    FROM document_segments
    WHERE resource_id=${resourceId} AND status='generated' AND generated_file_key IS NOT NULL
  `;
  try {
    for (const r of ranges) {
      const output = await PDFDocument.create();
      const indices = Array.from({length:r.end-r.start+1},(_,i)=>r.start-1+i);
      const pages = await output.copyPages(source.pdf, indices);
      for (const page of pages) output.addPage(page);
      const bytes = await output.save();
      totalGeneratedBytes += bytes.byteLength;
      if (bytes.byteLength > MAX_PDF_PROCESSING_BYTES || totalGeneratedBytes > 25 * 1024 * 1024) {
        throw new Error('generated segments exceed the 25 MB total output limit');
      }
      const key = `units/${r.unit_id}/derived/${crypto.randomUUID()}-pages-${r.start}-${r.end}.pdf`;
      const stored = await storage.putObject(key, bytes, 'application/pdf');
      uploaded.push({ ...r, key, url: stored.url, bytes: bytes.byteLength, hash: await sha256Hex(bytes) });
    }

    // One database statement keeps segment metadata all-or-nothing.
    const segmentJson = JSON.stringify(uploaded.map((r) => ({
      segment_index: r.index,
      unit_id: r.unit_id,
      title: r.title,
      page_start: r.start,
      page_end: r.end,
      confidence: r.confidence,
      generated_file_key: r.key,
    })));
    await sql`
      INSERT INTO document_segments
        (resource_id,segment_index,unit_id,title,page_start,page_end,confidence,status,source_resource_id,generated_file_key,notes)
      SELECT ${resourceId},x.segment_index,x.unit_id,x.title,x.page_start,x.page_end,x.confidence,
        'generated',${resourceId},x.generated_file_key,
        'Generated from a copied page range; original PDF retained.'
      FROM jsonb_to_recordset(${segmentJson}::jsonb) AS x(
        segment_index integer,unit_id integer,title text,page_start integer,page_end integer,
        confidence numeric,generated_file_key text
      )
      ON CONFLICT(resource_id,segment_index) DO UPDATE SET
        unit_id=EXCLUDED.unit_id,title=EXCLUDED.title,page_start=EXCLUDED.page_start,
        page_end=EXCLUDED.page_end,confidence=EXCLUDED.confidence,status='generated',
        source_resource_id=EXCLUDED.source_resource_id,generated_file_key=EXCLUDED.generated_file_key,
        notes=EXCLUDED.notes
    `;
  } catch (err) {
    await Promise.allSettled(uploaded.map((r)=>storage.deleteObject(r.key)));
    console.error('PDF split failed', err?.message || String(err));
    const message = err?.message || String(err);
    return c.json({ error: 'PDF split failed; generated objects were cleaned up where possible', detail: message },
      /processing limit|total output limit/.test(message) ? 413 : 500);
  }

  // Remove stale generated rows if this re-split now has fewer segments.
  try {
    await sql`
      DELETE FROM document_segments
      WHERE resource_id=${resourceId} AND status='generated' AND segment_index > ${uploaded.length}
    `;
  } catch (err) {
    console.error('Could not remove stale generated segment rows', err?.message || String(err));
  }

  // Delete replaced objects only after the new segment rows have committed.
  const currentKeys = new Set(uploaded.map((r) => r.key));
  const replacedKeys = previousGenerated.map((r) => r.generated_file_key).filter((key) => key && !currentKeys.has(key));
  const deletableKeys = [];
  for (const key of replacedKeys) {
    const fileUrl = `/api/files/${String(key).split('/').map(encodeURIComponent).join('/')}`;
    try {
      const [referenced] = await sql`SELECT id FROM resource_files WHERE file_url=${fileUrl} LIMIT 1`;
      // A previously published segment may still be an ordinary library resource.
      if (!referenced) deletableKeys.push(key);
    } catch (err) {
      // If we cannot verify references, keep the old object rather than risk
      // breaking a resource that has already been published to the library.
      console.error('Could not verify old segment references; preserving object', err?.message || String(err));
    }
  }
  if (deletableKeys.length) {
    await Promise.allSettled(deletableKeys.map((key) => storage.deleteObject(key)));
  }

  try {
    await sql`INSERT INTO ai_audit_log(action,actor,entity_type,entity_id,details)
      VALUES('pdf_split','admin','resource',${resourceId},${JSON.stringify({page_count:pageCount,segments:uploaded.length})}::jsonb)`;
  } catch (err) {
    // Audit logging should not invalidate files that were already saved successfully.
    console.error('PDF split audit log failed', err?.message || String(err));
  }

  return c.json({ source_resource_id: resourceId, source_pages: pageCount, original_preserved: true,
    segments: uploaded.map(({index,title,unit_id,start,end,url,bytes})=>({index,title,unit_id,page_start:start,page_end:end,url,size_bytes:bytes})),
    note: 'Generated PDFs are stored in private B2 and linked to reviewable segment records. The original file was not changed.' });
});

/**
 * Admin-only: publish generated segment PDFs as normal library resources.
 * This is deliberately a separate approval action; splitting alone never
 * makes derived files public in the ordinary library listing.
 */
ai.post('/publish-segments/:resourceId', async (c) => {
  if (!authorized(c)) return c.json({ error: 'admin authorization required' }, 401);
  const sourceId = c.req.param('resourceId');
  if (!/^\d+$/.test(sourceId)) return c.json({ error: 'invalid resource id' }, 400);

  const sql = await getDb(c.env);
  const storage = getStorage(c.env);
  const [source] = await sql`
    SELECT id, type, academic_year, uploader_name, is_flagged
    FROM resources WHERE id=${sourceId}
  `;
  if (!source || source.is_flagged) return c.json({ error: 'source resource not found or not available' }, 404);

  const segments = await sql`
    SELECT ds.id, ds.segment_index, ds.unit_id, ds.title, ds.page_start, ds.page_end,
      ds.generated_file_key, u.code_display AS unit_code, u.title AS unit_title
    FROM document_segments ds
    JOIN units u ON u.id=ds.unit_id
    WHERE ds.resource_id=${sourceId} AND ds.status='generated'
      AND ds.generated_file_key IS NOT NULL
    ORDER BY ds.segment_index
  `;
  if (!segments.length) {
    return c.json({ error: 'no generated segments found; split and review the source first' }, 404);
  }

  const published = [];
  for (const seg of segments) {
    try {
      const bytes = await storage.getObject(seg.generated_file_key);
      const hash = await sha256Hex(bytes);
      const [existing] = await sql`
        SELECT rf.resource_id AS id, r.title
        FROM resource_files rf JOIN resources r ON r.id=rf.resource_id
        WHERE rf.file_hash=${hash} LIMIT 1
      `;
      if (existing) {
        published.push({
          segment_id: seg.id, resource_id: existing.id, title: existing.title,
          already_published: true,
        });
        continue;
      }

      const fileName = `segment-${sourceId}-${seg.segment_index}-pages-${seg.page_start}-${seg.page_end}.pdf`;
      const title = String(seg.title || `${seg.unit_code} pages ${seg.page_start}-${seg.page_end}`).slice(0, 200);
      const fileUrl = `/api/files/${String(seg.generated_file_key).split('/').map(encodeURIComponent).join('/')}`;
      const contentHash = hash;
      const [created] = await sql`
        WITH inserted AS (
          INSERT INTO resources
            (unit_id,type,note_scope,topics,academic_year,title,original_title,uploader_name,note,
             file_count,primary_ext,content_hash,processing_status,preview_snippet)
          VALUES
            (${seg.unit_id},${source.type},'complete',ARRAY[]::text[],
             ${source.academic_year},${title},${title},'Communitylib split',
             ${`Extracted from resource ${sourceId}, pages ${seg.page_start}-${seg.page_end}. Original preserved.`},
             1,'pdf',${contentHash},'ready',
             ${`Pages ${seg.page_start}-${seg.page_end} from ${seg.unit_title || seg.unit_code}`})
          RETURNING id
        ),
        inserted_file AS (
          INSERT INTO resource_files
            (resource_id,order_index,file_name,file_url,file_ext,file_size_bytes,file_hash,mime_type,display_name,processing_status)
          SELECT inserted.id,0,${fileName},${fileUrl},'pdf',${bytes.byteLength},${hash},
            'application/pdf',${title},'ready'
          FROM inserted
          RETURNING resource_id
        ),
        updated_unit AS (
          UPDATE units SET resource_count=resource_count+1 WHERE id=${seg.unit_id}
          RETURNING id
        )
        SELECT inserted.id FROM inserted
        JOIN inserted_file ON inserted_file.resource_id=inserted.id
        JOIN updated_unit ON updated_unit.id=${seg.unit_id}
      `;
      if (!created) throw new Error('failed to create library resource');
      published.push({
        segment_id: seg.id, resource_id: created.id, title,
        unit_code: seg.unit_code, already_published: false,
      });
    } catch (err) {
      console.error('segment publish failed', { segmentId: seg.id, message: err?.message || String(err) });
      return c.json({
        error: 'segment publishing stopped; already-published items are safe to retry',
        published,
        failed_segment_id: seg.id,
      }, 500);
    }
  }

  await sql`
    INSERT INTO ai_audit_log(action,actor,entity_type,entity_id,details)
    VALUES('pdf_segments_published','admin','resource',${sourceId},
      ${JSON.stringify({published_count:published.length})}::jsonb)
  `;
  return c.json({
    source_resource_id: sourceId,
    published_count: published.length,
    published,
    note: 'Generated segments are now ordinary library resources. Repeating this request will not duplicate files with the same content hash.',
  });
});

/** Admin-only PDF merge for resources from the same unit and same resource type. */
ai.post('/merge', async (c) => {
  if (!authorized(c)) return c.json({ error: 'admin authorization required' }, 401);
  if (String(c.env.PDF_PROCESSING_ENABLED || 'false').trim().toLowerCase() !== 'true') {
    return c.json({ error: 'pdf_processing_disabled', message: 'Synchronous PDF processing is disabled until the Worker CPU plan is confirmed or processing is moved off-request.' }, 503);
  }
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'valid JSON body required' }, 400); }
  const ids = Array.isArray(body.resource_ids) ? [...new Set(body.resource_ids.map(String))] : [];
  if (ids.length < 2 || ids.length > MAX_MERGE_SOURCES || ids.some((id)=>!/^\d+$/.test(id))) {
    return c.json({ error: 'resource_ids must contain 2-5 valid resource IDs' }, 400);
  }
  const sql = await getDb(c.env);
  const storage = getStorage(c.env);
  const loaded = [];
  try {
    // Preflight every source with HEAD before downloading any PDF. This
    // bounds total memory amplification instead of discovering limits late.
    const metadata = [];
    let totalSourceBytes = 0;
    for (const id of ids) {
      const item = await getResourcePdfMetadata(sql, storage, id);
      metadata.push(item);
      totalSourceBytes += item.contentLength;
      if (totalSourceBytes > MAX_PDF_PROCESSING_BYTES) {
        return c.json({ error: 'combined source PDFs exceed the 15 MB total processing limit' }, 413);
      }
    }
    for (const item of metadata) loaded.push(await loadResourcePdf(storage, item));
  } catch (err) {
    const status = err.message === 'resource not found or not available' ? 404
      : /processing limit/.test(err.message) ? 413 : 400;
    return c.json({ error: err.message }, status);
  }
  const first = loaded[0].resource;
  if (loaded.some((x)=>String(x.resource.unit_id)!==String(first.unit_id) || x.resource.type!==first.type)) {
    return c.json({ error: 'merge only supports resources with the same unit and resource type' }, 400);
  }
  const merged = await PDFDocument.create();
  let totalPages = 0;
  try {
    for (const item of loaded) {
      const indices = Array.from({length:item.pdf.getPageCount()},(_,i)=>i);
      const pages = await merged.copyPages(item.pdf, indices);
      for (const page of pages) merged.addPage(page);
      totalPages += pages.length;
      if (totalPages > 1000) return c.json({ error: 'merged PDF exceeds 1000 pages' }, 413);
    }
    const bytes = await merged.save();
    if (bytes.byteLength > MAX_PDF_PROCESSING_BYTES) return c.json({ error: 'merged PDF exceeds the 15 MB processing limit' }, 413);
    const hash = await sha256Hex(bytes);
    const [duplicate] = await sql`SELECT id FROM resource_files WHERE file_hash=${hash} LIMIT 1`;
    if (duplicate) return c.json({ error: 'merged PDF already exists', existing_file_id: duplicate.id }, 409);
    const key = `units/${first.unit_id}/derived/${crypto.randomUUID()}-merged.pdf`;
    const stored = await storage.putObject(key, bytes, 'application/pdf');
    try {
      const title = String(body.title || `Merged: ${loaded.map((x)=>x.resource.title).join(' + ')}`).slice(0,200);
      const [created] = await sql`
        INSERT INTO resources(unit_id,type,note_scope,topics,academic_year,title,original_title,uploader_name,note,file_count,primary_ext,content_hash,processing_status)
        VALUES(${first.unit_id},${first.type},${first.note_scope || 'complete'},${first.topics || []},${first.academic_year || null},${title},${title},'Communitylib AI','Merged from resources: '||${ids.join(', ')},1,'pdf',${await combineHashes([hash])},'ready') RETURNING id,title
      `;
      await sql`INSERT INTO resource_files(resource_id,order_index,file_name,file_url,file_ext,file_size_bytes,file_hash,mime_type,display_name,processing_status)
        VALUES(${created.id},0,${title + '.pdf'},${stored.url},'pdf',${bytes.byteLength},${hash},'application/pdf',${title + '.pdf'},'ready')`;
      await sql`UPDATE units SET resource_count=resource_count+1 WHERE id=${first.unit_id}`;
      await sql`INSERT INTO ai_audit_log(action,actor,entity_type,entity_id,details) VALUES('pdf_merge','admin','resource',${created.id},${JSON.stringify({source_resource_ids:ids,total_pages:totalPages})}::jsonb)`;
      return c.json({ resource_id: created.id, title: created.title, file_url: stored.url, page_count: totalPages,
        source_resource_ids: ids, originals_preserved: true }, 201);
    } catch (err) {
      await storage.deleteObject(key);
      throw err;
    }
  } catch (err) {
    console.error('PDF merge failed', err?.message || String(err));
    return c.json({ error: 'PDF merge failed', detail: err?.message || String(err) }, 500);
  }
});

/** Admin-only status view for processing/review queues. */
ai.get('/jobs', async (c) => {
  if (!authorized(c)) return c.json({ error: 'admin authorization required' }, 401);
  const status = (c.req.query('status') || '').trim();
  const sql = await getDb(c.env);
  const rows = status
    ? await sql`SELECT * FROM document_processing_jobs WHERE status=${status} ORDER BY created_at DESC LIMIT 100`
    : await sql`SELECT * FROM document_processing_jobs ORDER BY created_at DESC LIMIT 100`;
  return c.json({ jobs: rows });
});

export default ai;
