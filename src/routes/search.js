import { Hono } from 'hono';
import { getDb } from '../db.js';
import { normalizeCode } from '../utils/hash.js';

const search = new Hono();

/**
 * GET /api/search/suggest?q=mat2
 * Fast, lightweight autocomplete - returns up to 8 matching units as the
 * user types (code and/or title), Google-style.
 */
search.get('/suggest', async (c) => {
  const q = (c.req.query('q') || '').trim();
  if (q.length < 1) return c.json({ suggestions: [] });

  const sql = getDb(c.env);
  const codeLike = normalizeCode(q);

  const rows = await sql`
    SELECT id, code_display, title, resource_count
    FROM units
    WHERE code ILIKE ${codeLike + '%'}
       OR title ILIKE ${'%' + q + '%'}
       OR similarity(title, ${q}) > 0.2
    ORDER BY
      (code ILIKE ${codeLike + '%'}) DESC,   -- exact code prefix first
      resource_count DESC
    LIMIT 8
  `;

  return c.json({
    suggestions: rows.map((r) => ({
      unit_id: r.id,
      code: r.code_display,
      title: r.title,
      resource_count: r.resource_count,
      label: `${r.code_display} - ${r.title}`,
    })),
  });
});

/**
 * GET /api/search?q=MAT201+linear+algebra
 * Full search: matches on unit code and/or title (either or both, as typed),
 * returns each matching unit with its resources neatly grouped into
 * notes / cats-by-year / exams-by-year - ready for a UI to render directly.
 */
search.get('/', async (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q) return c.json({ error: 'q is required' }, 400);

  const sql = getDb(c.env);
  const codeLike = normalizeCode(q);

  const units = await sql`
    SELECT *,
      (code ILIKE ${codeLike + '%'}) AS code_match,
      GREATEST(similarity(title, ${q}), similarity(code_display, ${q})) AS rank
    FROM units
    WHERE code ILIKE ${'%' + codeLike + '%'}
       OR title ILIKE ${'%' + q + '%'}
       OR similarity(title, ${q}) > 0.15
    ORDER BY code_match DESC, rank DESC, resource_count DESC
    LIMIT 20
  `;

  if (units.length === 0) {
    return c.json({ query: q, results: [] });
  }

  // log the search for trending/feed-learning purposes (best-effort, non-blocking)
  const topUnit = units[0];
  c.executionCtx?.waitUntil?.(
    sql.transaction([
      sql`INSERT INTO search_logs (query, unit_id) VALUES (${q}, ${topUnit.id})`,
      sql`UPDATE units SET search_count = search_count + 1 WHERE id = ${topUnit.id}`,
    ]).catch(() => {})
  );

  const unitIds = units.map((u) => u.id);
  const resources = await sql`
    SELECT id, unit_id, type, academic_year, title, uploader_name, note, file_count,
           primary_ext, thumbnail_url, combined_pdf_url, download_count, view_count,
           comment_count, created_at
    FROM resources
    WHERE unit_id = ANY(${unitIds}) AND is_flagged = false
    ORDER BY academic_year DESC NULLS LAST, created_at DESC
  `;

  const results = units.map((u) => {
    const own = resources.filter((r) => r.unit_id === u.id);
    return {
      unit: {
        id: u.id,
        code: u.code_display,
        title: u.title,
        resource_count: u.resource_count,
        download_count: u.download_count,
      },
      grouped: groupResources(own),
    };
  });

  return c.json({ query: q, results });
});

/** Nicely group a flat resource list into notes / cats-by-year / exams-by-year / other */
export function groupResources(resources) {
  const notes = resources.filter((r) => r.type === 'notes');
  const assignments = resources.filter((r) => r.type === 'assignment');
  const other = resources.filter((r) => r.type === 'other');

  const byYear = (type) => {
    const filtered = resources.filter((r) => r.type === type);
    const years = {};
    for (const r of filtered) {
      const y = r.academic_year || 'unknown';
      years[y] = years[y] || [];
      years[y].push(r);
    }
    // newest year first
    return Object.entries(years)
      .sort((a, b) => (b[0] === 'unknown' ? -1 : a[0] === 'unknown' ? 1 : b[0] - a[0]))
      .map(([year, items]) => ({ year, items }));
  };

  return {
    notes,
    cats: byYear('cat'),
    exams: byYear('exam'),
    assignments,
    other,
  };
}

export default search;
