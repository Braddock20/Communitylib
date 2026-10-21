import { Hono } from 'hono';
import { cors } from 'hono/cors';
import upload from './routes/upload.js';
import search from './routes/search.js';
import feed from './routes/feed.js';
import units from './routes/units.js';
import resource from './routes/resource.js';
import comments from './routes/comments.js';
import files from './routes/files.js';
import ai from './routes/ai.js';
import { resolveDb } from './db.js';


const app = new Hono();

function limitedBy(bindingName) {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const binding = c.env[bindingName];
    const ip = c.req.header('cf-connecting-ip');
    if (!binding || typeof binding.limit !== 'function' || !ip) {
      console.error('public rate-limit binding or client IP unavailable', { bindingName });
      return c.json({ error: 'rate_limit_unavailable' }, 503);
    }
    try {
      const { success } = await binding.limit({ key: `ip:${ip}` });
      if (!success) {
        return c.json({ error: 'rate_limit_exceeded', retry_after_seconds: 60 }, 429,
          { 'Retry-After': '60' });
      }
    } catch (err) {
      console.error('public rate-limit check failed', { bindingName, message: err?.message || String(err) });
      return c.json({ error: 'rate_limit_unavailable' }, 503);
    }
    await next();
  };
}

app.use('*', async (c, next) => {
  const requestId = c.req.header('cf-ray') || crypto.randomUUID();
  c.header('X-Request-ID', requestId);
  await next();
});

// Public browser-facing API CORS policy. Kept at the top level so it
// applies to every route, including 404/500 responses and health
// endpoints. The API is intentionally public, so `*` is used and
// credentials are NOT enabled — usable from arbitrary HTTPS sites,
// localhost dev servers, static hosts, PWAs, and WebViews without an
// allowlist. Hono handles OPTIONS preflight responses for us.
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
      'X-Debug-Key',
      'X-Admin-Key',
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
  version: c.env.APP_VERSION || '4.1.0',
}));

// Liveness: deliberately does not touch the database. If this 503s, the
// problem is the Worker/deploy itself, not Neon/B2.
app.get('/health', (c) => c.json({ ok: true }));

// Readiness: diagnoses DATABASE_URL / Neon problems without leaking
// credentials to the public by default.
//
// Debugging without a CLI: set a DEBUG_KEY secret in the dashboard
// (Settings -> Variables and Secrets), then visit
//   /health/db with X-Debug-Key: YOUR_KEY
// in a browser. That returns exactly which env var was tried, which host
// it resolved to, and why each attempt failed — no `wrangler tail`, no
// Logs tab needed. Leave DEBUG_KEY unset and the endpoint behaves exactly
// like a normal generic {ok:false} readiness check.
app.get('/health/db', async (c) => {
  const debugKey = c.env.DEBUG_KEY;
  const providedKey = c.req.header('x-debug-key');
  const debugAllowed = Boolean(debugKey) && providedKey === debugKey;

  try {
    const { source } = await resolveDb(c.env);
    return c.json({ ok: true, database: 'reachable', source });
  } catch (err) {
    // Full detail (hostnames + per-candidate error, never credentials)
    // always goes to Workers Logs / wrangler tail.
    console.error('database health check failed', err?.message, err?.attempts);
    const body = { ok: false, database: 'unreachable' };
    if (debugAllowed) {
      body.reason = err?.message || String(err);
      body.attempts = err?.attempts || [];
    }
    return c.json(body, 503);
  }
});

app.use('/api/upload', limitedBy('PUBLIC_UPLOAD_LIMITER'));
app.use('/api/upload/*', limitedBy('PUBLIC_UPLOAD_LIMITER'));
app.use('/api/search', limitedBy('PUBLIC_SEARCH_LIMITER'));
app.use('/api/search/*', limitedBy('PUBLIC_SEARCH_LIMITER'));
app.use('/api/feed', limitedBy('PUBLIC_SEARCH_LIMITER'));
app.use('/api/feed/*', limitedBy('PUBLIC_SEARCH_LIMITER'));
app.use('/api/files/*', limitedBy('PUBLIC_FILE_LIMITER'));
app.use('/api/resource/:id/comments', limitedBy('PUBLIC_COMMENT_LIMITER'));

app.route('/api/upload', upload);
app.route('/api/search', search);
app.route('/api/feed', feed);
app.route('/api/units', units);
app.route('/api/resource', resource);
app.route('/api/resource', comments);
app.route('/api/files', files);
app.route('/api/ai', ai);

app.notFound((c) => c.json({ error: 'not found' }, 404));

app.onError((err, c) => {
  console.error('request failed', err);

  const body = { error: 'internal_server_error', message: 'Something went wrong. Please try again.' };

  // Same opt-in mechanism as /health/db: send an X-Debug-Key header to
  // see the real error instead of the generic
  // message. Never sent to a public client unless DEBUG_KEY is set AND
  // matched.
  const debugKey = c.env.DEBUG_KEY;
  const providedKey = c.req.header('x-debug-key');
  if (debugKey && providedKey === debugKey) {
    body.debug = {
      message: err?.message || String(err),
      stack: (err?.stack || '').split('\n').slice(0, 6),
    };
  }

  return c.json(body, 500);
});

export default app;
