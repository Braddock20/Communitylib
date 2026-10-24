#!/usr/bin/env node
// Verifies migration 006 on a THROWAWAY database: apply, re-apply (idempotent), guarded rollback, re-apply.
// Usage: PGTEST_URL=postgres://user@host:port/postgres node scripts/verify-migration.mjs
// Never point this at production: it creates and drops its own database.
import { createTestDb, dbAvailable } from '../test/helpers/db.js';
import { readFile } from 'node:fs/promises';
if (!(await dbAvailable())) { console.error('No Postgres reachable via PGTEST_URL; nothing was verified.'); process.exit(2); }
const db = await createTestDb({ legacyOnly: true });
const up = await readFile(new URL('../migrations/006_document_intelligence.sql', import.meta.url), 'utf8');
const down = await readFile(new URL('../migrations/006_rollback.sql', import.meta.url), 'utf8');
const count = async () => Number((await db.sql`SELECT count(*) n FROM information_schema.tables WHERE table_schema='public'`)[0].n);
try {
  const before = await count();
  await db.sql.script(up); const applied = await count();
  await db.sql.script(up); if ((await count()) !== applied) throw new Error('re-apply changed table count');
  let refused = false; try { await db.sql.script(down); } catch { refused = true; await db.sql.script('ROLLBACK'); }
  if (!refused) throw new Error('rollback ran without confirmation');
  await db.sql.script("SET communitylib.confirm_rollback='yes';\n" + down);
  // schema_migrations is deliberately kept (shared registry); only its '006' row is removed.
  if ((await count()) !== before + 1) throw new Error(`rollback left ${await count()} tables, expected ${before + 1}`);
  if ((await db.sql`SELECT 1 FROM schema_migrations WHERE version='006'`).length) throw new Error('006 row not removed');
  await db.sql.script(up);
  console.log(`OK: ${before} -> ${applied} tables; idempotent; guarded rollback; re-apply`);
} catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; } finally { await db.drop(); }
