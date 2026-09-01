import { Hono } from 'hono';
import { getDb } from '../db.js';

const comments = new Hono();

comments.get('/:id/comments', async (c) => {
  const id = c.req.param('id');
  if (!/^\d+$/.test(id)) return c.json({ error: 'invalid resource id' }, 400);

  const sql = await getDb(c.env);
  const rows = await sql`
    SELECT id, author_name, content, created_at
    FROM comments
    WHERE resource_id = ${id}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return c.json({ comments: rows });
});

comments.post('/:id/comments', async (c) => {
  const id = c.req.param('id');
  if (!/^\d+$/.test(id)) return c.json({ error: 'invalid resource id' }, 400);

  const sql = await getDb(c.env);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const content = (body?.content || '').toString().trim().slice(0, 2000);
  const authorName = (body?.author_name || 'Anonymous').toString().trim().slice(0, 80) || 'Anonymous';
  if (!content) return c.json({ error: 'content is required' }, 400);

  const [res] = await sql`SELECT id FROM resources WHERE id = ${id} AND is_flagged = false`;
  if (!res) return c.json({ error: 'resource not found' }, 404);

  // Comment creation and counter update are atomic.
  const [result] = await sql.transaction([
    sql`
      INSERT INTO comments (resource_id, author_name, content)
      VALUES (${id}, ${authorName}, ${content})
      RETURNING id, author_name, content, created_at
    `,
    sql`UPDATE resources SET comment_count = comment_count + 1 WHERE id = ${id}`,
  ]);

  return c.json({ comment: result[0] }, 201);
});

export default comments;
