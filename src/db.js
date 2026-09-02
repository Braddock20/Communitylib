import { neon } from '@neondatabase/serverless';

/**
 * Resolve a Postgres connection string from the common env names and
 * normalize the harmless formatting people commonly paste into secrets:
 *   DATABASE_URL="postgresql://..."
 *   'postgres://...'
 *   DATABASE_URL=postgres://...
 *
 * Pooled and unpooled Neon URLs are both valid; the hostname is never
 * rewritten because Neon decides pooling from the URL itself.
 */
export function normalizeDatabaseUrl(raw) {
  if (raw == null) return '';

  let value = String(raw).replace(/^\uFEFF/, '').trim();

  // If someone pasted an entire .env-style block (multiple lines, a
  // comment, a second KEY=value line), keep only the first non-comment,
  // non-blank line.
  if (value.includes('\n')) {
    const firstUsableLine = value
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#'));
    value = firstUsableLine || value;
  }

  // Accept someone pasting the whole dotenv assignment or shell export.
  value = value
    .replace(/^export\s+/i, '')
    .replace(/^(?:DATABASE_URL|DATABASE_URL_UNPOOLED|POSTGRES_URL|POSTGRES_URL_NON_POOLING)\s*=\s*/i, '')
    .trim();

  // Also accept a copied `psql 'postgresql://...'` command.
  value = value.replace(/^psql\s+/i, '').trim();

  // Strip matching outer quotes/backticks, including repeated accidental quoting.
  for (let i = 0; i < 2; i++) {
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
        value = value.slice(1, -1).trim();
      }
    }
  }

  // JSON-style escaped quotes occasionally arrive from copy/paste.
  if (value.startsWith('\\"') && value.endsWith('\\"')) {
    value = value.slice(1, -1);
  }

  return value;
}

const CANDIDATE_ENV_NAMES = [
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'NEON_DATABASE_URL',
];

function candidateEnvEntries(env) {
  return CANDIDATE_ENV_NAMES
    .map((name) => ({ name, raw: env?.[name] }))
    .filter(({ raw }) => raw != null && String(raw).trim() !== '');
}

export function getDatabaseUrl(env) {
  for (const { raw } of candidateEnvEntries(env)) {
    const url = normalizeDatabaseUrl(raw);
    try {
      const parsed = new URL(url);
      if ((parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') && parsed.hostname) {
        return url;
      }
    } catch {
      // Try the next common env variable instead of failing immediately.
    }
  }

  throw new Error(
    'DATABASE_URL is missing or invalid. Provide a PostgreSQL/Neon connection string in DATABASE_URL (pooled or unpooled).'
  );
}

// Per-isolate cache. A Worker isolate handles many requests over its
// lifetime, so once a candidate actually connects, reuse it instead of
// re-testing every candidate on every request.
let cachedWorkingUrl = null;
let cachedWorkingSource = null;

/**
 * Try every configured candidate, in order, until one actually answers a
 * query — not just parses as a valid URL. Returns { sql, source, url }.
 * On total failure, throws an Error whose `.attempts` property is a
 * structured (never-credential-bearing) breakdown of what was tried and
 * why each one failed, so a caller can choose to surface it for debugging
 * without exposing it to the public by default.
 */
export async function resolveDb(env) {
  if (cachedWorkingUrl) {
    return { sql: neon(cachedWorkingUrl), source: cachedWorkingSource, url: cachedWorkingUrl };
  }

  const entries = candidateEnvEntries(env);
  const attempts = [];

  if (entries.length === 0) {
    const err = new Error(
      'No database env var is set. Expected one of: ' + CANDIDATE_ENV_NAMES.join(', ')
    );
    err.attempts = attempts;
    throw err;
  }

  for (const { name, raw } of entries) {
    const url = normalizeDatabaseUrl(raw);

    let parsed;
    try {
      parsed = new URL(url);
      if (!((parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') && parsed.hostname)) {
        attempts.push({ source: name, ok: false, reason: 'does not look like a postgres:// URL' });
        continue;
      }
    } catch {
      attempts.push({ source: name, ok: false, reason: 'failed to parse as a URL' });
      continue;
    }

    try {
      const sql = neon(url);
      await sql`SELECT 1`;
      cachedWorkingUrl = url;
      cachedWorkingSource = name;
      return { sql, source: name, url };
    } catch (err) {
      attempts.push({
        source: name,
        ok: false,
        host: parsed.hostname,
        reason: err?.message || String(err),
      });
    }
  }

  const err = new Error('No database candidate could connect.');
  err.attempts = attempts;
  throw err;
}

/** Back-compat convenience: resolve and return just the tagged-template client. */
export async function getDb(env) {
  const { sql } = await resolveDb(env);
  return sql;
}

/**
 * Redacted connection diagnostics for admin logs. Never returns the
 * password or full connection string. Reflects the first *parseable*
 * candidate, which may not be the one that actually connects — use
 * resolveDb()/getDb() for that.
 */
export function databaseInfo(env) {
  const url = getDatabaseUrl(env);
  const parsed = new URL(url);
  return {
    configured: true,
    protocol: parsed.protocol.replace(':', ''),
    host: parsed.hostname,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || null,
    pooled: /-pooler(?:\.|$)/i.test(parsed.hostname),
  };
}
