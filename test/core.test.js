import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCode, normalizeText, sha256Hex, combineHashes } from '../src/utils/hash.js';

test('unit codes normalize consistently', () => {
  assert.equal(normalizeCode(' mat  201 '), 'MAT201');
  assert.equal(normalizeCode('MPE-210'), 'MPE210');
  assert.equal(normalizeCode('phys_121'), 'PHYS121');
});
test('text normalization is case/whitespace insensitive', () => {
  assert.equal(normalizeText('  Linear\n  Algebra  '), 'linear algebra');
});
test('SHA-256 hashes are stable and resource hashes ignore file order', async () => {
  const a = await sha256Hex(new TextEncoder().encode('alpha'));
  const b = await sha256Hex(new TextEncoder().encode('beta'));
  assert.equal(a, await sha256Hex(new TextEncoder().encode('alpha')));
  assert.equal(await combineHashes([a,b]), await combineHashes([b,a]));
  assert.notEqual(await combineHashes([a,a,b]), await combineHashes([a,b]));
});
