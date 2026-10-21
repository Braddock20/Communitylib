import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const registry = JSON.parse(await readFile(new URL('../data/uoe-timetable-extracted-units.json', import.meta.url), 'utf8'));
test('bundled UoE timetable extraction is source-labelled and reviewable', () => {
  assert.equal(registry.source_type, 'official_timetable');
  assert.equal(registry.source_date, '2026-07-20');
  assert.ok(registry.units.length > 1000);
  assert.ok(registry.units.every((u) => typeof u.code === 'string' && u.code.trim() && typeof u.title === 'string' && u.title.trim()));
  assert.ok(registry.units.every((u) => u.confidence <= 0.65));
  assert.match(registry.notice, /not a complete master catalogue/i);
});
