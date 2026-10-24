// Document fingerprinting for duplicate detection (shared by browser/processor/Worker).
//
// Text hash  : exact-duplicate detection (after normalisation, so whitespace/case
//              differences do not hide a duplicate).
// MinHash    : 64 signed 32-bit values over word 4-gram shingles. The fraction of equal
//              positions between two signatures estimates the Jaccard similarity of
//              their shingle sets, which is what "near-duplicate text" means here.
//              The signature of a UNION of texts is the element-wise minimum of the
//              signatures, so a whole-resource signature can be derived from page
//              signatures (also computable in SQL) without re-reading any text.
import { sha256Hex } from './canonical.js';

export const SIGNATURE_LENGTH = 64;
export const SHINGLE_SIZE = 4;
const MIN_SHINGLES = 8; // below this a signature would be noise: return null

/** Lower-case, strip punctuation/diacritics noise, collapse whitespace. */
export function normalizeForFingerprint(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function textFingerprintHash(text) {
  const n = normalizeForFingerprint(text);
  return n ? sha256Hex(n) : null;
}

// 32-bit FNV-1a with a seed folded in, followed by a murmur3-style avalanche so that
// different seeds behave like independent hash functions.
function hash32(str, seed) {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const SEEDS = Array.from({ length: SIGNATURE_LENGTH }, (_, i) => Math.imul(i + 1, 0x9e3779b1) >>> 0);

export function shingles(text, k = SHINGLE_SIZE) {
  const words = normalizeForFingerprint(text).split(' ').filter(Boolean);
  if (words.length < k) return words.length >= MIN_SHINGLES ? [words.join(' ')] : [];
  const out = new Set();
  for (let i = 0; i + k <= words.length; i++) out.add(words.slice(i, i + k).join(' '));
  return [...out];
}

/** MinHash signature as an array of signed int32 (fits Postgres INTEGER[]); null when text is too short. */
export function minhash(text) {
  const sh = shingles(text);
  if (sh.length < MIN_SHINGLES) return null;
  const sig = new Array(SIGNATURE_LENGTH).fill(0xffffffff);
  for (const s of sh) {
    const base = hash32(s, 0x5bd1e995);
    for (let i = 0; i < SIGNATURE_LENGTH; i++) {
      const h = hash32(String(base), SEEDS[i]);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig.map((v) => v | 0); // unsigned -> signed int32
}

/** Estimated Jaccard similarity of two signatures, in [0,1]. Returns null if either is missing/invalid. */
export function jaccardEstimate(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== SIGNATURE_LENGTH || b.length !== SIGNATURE_LENGTH) return null;
  let same = 0;
  for (let i = 0; i < SIGNATURE_LENGTH; i++) if (a[i] === b[i]) same++;
  return same / SIGNATURE_LENGTH;
}

/** Signature of the union of several texts = element-wise minimum (unsigned compare). */
export function mergeSignatures(signatures) {
  const valid = signatures.filter((s) => Array.isArray(s) && s.length === SIGNATURE_LENGTH);
  if (!valid.length) return null;
  const out = new Array(SIGNATURE_LENGTH);
  for (let i = 0; i < SIGNATURE_LENGTH; i++) {
    let m = valid[0][i] >>> 0;
    for (const s of valid) { const v = s[i] >>> 0; if (v < m) m = v; }
    out[i] = m | 0;
  }
  return out;
}

/** Normalised filename for the filename+size heuristic: "PHYS 121 NOTES (2).pdf" -> "phys 121 notes". */
export function normalizeFilename(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')
    .replace(/\(\d+\)|[-_ ]copy( ?\d+)?$|[-_ ]\d{1,2}$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
