import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText, countWords, sha256Hex, stableStringify, parsePageSpec, formatPageSpec, validatePage, buildPage,
  ocrCacheKey, PAGE_LIMITS,
} from '../src/lib/shared/canonical.js';
import {
  assessPage, indexDecision, detectMathRegions, scoreMathLine, looksGarbled, detectLanguage, summarizeQuality,
} from '../src/lib/shared/textquality.js';
import {
  minhash, jaccardEstimate, mergeSignatures, normalizeForFingerprint, textFingerprintHash, normalizeFilename, SIGNATURE_LENGTH,
} from '../src/lib/shared/fingerprint.js';

// ---------------------------------------------------------------- normalization
test('normalizeText keeps superscripts/Greek (NFC not NFKC) and fixes ligatures and controls', () => {
  assert.equal(normalizeText('E = mc²  Ω'), 'E = mc²  Ω');
  assert.equal(normalizeText('\uFB01eld\u00ADwork\u200B'), 'fieldwork');
  assert.equal(normalizeText('a\u0000b\r\nc\r\n\r\n\r\n\r\nd   \n'), 'ab\nc\n\nd');
});

test('countWords counts words and numbers, not punctuation', () => {
  assert.equal(countWords('Hello, world! 3.14 and e-mail.'), 5);
  assert.equal(countWords('   '), 0);
});

test('sha256Hex matches a known vector and stableStringify is key-order independent', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
});

// ------------------------------------------------------------------ page specs
test('parsePageSpec parses, sorts, de-duplicates and bounds selections', () => {
  assert.deepEqual(parsePageSpec('3-5, 1, 4'), [1, 3, 4, 5]);
  assert.deepEqual(parsePageSpec([2, 1, 2]), [1, 2]);
  assert.equal(formatPageSpec([1, 2, 3, 7, 9, 10]), '1-3,7,9-10');
  assert.throws(() => parsePageSpec('5-3'), RangeError);
  assert.throws(() => parsePageSpec('a'), RangeError);
  assert.throws(() => parsePageSpec('1-40', { total: 35 }), /exceeds document length/);
  assert.throws(() => parsePageSpec('1-5000', { max: 100 }), /exceeds 100 pages/);
  assert.deepEqual(parsePageSpec(''), []);
});

// ------------------------------------------------------------------ validatePage
test('validatePage normalises, recomputes nothing client-controlled and rejects bad shapes', () => {
  const good = validatePage({
    page_number: 3, status: 'ok', method: 'OCR', text: ' Hello\r\n\r\n\r\nworld ', confidence: 1.7,
    warnings: ['LOW_CONFIDENCE', 'not a code', 'LOW_CONFIDENCE'], rotation: 90, language: 'EN',
    blocks: [{ type: 'heading', level: 9, text: 'Intro' }, { type: 'bogus' }, { type: 'table', rows: [['a', 'b'], ['c']] }],
    equations: [{ idx: 0, source_text: 'x=1', latex: 'x=1', bbox: { x: -1, y: 0.5, w: 2, h: 0.1 } }],
  });
  assert.equal(good.ok, true);
  assert.equal(good.page.method, 'ocr');
  assert.equal(good.page.text, 'Hello\n\nworld');
  assert.equal(good.page.confidence, 1);
  assert.deepEqual(good.page.warnings, ['LOW_CONFIDENCE']);
  assert.equal(good.page.blocks.length, 2);
  assert.equal(good.page.blocks[0].level, 6);
  assert.deepEqual(good.page.equations[0].bbox, { x: 0, y: 0.5, w: 1, h: 0.1 });
  assert.equal(good.page.language, 'en');

  for (const bad of [null, [], { page_number: 0, status: 'ok', method: 'ocr' }, { page_number: 1, status: 'weird', method: 'ocr' },
    { page_number: 1, status: 'ok', method: 'Not A Token!' }, { page_number: 1, status: 'ok', method: 'ocr', text: 5 },
    { page_number: 1, status: 'ok', method: 'ocr', confidence: 'x' }, { page_number: 1001, status: 'ok', method: 'ocr' },
    { page_number: 1, status: 'ok', method: 'ocr', location_kind: 'chapter' }]) {
    assert.equal(validatePage(bad).ok, false, JSON.stringify(bad));
  }
});

