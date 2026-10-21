import { Hono } from 'hono';
import { getDb } from '../db.js';
import { normalizeCode, normalizeText, sha256Hex, combineHashes } from '../utils/hash.js';
import { getStorage } from '../storage.js';
import { PDFDocument } from 'pdf-lib';

const ai = new Hono();
const MODEL = '@cf/meta/llama-3.1-8b-instruct';
const MAX_TEXT = 24000;

function authorized(c) {
  const key = c.env.ADMIN_API_KEY;
  const supplied = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ||
    c.req.header('x-admin-key');
  return Boolean(key && supplied && supplied === key);
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
  const haystack = `${filename || ''}\n${text || ''}`.toLowerCase();
  const code = normalizeCode(haystack.match(/\b[A-Z]{2,8}[\s-]*\d{2,4}[A-Z]?\b/i)?.[0] || '');
  const unit = registry.find((u) => normalizeCode(u.code) === code) ||
    registry.find((u) => [u.title, ...(u.aliases || [])].some((s) => s && haystack.includes(String(s).toLowerCase())));
  const type = /\b(cat|continuous assessment|test)\b/i.test(haystack) ? 'cat'
    : /\b(supplementary|special|end.of.semester|final exam|examination|exam)\b/i.test(haystack) ? 'exam'
    : /\b(assignment|coursework)\b/i.test(haystack) ? 'assignment' : 'notes';
  const yearMatch = haystack.match(/\b(20(?:0\d|1\d|2[0-9]))\b/);
  return {
    unit_code: unit?.code || (code || null),
    unit_title: unit?.title || null,
    unit_code_verified: Boolean(unit),
    type,
    academic_year: yearMatch ? Number(yearMatch[1]) : null,
    display_title: filename ? filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() : null,
    topics: [],
    confidence: unit ? 0.62 : 0.25,
    reason: unit ? 'Matched filename/text to a known registry unit using deterministic fallback rules.' : 'No reliable registry match; human review recommended.',
    segments: [],
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
  let suggestion = null;
  let provider = 'rules-fallback';
  const publicAiEnabled = String(c.env.AI_PUBLIC_ENABLED || 'false').toLowerCase() === 'true';
  if (c.env.AI && publicAiEnabled && text.trim()) {
    try {
      const prompt = `You classify university study documents. Use ONLY the supplied registry to identify a unit. Never invent a code or title. If no exact/strong match exists, set unit_code and unit_title to null. Return only JSON with keys: unit_code, unit_title, type (notes|cat|exam|assignment|other), academic_year (integer or null), display_title (string), topics (array of strings), confidence (0..1), reason (short string), segments (array; each has title, unit_code, page_start, page_end, confidence). Do not assert page ranges unless the text explicitly includes page markers. Segments are review suggestions only. Registry: ${JSON.stringify(known)}\nFilename: ${filename}\nDocument text:\n${text}`;
      const result = await c.env.AI.run(c.env.AI_MODEL || MODEL, {
        messages: [
          { role: 'system', content: 'You are a cautious document metadata classifier. Never fabricate university unit codes. Output valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 900,
      });
      suggestion = parseJson(result?.response || result?.output_text || result?.result || '');
      if (suggestion) provider = 'cloudflare-workers-ai';
    } catch (err) {
      console.warn('Workers AI analysis unavailable; using deterministic fallback', err?.message || String(err));
    }
  }
  if (!suggestion) suggestion = fallbackAnalysis({ text, filename, registry: known });
  const rawCode = suggestion.unit_code ? normalizeCode(suggestion.unit_code) : '';
  const [matchedRow] = rawCode ? await sql`SELECT id, code_display AS code, title FROM units WHERE code=${rawCode} ORDER BY id LIMIT 1` : [null];
  const matched = matchedRow || known.find((u) => normalizeCode(u.code) === rawCode);
  const rawType = ['notes','cat','exam','assignment','other'].includes(suggestion.type) ? suggestion.type : 'other';
  const year = Number.isInteger(Number(suggestion.academic_year)) && Number(suggestion.academic_year) >= 1900 && Number(suggestion.academic_year) <= 2100
    ? Number(suggestion.academic_year) : null;
  const segments = Array.isArray(suggestion.segments) ? suggestion.segments.slice(0,50).map((s) => ({
    title: String(s.title || 'Untitled segment').slice(0,200),
    unit_code: s.unit_code && known.some((u) => normalizeCode(u.code) === normalizeCode(s.unit_code)) ? normalizeCode(s.unit_code) : null,
    page_start: Number.isInteger(Number(s.page_start)) && Number(s.page_start) > 0 ? Number(s.page_start) : null,
    page_end: Number.isInteger(Number(s.page_end)) && Number(s.page_end) > 0 ? Number(s.page_end) : null,
    confidence: clampConfidence(s.confidence, 0.3),
    requires_review: true,
  })).filter((s) => !s.page_end || !s.page_start || s.page_end >= s.page_start) : [];
  const confidence = clampConfidence(suggestion.confidence, 0.3);
  return c.json({
    suggestions: {
      unit_id: matched?.id || null,
      unit_code: matched?.code || null,
      unit_title: matched?.title || null,
      unit_code_verified: Boolean(matched),
      unverified_code_candidate: !matched && rawCode ? String(suggestion.unit_code).slice(0,40) : null,
      type: rawType,
      academic_year: year,
      display_title: String(suggestion.display_title || filename.replace(/\.[^.]+$/, '') || 'Untitled document').slice(0,200),
      topics: Array.isArray(suggestion.topics) ? [...new Set(suggestion.topics.map((t) => String(t).trim().slice(0,120)).filter(Boolean))].slice(0,30) : [],
      confidence,
      reason: String(suggestion.reason || 'Review this suggestion before applying it.').slice(0,500),
      segments,
      requires_review: confidence < 0.8 || !matched || segments.length > 0,
      provider,
    },
    registry_matches: known.filter((u) => rawCode && normalizeCode(u.code) === rawCode).slice(0,3).map(({id,code,title})=>({id,code,title})),
    disclaimer: 'Metadata is a suggestion only. Confirm unit and page boundaries before saving or splitting files.',
  });
});

/**
 * GET /api/ai/segments/:resourceId and POST /api/ai/segments
 * Store/retrieve AI-proposed split boundaries. Saving a suggestion does not
 * physically split the original PDF; it creates a reviewable page-range plan.
 */
ai.get('/segments/:resourceId', async (c) => {
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

async function getResourcePdf(sql, storage, resourceId) {
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
  const bytes = await storage.getObject(key);
  if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('PDF exceeds the 100 MB processing limit');
  let pdf;
  try { pdf = await PDFDocument.load(bytes); } catch { throw new Error('source PDF is corrupt, password-protected, or unsupported'); }
  return { resource, bytes, pdf, key };
}

/** Admin-only physical PDF splitting. Original source remains untouched. */
ai.post('/split/:resourceId', async (c) => {
  if (!authorized(c)) return c.json({ error: 'admin authorization required' }, 401);
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
  catch (err) { return c.json({ error: err.message }, err.message === 'resource not found or not available' ? 404 : 400); }
  const pageCount = source.pdf.getPageCount();
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
  try {
    for (const r of ranges) {
      const output = await PDFDocument.create();
      const indices = Array.from({length:r.end-r.start+1},(_,i)=>r.start-1+i);
      const pages = await output.copyPages(source.pdf, indices);
      for (const page of pages) output.addPage(page);
      const bytes = await output.save();
      const key = `units/${r.unit_id}/derived/${crypto.randomUUID()}-pages-${r.start}-${r.end}.pdf`;
      const stored = await storage.putObject(key, bytes, 'application/pdf');
      uploaded.push({ ...r, key, url: stored.url, bytes: bytes.byteLength, hash: await sha256Hex(bytes) });
    }
    for (const r of uploaded) {
      await sql`
        INSERT INTO document_segments(resource_id,segment_index,unit_id,title,page_start,page_end,confidence,status,source_resource_id,generated_file_key,notes)
        VALUES(${resourceId},${r.index},${r.unit_id},${r.title},${r.start},${r.end},${r.confidence},'generated',${resourceId},${r.key},'Generated from a copied page range; original PDF retained.')
        ON CONFLICT(resource_id,segment_index) DO UPDATE SET unit_id=EXCLUDED.unit_id,title=EXCLUDED.title,page_start=EXCLUDED.page_start,page_end=EXCLUDED.page_end,confidence=EXCLUDED.confidence,status='generated',source_resource_id=EXCLUDED.source_resource_id,generated_file_key=EXCLUDED.generated_file_key,notes=EXCLUDED.notes
      `;
    }
    await sql`INSERT INTO ai_audit_log(action,actor,entity_type,entity_id,details) VALUES('pdf_split','admin','resource',${resourceId},${JSON.stringify({page_count:pageCount,segments:uploaded.length})}::jsonb)`;
    return c.json({ source_resource_id: resourceId, source_pages: pageCount, original_preserved: true,
      segments: uploaded.map(({index,title,unit_id,start,end,url,bytes})=>({index,title,unit_id,page_start:start,page_end:end,url,size_bytes:bytes})),
      note: 'Generated PDFs are stored in private B2 and linked to the reviewable segment records. The original file was not changed.' });
  } catch (err) {
    await Promise.allSettled(uploaded.map((r)=>storage.deleteObject(r.key)));
    console.error('PDF split failed', err?.message || String(err));
    return c.json({ error: 'PDF split failed; generated objects were cleaned up where possible', detail: err?.message || String(err) }, 500);
  }
});

/** Admin-only PDF merge for resources from the same unit and same resource type. */
ai.post('/merge', async (c) => {
  if (!authorized(c)) return c.json({ error: 'admin authorization required' }, 401);
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'valid JSON body required' }, 400); }
  const ids = Array.isArray(body.resource_ids) ? [...new Set(body.resource_ids.map(String))] : [];
  if (ids.length < 2 || ids.length > 20 || ids.some((id)=>!/^\d+$/.test(id))) {
    return c.json({ error: 'resource_ids must contain 2-20 valid resource IDs' }, 400);
  }
  const sql = await getDb(c.env);
  const storage = getStorage(c.env);
  const loaded = [];
  try {
    for (const id of ids) {
      loaded.push(await getResourcePdf(sql, storage, id));
      if (loaded.reduce((sum,item)=>sum+item.bytes.byteLength,0) > 100 * 1024 * 1024) {
        return c.json({ error: 'combined source PDFs exceed the 100 MB total processing limit' }, 413);
      }
    }
  } catch (err) { return c.json({ error: err.message }, err.message === 'resource not found or not available' ? 404 : 400); }
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
    if (bytes.byteLength > 100 * 1024 * 1024) return c.json({ error: 'merged PDF exceeds 100 MB' }, 413);
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
