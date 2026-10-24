// Real-Postgres test fixtures. Builds (once per migration-set hash) a template
// database containing schema.sql + migrations 004/005/006, then clones it per
// test file so tests are isolated and fast.
//
// Connection: PGTEST_URL (default postgres://postgres@127.0.0.1:54329/postgres).
// When no database is reachable, `dbAvailable()` is false and DB-backed tests
// call `t.skip(reason)`. A skipped test is NOT a passed test; the delivery report
// states which suites ran.
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSql, parseConnectionUrl } from './pgwire.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ADMIN_URL = process.env.PGTEST_URL || 'postgres://postgres@127.0.0.1:54329/postgres';
const SCRIPTS = ['schema.sql', 'migrations/004_ai_library.sql', 'migrations/005_performance_safety.sql'];
const FULL = [...SCRIPTS, 'migrations/006_document_intelligence.sql'];

function withDb(url, db) { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); }

export async function dbAvailable() {
  try { const sql = await createSql(ADMIN_URL, { size: 1 }); await sql`select 1`; await sql.end(); return true; }
  catch { return false; }
}

async function scriptsHash(files) {
  const h = createHash('sha256');
  for (const f of files) h.update(await readFile(path.join(ROOT, f)));
  return h.digest('hex').slice(0, 12);
}

async function ensureTemplate(admin, files, prefix) {
  const name = `${prefix}_${await scriptsHash(files)}`;
  await admin`select pg_advisory_lock(424242)`;
  try {
    const [exists] = await admin`select 1 as ok from pg_database where datname = ${name}`;
    if (!exists) {
      const tmpName = `${name}_building`;
      await admin.query(`DROP DATABASE IF EXISTS ${tmpName}`);
      await admin.query(`CREATE DATABASE ${tmpName}`);
      const t = await createSql(withDb(ADMIN_URL, tmpName), { size: 1 });
      for (const f of files) await t.script(await readFile(path.join(ROOT, f), 'utf8'));
      await t.end();
      await admin.query(`ALTER DATABASE ${tmpName} RENAME TO ${name}`);
    }
  } finally { await admin`select pg_advisory_unlock(424242)`; }
  return name;
}

/**
 * @param {{legacyOnly?: boolean}} opts  legacyOnly = schema+004+005 only (pre-006), for migration tests.
 */
export async function createTestDb(opts = {}) {
  const admin = await createSql(ADMIN_URL, { size: 2 });
  const template = await ensureTemplate(admin, opts.legacyOnly ? SCRIPTS : FULL, opts.legacyOnly ? 'cl_tpl_legacy' : 'cl_tpl_full');
  const name = `cl_t_${randomBytes(5).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  const url = withDb(ADMIN_URL, name);
  const sql = await createSql(url, { size: 6 });
  return {
    sql, url, name,
    async drop() {
      await sql.end();
      await new Promise((r) => setTimeout(r, 50));
      try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } catch { /* best effort */ }
      await admin.end();
    },
  };
}

export async function readRepoFile(rel) { return readFile(path.join(ROOT, rel), 'utf8'); }
export { ROOT, parseConnectionUrl };

/** Seed one unit/resource/file the way the upload route would. Returns ids. */
export async function seedResource(sql, { code = 'PHY121', title = 'Electricity, Magnetism, Optics and Modern Physics',
  resourceTitle = 'Notes - PHY121', type = 'notes', filename = 'PHYS 121 NOTES.pdf', ext = 'pdf', hash, size = 21480560, flagged = false } = {}) {
  const fileHash = hash || createHash('sha256').update(`${code}:${filename}:${randomBytes(4).toString('hex')}`).digest('hex');
  const [unit] = await sql`
    INSERT INTO units(code, code_display, title) VALUES (${code}, ${code.replace(/(\D+)(\d+)/, '$1 $2')}, ${title})
    ON CONFLICT (code, title) DO UPDATE SET title = EXCLUDED.title RETURNING id`;
  const [resource] = await sql`
    INSERT INTO resources(unit_id, type, title, file_count, primary_ext, content_hash, is_flagged)
    VALUES (${unit.id}, ${type}, ${resourceTitle}, 1, ${ext}, ${fileHash}, ${flagged}) RETURNING id`;
  const key = `units/${unit.id}/${type}/${fileHash.slice(0, 8)}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const [file] = await sql`
    INSERT INTO resource_files(resource_id, order_index, file_name, file_url, file_ext, file_size_bytes, file_hash)
    VALUES (${resource.id}, 0, ${filename}, ${`/api/files/${key}`}, ${ext}, ${size}, ${fileHash}) RETURNING id`;
  await sql`UPDATE units SET resource_count = resource_count + 1 WHERE id = ${unit.id}`;
  return { unitId: unit.id, resourceId: resource.id, fileId: file.id, key, hash: fileHash };
}
