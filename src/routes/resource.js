import { Hono } from 'hono';
import { getDb } from '../db.js';

const resource = new Hono();

function validId(id) {
  return /^\d+$/.test(id);
}

resource.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!validId(id)) return c.json({ error: 'invalid resource id' }, 400);

  const sql = await getDb(c.env);
  const [res] = await sql`SELECT * FROM resources WHERE id = ${id} AND is_flagged = false`;
  if (!res) return c.json({ error: 'resource not found' }, 404);

  const files = await sql`
    SELECT id, order_index, file_name, file_url, file_ext, file_size_bytes
    FROM resource_files
    WHERE resource_id = ${id}
    ORDER BY order_index ASC
  `;

  c.executionCtx?.waitUntil?.(
    sql`UPDATE resources SET view_count = view_count + 1 WHERE id = ${id}`.catch(() => {})
  );

  return c.json({ resource: res, files });
});

resource.get('/:id/download', async (c) => {
  const id = c.req.param('id');
  if (!validId(id)) return c.json({ error: 'invalid resource id' }, 400);

  const sql = await getDb(c.env);
  const [res] = await sql`SELECT * FROM resources WHERE id = ${id} AND is_flagged = false`;
  if (!res) return c.json({ error: 'resource not found' }, 404);

  const files = await sql`
    SELECT file_name, file_url, file_ext
    FROM resource_files
    WHERE resource_id = ${id}
    ORDER BY order_index ASC
  `;
  if (files.length === 0) return c.json({ error: 'resource has no files' }, 409);

  // All three counters/log operations commit or roll back together.
  await sql.transaction([
    sql`UPDATE resources SET download_count = download_count + 1 WHERE id = ${id}`,
    sql`UPDATE units SET download_count = download_count + 1 WHERE id = ${res.unit_id}`,
    sql`INSERT INTO download_logs (resource_id, unit_id) VALUES (${id}, ${res.unit_id})`,
  ]);

  if (res.combined_pdf_url) {
    return c.json({ type: 'pdf', url: res.combined_pdf_url, filename: `${res.title}.pdf` });
  }
  if (files.length === 1) {
    return c.json({ type: 'file', url: files[0].file_url, filename: files[0].file_name });
  }
  return c.json({ type: 'multi', files });
});


/**
 * GET /api/resource/:id/preview
 * Stable preview metadata for a future frontend. PDF first-page rendering is
 * performed by the included browser preview component (PDF.js); image files
 * can be shown directly. No private B2 URL is exposed.
 */
resource.get('/:id/preview', async (c) => {
  const id = c.req.param('id');
  if (!validId(id)) return c.json({ error: 'invalid resource id' }, 400);
  const sql = await getDb(c.env);
  const [res] = await sql`
    SELECT id, title, type, note, preview_snippet, extracted_text, thumbnail_url,
           primary_ext, file_count, created_at
    FROM resources WHERE id = ${id} AND is_flagged = false
  `;
  if (!res) return c.json({ error: 'resource not found' }, 404);
  const files = await sql`
    SELECT id, order_index, file_name, file_url, file_ext, file_size_bytes, mime_type,
           display_name, page_count, thumbnail_key, processing_status
    FROM resource_files WHERE resource_id = ${id} ORDER BY order_index ASC
  `;
  const first = files[0] || null;
  const image = files.find((f) => ['jpg','jpeg','png','webp'].includes(String(f.file_ext).toLowerCase()));
  const snippet = String(res.preview_snippet || res.note || res.extracted_text || '')
    .replace(/\s+/g, ' ').trim().slice(0, 360);
  return c.json({
    resource_id: res.id,
    title: res.title,
    type: res.type,
    file_count: files.length,
    page_count: first?.page_count ?? null,
    snippet: snippet || 'Preview not generated yet. Open the document to view its contents.',
    preview_kind: image ? 'image' : first?.file_ext === 'pdf' ? 'pdf' : 'file',
    preview_url: image?.file_url || first?.file_url || null,
    thumbnail_url: res.thumbnail_url || image?.file_url || null,
    files,
    renderer: first?.file_ext === 'pdf' ? 'pdfjs' : image ? 'image' : 'fallback',
  });
});

export default resource;
