import { Hono } from 'hono';
import { getStorage } from '../storage.js';
import { getDb } from '../db.js';

const files = new Hono();

const PASSTHROUGH_HEADERS = [
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

const MIME_BY_EXT = Object.freeze({
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
});

function resolveKey(rawPath) {
  try {
    const segments = rawPath.split('/').map((part) => decodeURIComponent(part));
    if (!segments.length || segments.some((part) =>
      !part || part === '.' || part === '..' || part.includes('/') ||
      part.includes('\\') || /%(?:2e|2f|5c)/i.test(part)
    )) return null;
    return segments.join('/');
  } catch {
    return null;
  }
}

// Mounted at /api/files/*. Only objects referenced by a non-flagged resource
// are public. This prevents guessed B2 keys from exposing unpublished derived
// PDFs and allows moderation to revoke public access.
files.get('/*', async (c) => {
  const rawPath = c.req.path.replace(/^\/api\/files\//, '');
  const key = resolveKey(rawPath);
  if (!key) return c.json({ error: 'invalid file key' }, 400);

  const canonicalUrl = `/api/files/${key.split('/').map(encodeURIComponent).join('/')}`;
  let sql;
  try {
    sql = await getDb(c.env);
    const [visible] = await sql`
      SELECT 1 AS visible
      FROM resource_files rf
      JOIN resources r ON r.id=rf.resource_id
      WHERE rf.file_url=${canonicalUrl} AND r.is_flagged=false
      UNION ALL
      SELECT 1 AS visible
      FROM resources r
      WHERE r.combined_pdf_url=${canonicalUrl} AND r.is_flagged=false
      LIMIT 1
    `;
    if (!visible) return c.json({ error: 'file not found' }, 404);
  } catch (err) {
    console.error('file visibility check failed', err?.message || String(err));
    return c.json({ error: 'file unavailable' }, 503);
  }

  const ext = (key.split('/').pop().split('.').pop() || '').toLowerCase();
  const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
  const inlineSafe = ['pdf', 'txt', 'jpg', 'jpeg', 'png', 'webp'].includes(ext);
  const storage = getStorage(c.env);
  const range = c.req.header('range');

  let upstream;
  try {
    upstream = await storage.fetchObject(key, range);
  } catch (err) {
    console.error('file proxy fetch failed', err?.message || String(err));
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
  // Never reflect B2/client-supplied Content-Type: extension-based allowlist
  // plus nosniff prevents an uploaded text file from being served as HTML.
  headers.set('content-type', contentType);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-disposition', `${inlineSafe ? 'inline' : 'attachment'}; filename="${key.split('/').pop().replace(/["\r\n]/g, '_')}"`);
  headers.set('cache-control', 'public, max-age=300');
  if (ext === 'txt') headers.set('content-security-policy', "sandbox; default-src 'none';");
  return new Response(upstream.body, { status: upstream.status, headers });
});

export default files;
