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

export default resource;
