import { neon } from '@neondatabase/serverless';

/**
 * Resolve a Postgres connection string from the common env names and
 * normalize the harmless formatting people commonly paste into secrets:
 *   DATABASE_URL="postgresql://..."
 *   'postgres://...'
 *   DATABASE_URL=postgres://...
 *
 * Pooled and unpooled Neon URLs are both valid; we deliberately do not
 * rewrite the hostname because Neon decides pooling from the URL itself.
 */
export function normalizeDatabaseUrl(raw) {
  if (raw == null) return '';

  let value = String(raw).replace(/^\uFEFF/, '').trim();

  // If someone pasted an entire .env-style block (multiple lines, a
  // comment, a second KEY=value line), keep only the first non-comment,
  // non-blank line. Pasting the whole block verbatim is a common mistake
  // and previously produced an unparsable multi-line "URL".
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

function candidateEnvValues(env) {
  return candidateEnvEntries(env).map(({ raw }) => raw);
}

export function getDatabaseUrl(env) {
  const candidates = candidateEnvValues(env);
  for (const raw of candidates) {
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
// lifetime, so once we find a candidate that actually connects, reuse it
// instead of re-testing every candidate on every request. If the cached
// one starts failing later (e.g. a rotated password) the isolate will
// surface that error until it's recycled, which happens naturally.
let cachedWorkingUrl = null;
let cachedWorkingSource = null;

/**
 * Try every configured candidate, in order, until one actually answers a
 * query — not just parses as a valid URL. This is what lets a bad pooled
 * connection fall back to a working direct/unpooled one (or vice versa)
 * without a redeploy. Returns { sql, source, url }.
 */
export async function resolveDb(env) {
  if (cachedWorkingUrl) {
    return { sql: neon(cachedWorkingUrl), source: cachedWorkingSource, url: cachedWorkingUrl };
  }

  const entries = candidateEnvEntries(env);
  if (entries.length === 0) {
    throw new Error(
      'No database env var is set. Expected one of: ' + CANDIDATE_ENV_NAMES.join(', ')
    );
  }

  const attempts = [];
  for (const { name, raw } of entries) {
    const url = normalizeDatabaseUrl(raw);

    let parsed;
    try {
      parsed = new URL(url);
      if (!((parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') && parsed.hostname)) {
        attempts.push(`${name}: does not look like a postgres:// URL`);
        continue;
      }
    } catch {
      attempts.push(`${name}: failed to parse as a URL`);
      continue;
    }

    try {
      const sql = neon(url);
      await sql`SELECT 1`;
      cachedWorkingUrl = url;
      cachedWorkingSource = name;
      return { sql, source: name, url };
    } catch (err) {
      attempts.push(`${name} (${parsed.hostname}): ${err?.message || err}`);
    }
  }

  // Logged server-side only (Workers Logs / wrangler tail) — never sent to
  // the client. Hostnames only, never credentials.
  throw new Error(`No database candidate could connect. Tried:\n${attempts.join('\n')}`);
}

/** Back-compat convenience: resolve and return just the tagged-template client. */
export async function getDb(env) {
  const { sql } = await resolveDb(env);
  return sql;
}

/**
 * Redacted connection diagnostics for health/admin logs. Never return the
 * password or full connection string to clients. Reflects the first
 * *parseable* candidate, which may not be the one that actually connects —
 * use resolveDb()/getDb() for that.
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
