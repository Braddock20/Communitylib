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

function candidateEnvValues(env) {
  return [
    env?.DATABASE_URL,
    env?.DATABASE_URL_UNPOOLED,
    env?.POSTGRES_URL,
    env?.POSTGRES_URL_NON_POOLING,
    env?.NEON_DATABASE_URL,
  ].filter((v) => v != null && String(v).trim() !== '');
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

export function getDb(env) {
  return neon(getDatabaseUrl(env));
}

/**
 * Redacted connection diagnostics for health/admin logs. Never return the
 * password or full connection string to clients.
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
