#!/usr/bin/env node
// Copies the shared modules into the static console (no build step is used).
// `node scripts/sync-shared.mjs --check` fails if the copies drifted (CI runs it).
import { copyFile, readFile } from 'node:fs/promises';
const FILES = ['canonical', 'textquality', 'fingerprint'];
const check = process.argv.includes('--check');
let drift = 0;
for (const f of FILES) {
  const src = new URL(`../src/lib/shared/${f}.js`, import.meta.url);
  const dst = new URL(`../frontend/console/js/shared/${f}.js`, import.meta.url);
  if (check) { if ((await readFile(src, 'utf8')) !== (await readFile(dst, 'utf8').catch(() => ''))) { console.error(`DRIFT: ${f}.js`); drift++; } }
  else await copyFile(src, dst);
}
if (check && drift) process.exit(1);
console.log(check ? 'shared copies in sync' : 'shared modules copied');
