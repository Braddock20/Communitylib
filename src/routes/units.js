import { Hono } from 'hono';
import { getDb } from '../db.js';
import { groupResources } from './search.js';

const units = new Hono();

/** GET /api/units/:id - full detail page: unit info + all resources, nicely grouped */
units.get('/:id', async (c) => {
  const id = c.req.param('id');
  const sql = await getDb(c.env);

  const [unit] = await sql`SELECT * FROM units WHERE id = ${id}`;
  if (!unit) return c.json({ error: 'unit not found' }, 404);

  const resources = await sql`
    SELECT id, unit_id, type, academic_year, title, uploader_name, note, file_count,
           primary_ext, thumbnail_url, combined_pdf_url, download_count, view_count,
           comment_count, created_at
    FROM resources
    WHERE unit_id = ${id} AND is_flagged = false
    ORDER BY academic_year DESC NULLS LAST, created_at DESC
  `;

  return c.json({
    unit: {
      id: unit.id,
      code: unit.code_display,
      title: unit.title,
      resource_count: unit.resource_count,
      download_count: unit.download_count,
    },
    grouped: groupResources(resources),
  });
});

export default units;
