import { Hono } from 'hono';
import { getStorage } from '../storage.js';

const files = new Hono();

const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

// Mounted at /api/files/*. The key is everything after the prefix, so keys
// with slashes (units/12/notes/uuid-name.pdf) round-trip correctly.
files.get('/*', async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/files\//, ''));
  if (!key || key.includes('..')) {
    return c.json({ error: 'invalid file key' }, 400);
  }

  const storage = getStorage(c.env);
  const range = c.req.header('range');

  let upstream;
  try {
    upstream = await storage.fetchObject(key, range);
  } catch (err) {
    console.error('file proxy fetch failed', err);
    return c.json({ error: 'file unavailable' }, 502);
  }

  if (upstream.status === 404) return c.json({ error: 'file not found' }, 404);
  if (!upstream.ok && upstream.status !== 206) {
    return c.json({ error: 'file unavailable' }, 502);
  }

  const headers = new Headers();
  for (const h of PASSTHROUGH_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  // Object keys are UUID-based and immutable once uploaded, so this is
  // safe to cache hard at the edge/browser forever.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  const filename = key.split('/').pop().replace(/"/g, '');
  headers.set('content-disposition', `inline; filename="${filename}"`);

  return new Response(upstream.body, { status: upstream.status, headers });
});

export default files;