test('validatePage truncates oversized text with a TRUNCATED warning and keeps failed-page errors', () => {
  const long = validatePage({ page_number: 1, status: 'ok', method: 'pdf-text', text: 'x'.repeat(PAGE_LIMITS.maxTextChars + 50) });
  assert.equal(long.page.text.length, PAGE_LIMITS.maxTextChars);
  assert.ok(long.page.warnings.includes('TRUNCATED'));
  const failed = validatePage({ page_number: 2, status: 'failed', method: 'ocr', error: { code: 'OCR_TIMEOUT', message: 'slow' } });
  assert.deepEqual(failed.page.error, { code: 'OCR_TIMEOUT', message: 'slow', retryable: true });
});

test('validatePage only keeps a signature of exactly 64 int32 values', () => {
  const sig = Array.from({ length: SIGNATURE_LENGTH }, (_, i) => i - 10);
  assert.deepEqual(validatePage({ page_number: 1, status: 'ok', method: 'x', text: 't', signature: sig }).page.signature, sig);
  assert.equal(validatePage({ page_number: 1, status: 'ok', method: 'x', text: 't', signature: sig.slice(1) }).page.signature, null);
  assert.equal(validatePage({ page_number: 1, status: 'ok', method: 'x', text: 't', signature: [...sig.slice(1), 2 ** 40] }).page.signature, null);
});

test('buildPage derives status and OCR cache keys depend on every output-affecting input', async () => {
  assert.equal(buildPage({ page_number: 1, method: 'ocr', text: '   ' }).status, 'empty');
  assert.equal(buildPage({ page_number: 1, method: 'ocr', text: 'abc' }).status, 'ok');
  const base = { sourceSha256: 'a'.repeat(64), page: 3, engine: 'tesseract.js', engineVersion: '5.1.0', languages: ['eng'], dpi: 200, psm: 3, preprocess: ['grayscale'] };
  const k = await ocrCacheKey(base);
  assert.equal(k, await ocrCacheKey({ ...base, languages: ['eng'], preprocess: ['grayscale'] }));
  for (const change of [{ page: 4 }, { dpi: 300 }, { engineVersion: '5.2.0' }, { languages: ['eng', 'swa'] }, { sourceSha256: 'b'.repeat(64) }, { preprocess: [] }, { mode: 'high' }]) {
    assert.notEqual(k, await ocrCacheKey({ ...base, ...change }), JSON.stringify(change));
  }
});

// ------------------------------------------------------------------ text quality
test('assessPage never reports empty text as a successful extraction', () => {
  assert.deepEqual(assessPage({ text: '   \n ', method: 'ocr' }).warnings, ['BLANK_PAGE']);
  assert.equal(assessPage({ text: '', method: 'pdf-text' }).status, 'empty');
  assert.equal(assessPage({ text: 'ab', method: 'ocr' }).status, 'low_text');
  assert.equal(assessPage({ text: 'This is a normal paragraph of lecture notes about electric fields.', method: 'ocr', confidence: 0.9 }).status, 'ok');
  assert.equal(assessPage({ text: 'whatever', method: 'ocr', claimedStatus: 'failed' }).status, 'failed');
});

test('low OCR confidence and garbled output are flagged and held out of the index', () => {
  const low = assessPage({ text: 'The electric field inside a conductor is zero in electrostatic equilibrium.', method: 'ocr', confidence: 0.2 });
  assert.ok(low.warnings.includes('LOW_CONFIDENCE'));
  assert.equal(indexDecision({ status: low.status, warnings: low.warnings }).index_state, 'held');

  const garbage = '|| ~~ ;; ,, ^^ {} [] // \\\\ ## @@ %% && ** !! ?? ~~ ;; ,, ^^ {} [] // \\\\ ## @@ %% && ** !! ?? ~~ ;; ,,';
  assert.equal(looksGarbled(garbage), true);
  assert.equal(looksGarbled('The quick brown fox jumps over the lazy dog near the river bank today.'), false);
  const g = assessPage({ text: garbage, method: 'ocr', confidence: 0.9 });
  assert.ok(g.warnings.includes('GARBLED_TEXT'));

  const text = assessPage({ text: 'A perfectly clean text-layer page with enough words to be useful.', method: 'pdf-text' });
  assert.equal(indexDecision({ status: text.status, warnings: text.warnings }).index_state, 'indexed');
  assert.equal(indexDecision({ status: 'empty', warnings: [] }).index_state, 'rejected');
  assert.equal(indexDecision({ status: 'failed', warnings: [] }).index_state, 'rejected');
  // A reviewer decision overrides an automatic hold, and a reviewer rejection overrides everything.
  assert.equal(indexDecision({ status: 'ok', warnings: ['LOW_CONFIDENCE'], review_state: 'accepted' }).index_state, 'indexed');
  assert.equal(indexDecision({ status: 'ok', warnings: [], review_state: 'rejected' }).index_state, 'rejected');
});

