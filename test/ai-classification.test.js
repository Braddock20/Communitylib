import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectUnitCodeMentions,
  sanitizeSuggestedSegments,
  validateSegmentBoundaries,
} from '../src/utils/ai-classification.js';

const registry = [
  { id: 1, code: 'PHY121', code_display: 'PHY 121', title: 'Electricity, Magnetism, Optics and Modern Physics' },
  { id: 2, code: 'AGRI111', code_display: 'AGRI 111', title: 'Introduction to Agriculture' },
];

test('detects all registry unit codes including spaced and hyphenated forms', () => {
  const found = detectUnitCodeMentions(
    'Part A: PHY121 notes. Part B: AGRI 111 introduction. Later, PHY-121 recap.',
    registry
  );
  assert.deepEqual(found.map((u) => u.id), [1, 2]);
});

test('does not match a code embedded inside a longer alphanumeric token', () => {
  assert.deepEqual(detectUnitCodeMentions('XPHY1219 is not a valid unit reference', registry), []);
});

test('sanitizes invalid segment boundaries instead of silently repairing them', () => {
  const [missing, reversed, fractional, valid] = sanitizeSuggestedSegments([
    { title: 'Missing', page_start: null, page_end: 2 },
    { title: 'Reversed', page_start: 8, page_end: 3 },
    { title: 'Fractional', page_start: 1.5, page_end: 2 },
    { title: 'Valid', page_start: 2, page_end: 4, unit_code: 'PHY 121' },
  ], registry);
  assert.equal(missing.page_start, null);
  assert.equal(missing.requires_review, true);
  assert.equal(reversed.page_start, null);
  assert.equal(reversed.page_end, null);
  assert.equal(fractional.page_start, null);
  assert.equal(valid.page_start, 2);
  assert.equal(valid.unit_code, 'PHY121');
});

test('validates page bounds, document length, and overlap before splitting', () => {
  assert.deepEqual(validateSegmentBoundaries([
    { page_start: 1, page_end: 3 },
    { page_start: 4, page_end: 6 },
  ], 6), []);
  assert.ok(validateSegmentBoundaries([{ page_start: null, page_end: 2 }], 6).length);
  assert.ok(validateSegmentBoundaries([{ page_start: 1, page_end: 7 }], 6).length);
  assert.ok(validateSegmentBoundaries([
    { page_start: 1, page_end: 3 },
    { page_start: 3, page_end: 4 },
  ], 6).some((e) => e.includes('overlap')));
  assert.ok(validateSegmentBoundaries([{ page_start: 4, page_end: 2 }], 6).length);
});


test('detects a unit code at the very start of text and after a filename seam', () => {
  assert.deepEqual(detectUnitCodeMentions('PHY 121 notes begin here', registry).map((u) => u.id), [1]);
  assert.deepEqual(detectUnitCodeMentions('Combined_Notes.pdf\nAGRI111 starts here', registry).map((u) => u.id), [2]);
});

test('detects both codes even when one is spaced and preserves first-mention order', () => {
  const found = detectUnitCodeMentions('AGRI-111 then PHY121 then AGRI111 again', registry);
  assert.deepEqual(found.map((u) => u.id), [2, 1]);
});

test('does not treat code-like words without a registry match as verified', () => {
  assert.deepEqual(detectUnitCodeMentions('ZZZ999 unknown course code', registry), []);
});
