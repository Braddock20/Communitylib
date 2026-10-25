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

import { classifyDocumentEvidence, inferDocumentType } from '../src/utils/ai-classification.js';

test('deterministic evidence prefers document body over a misleading filename', () => {
  const result = classifyDocumentEvidence({
    filename: 'CHEM 111 CAT 1.pdf',
    text: 'PHY121: Coulomb law, electric field, electric potential and capacitance.',
    registry: [
      { id: 1, code: 'PHY121', title: 'Electricity, Magnetism, Optics and Modern Physics' },
      { id: 2, code: 'CHEM111', title: 'Introductory Chemistry' },
    ],
  });
  assert.equal(result.primary_unit.code, 'PHY121');
  assert.equal(result.filename_conflict, true);
  assert.ok(result.topics.includes('Electricity and magnetism'));
  assert.equal(result.evidence_tier, 'strong');
});

test('deterministic evidence detects multiple registered units in document order', () => {
  const result = classifyDocumentEvidence({
    filename: 'combined.pdf',
    text: 'SECTION A — PHY121: electric field and Coulomb law. SECTION B — PHY111: mechanics and Newton laws.',
    registry: [
      { id: 1, code: 'PHY121', title: 'Electricity, Magnetism, Optics and Modern Physics' },
      { id: 2, code: 'PHY111', title: 'Mechanics, Heat and Waves' },
    ],
  });
  assert.deepEqual(result.detected_units.map(u => u.code), ['PHY121', 'PHY111']);
  assert.equal(result.primary_unit.code, 'PHY121');
  assert.equal(result.multi_unit, true);
  assert.ok(result.topics.includes('Electricity and magnetism'));
  assert.ok(result.topics.includes('Mechanics'));
});

test('filename-only evidence is weak and inferred document type uses source evidence', () => {
  const result = classifyDocumentEvidence({
    filename: 'PHY121 CAT 1.pdf', text: '',
    registry: [{ id: 1, code: 'PHY121', title: 'Electricity and Magnetism' }],
  });
  assert.equal(result.evidence_tier, 'weak');
  assert.equal(result.detected_units[0].code, 'PHY121');
  assert.equal(inferDocumentType('', 'PHY121 CAT 1.pdf'), 'cat');
});

test('suggested page ranges are never called physically validated by shape alone', () => {
  const [segment] = sanitizeSuggestedSegments([{ title: 'Section A', page_start: 1, page_end: 3 }], registry);
  assert.equal(segment.page_start, 1);
  assert.equal(segment.page_end, 3);
  assert.equal(segment.boundary_valid, false);
  assert.equal(segment.requires_review, true);
});