test('math-aware heuristics find equation regions without treating prose as math', () => {
  assert.ok(scoreMathLine('F = q(E + v × B)') >= 0.45);
  assert.ok(scoreMathLine('∮ B·dl = μ₀ I') >= 0.45);
  assert.ok(scoreMathLine('x^2 + y^2 = r^2') >= 0.45);
  assert.ok(scoreMathLine('The magnetic field is produced by moving charges in the wire.') < 0.45);
  const page = 'Gauss law relates flux to charge.\n\nΦ = ∮ E·dA = Q/ε₀\nE = kq/r²\n\nThe field points radially outward.';
  const regions = detectMathRegions(page);
  assert.equal(regions.length, 1);
  assert.match(regions[0].text, /Q\/ε₀/);
  const a = assessPage({ text: page, method: 'ocr', confidence: 0.8 });
  assert.ok(a.warnings.includes('MATH_REGIONS_DETECTED'));
  assert.equal(a.mathRegions.length, 1);
});

test('language detection is conservative', () => {
  assert.equal(detectLanguage('the field of the charge is directed away from the source and it is zero in the conductor for all the points').language, 'en');
  assert.equal(detectLanguage('na hii ni kwa ajili ya wanafunzi wa chuo kikuu na pia ni muhimu kwa watu wote katika nchi hii').language, 'sw');
  assert.equal(detectLanguage('x = 1').language, null);
});

test('summarizeQuality reports good / fair / poor and counts', () => {
  const ok = { status: 'ok', warnings: [], confidence: 0.9, index_state: 'indexed' };
  assert.equal(summarizeQuality([ok, ok, ok]).quality, 'good');
  assert.equal(summarizeQuality([ok, { ...ok, warnings: ['LOW_CONFIDENCE'], index_state: 'held' }]).quality, 'fair');
  const s = summarizeQuality([{ status: 'failed', warnings: [] }, { status: 'empty', warnings: [] }]);
  assert.equal(s.quality, 'poor');
  assert.equal(s.pages_failed, 1);
  assert.equal(s.pages_empty, 1);
});

// ------------------------------------------------------------------ fingerprints
const LOREM = 'Electric charge is a conserved property of matter and the force between two point charges is described by Coulomb law which states that the force is proportional to the product of the charges and inversely proportional to the square of the distance between them in a vacuum';

test('identical text gives identical fingerprints regardless of case, punctuation and whitespace', async () => {
  assert.deepEqual(minhash(LOREM), minhash(`  ${LOREM.toUpperCase()}.  \n\n`));
  assert.equal(await textFingerprintHash(LOREM), await textFingerprintHash(LOREM.replace(/ /g, '   ') + '!!!'));
  assert.equal(normalizeForFingerprint('Électrique, Charge!'), 'electrique charge');
});

test('near-duplicates score high, unrelated texts score near zero, short texts have no signature', () => {
  const edited = LOREM.replace('conserved property of matter', 'conserved quantity').replace('vacuum', 'void');
  const other = 'Photosynthesis converts light energy into chemical energy stored in glucose using carbon dioxide and water inside the chloroplasts of plant cells during daylight hours every single day';
  const near = jaccardEstimate(minhash(LOREM), minhash(edited));
  const far = jaccardEstimate(minhash(LOREM), minhash(other));
  assert.ok(near > 0.45, `near=${near}`);
  assert.ok(far < 0.1, `far=${far}`);
  assert.equal(minhash('too short'), null);
  assert.equal(jaccardEstimate(null, minhash(LOREM)), null);
});

test('union signature equals the signature of the combined shingle sets', () => {
  const a = minhash(LOREM);
  const b = minhash('Photosynthesis converts light energy into chemical energy stored in glucose using carbon dioxide and water inside the chloroplasts of plant cells during daylight');
  const merged = mergeSignatures([a, b]);
  assert.equal(merged.length, SIGNATURE_LENGTH);
  for (let i = 0; i < SIGNATURE_LENGTH; i++) assert.ok((merged[i] >>> 0) <= (a[i] >>> 0) && (merged[i] >>> 0) <= (b[i] >>> 0));
  assert.equal(mergeSignatures([]), null);
});

test('normalizeFilename ignores extension, copy suffixes and punctuation', () => {
  assert.equal(normalizeFilename('PHYS 121 NOTES (2).pdf'), 'phys 121 notes');
  assert.equal(normalizeFilename('phys_121-notes copy.PDF'), 'phys 121 notes');
});
