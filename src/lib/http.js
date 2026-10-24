// Tiny framework-free router + helpers so new routes run on plain Request/Response.
// Mounted into the existing Hono app by one adapter (see src/index.js); everything
// here is testable without Hono.
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
export function err(status, code, message, extra = {}) { return json({ error: code, message, ...extra }, status); }

export class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

export async function readJson(req, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const len = Number(req.headers.get('content-length'));
  if (Number.isFinite(len) && len > maxBytes) throw new HttpError(413, 'body_too_large', `body exceeds ${maxBytes} bytes`);
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'body_too_large', `body exceeds ${maxBytes} bytes`);
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch { throw new HttpError(400, 'invalid_json', 'valid JSON object body required'); }
}

export function createRouter() {
  const routes = [];
  const compile = (pattern) => {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '/([^/]+)'; }) + '/?$');
    return { re, names };
  };
  return {
    add(method, pattern, handler, meta = {}) { routes.push({ method, pattern, ...compile(pattern), handler, meta }); },
    routes,
    /** Returns a Response, or null when no route matches (caller falls through). */
    async handle(req, env, ctx) {
      const url = new URL(req.url);
      let pathMatched = false;
      for (const r of routes) {
        const m = url.pathname.match(r.re);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        const c = { req, env, ctx, url, params, meta: r.meta, requestId: req.headers.get('cf-ray') || crypto.randomUUID() };
        try { return await r.handler(c); }
        catch (e) {
          if (e instanceof HttpError) return err(e.status, e.code, e.message, e.extra);
          console.error('route failed', r.pattern, e?.message || String(e));
          const debug = env.DEBUG_KEY && req.headers.get('x-debug-key') === env.DEBUG_KEY ? { debug: String(e?.message || e) } : {};
          return err(500, 'internal_server_error', 'Something went wrong. Please try again.', debug);
        }
      }
      return pathMatched ? err(405, 'method_not_allowed', 'method not allowed') : null;
    },
  };
}

export function constantTimeEqual(a, b) {
  const l = new TextEncoder().encode(String(a)); const r = new TextEncoder().encode(String(b));
  let d = l.length ^ r.length;
  for (let i = 0; i < Math.max(l.length, r.length); i++) d |= (l[i] || 0) ^ (r[i] || 0);
  return d === 0;
}

export function bearer(req) {
  return req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null;
}

export function requireAdmin(c) {
  const key = c.env.ADMIN_API_KEY;
  const supplied = bearer(c.req) || c.req.headers.get('x-admin-key');
  if (!(key && supplied && constantTimeEqual(supplied, key))) throw new HttpError(401, 'unauthorized', 'admin authorization required');
  return { actor: 'admin', role: 'admin' };
}

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function validId(v) { return /^\d{1,18}$/.test(String(v ?? '')); }
