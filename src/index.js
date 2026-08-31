import { Hono } from 'hono';
import { cors } from 'hono/cors';
import upload from './routes/upload.js';
import search from './routes/search.js';
import feed from './routes/feed.js';
import units from './routes/units.js';
import resource from './routes/resource.js';
import comments from './routes/comments.js';
import files from './routes/files.js';
import { getDb, databaseInfo } from './db.js';

const app = new Hono();

app.use('*', async (c, next) => {
  const requestId = c.req.header('cf-ray') || crypto.randomUUID();
  c.header('X-Request-ID', requestId);
  await next();
});

// Public browser-facing API CORS policy. Keep this at the top-level so it
// applies to every route, including 404/500 responses and health endpoints.
// The API is intentionally public, so `*` is used and credentials are NOT
// enabled. This makes it usable from arbitrary HTTPS sites, localhost dev
// servers, static hosts, PWAs, and WebViews without requiring an allowlist.
// Hono handles OPTIONS preflight responses for us.
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Accept',
      'Content-Type',
      'Authorization',
      'Origin',
      'X-Requested-With',
      'X-Request-ID',
      'Range',
    ],
    exposeHeaders: [
      'Content-Length',
      'Content-Range',
      'Content-Disposition',
      'Accept-Ranges',
      'X-Request-ID',
    ],
    maxAge: 86400,
  })
);

app.get('/', (c) => c.json({
  ok: true,
  app: c.env.APP_NAME || 'UoE Student Resources API',
  version: c.env.APP_VERSION || '2.0.0',
}));

// Liveness: deliberately does not require the database.
app.get('/health', (c) => c.json({ ok: true }));

// Readiness: useful for diagnosing DATABASE_URL / Neon problems without
// leaking credentials or connection strings.
app.get('/health/db', async (c) => {
  try {
    const sql = getDb(c.env);
    await sql`SELECT 1 AS ok`;
    return c.json({ ok: true, database: 'reachable' });
  } catch (err) {
    console.error('database health check failed', err);
    return c.json({ ok: false, database: 'unreachable' }, 503);
  }
});

app.route('/api/upload', upload);
app.route('/api/search', search);
app.route('/api/feed', feed);
app.route('/api/units', units);
app.route('/api/resource', resource);
app.route('/api/resource', comments);
app.route('/api/files', files);

app.notFound((c) => c.json({ error: 'not found' }, 404));

app.onError((err, c) => {
  console.error('request failed', err);
  // Never send database/B2/internal error strings to a public client.
  return c.json(
    { error: 'internal_server_error', message: 'Something went wrong. Please try again.' },
    500
  );
});

export default app;
