#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const apiBase = (process.env.COMMUNITYLIB_API || '').replace(/\/+$/, '');
const adminKey = process.env.ADMIN_API_KEY || '';
const input = resolve(process.argv[2] || 'data/uoe-timetable-extracted-units.json');
if (!apiBase || !adminKey) {
  console.error('Usage: COMMUNITYLIB_API=https://YOUR-WORKER.example ADMIN_API_KEY=... node scripts/import-unit-registry.mjs [path-to-json]');
  process.exit(2);
}
const payload = JSON.parse(await readFile(input, 'utf8'));
if (!Array.isArray(payload.units) || payload.units.length < 1) throw new Error('Input JSON must contain a units array.');
console.log(`Importing ${payload.units.length} source-derived unit entries from: ${payload.source_name}`);
console.log('Caution: timetable extraction is provisional and does not prove a complete current unit catalogue.');
const response = await fetch(`${apiBase}/api/ai/registry/import`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
  body: JSON.stringify(payload),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`Import failed (${response.status}):`, JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ imported_count: body.imported_count, rejected_count: body.rejected_count, rejected: body.rejected }, null, 2));
