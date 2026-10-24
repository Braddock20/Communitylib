// Text-quality assessment shared by the Worker, browser client and processor.
//
// These are HEURISTICS. They exist to (a) refuse to treat empty/garbled output as a
// successful extraction, (b) decide whether a page is safe to put into the search
// index, and (c) flag regions that need human review (notably mathematics). Nothing
// here proves that text is correct; the API and UI describe results as "recognised
// text", never as verified.
import { countWords } from './canonical.js';

export const DEFAULT_POLICY = Object.freeze({
  minCharsForOk: 20,          // fewer visible characters than this -> low_text (or empty)
  minOcrConfidence: 0.45,     // OCR pages below this are held for review, not indexed
  minAlphaRatio: 0.35,        // share of letters among non-space characters in prose
  maxSymbolRatio: 0.45,       // share of "odd" symbols that indicates garbage
  holdOnWarnings: ['GARBLED_TEXT', 'LOW_CONFIDENCE'],
  textLayerMethods: ['pdf-text', 'docx', 'xlsx', 'pptx', 'csv', 'html', 'text', 'markdown'],
});

const MATH_CHARS = /[=+\-−×÷·∫∑∏√∂∇±≈≠≤≥→←⇒⇔∞∝°′″∈∉⊂⊆∪∩∀∃∧∨¬]/g;
const GREEK = /[α-ωΑ-Ωϕϵϑϖ]/g;
const SUPSUB = /[²³¹⁰⁴-⁹⁺⁻⁼⁽⁾ⁿ₀-₉₊₋₌₍₎]/g;
const CARET_UNDERSCORE = /[A-Za-z0-9)\]][\^_](?:\{[^}]{1,20}\}|[-+]?[A-Za-z0-9]{1,3})/g;
const FRACTION = /\b\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\b|\b[a-zA-Z]\s*\/\s*[a-zA-Z]\b/g;
const FUNCTIONS = /\b(?:sin|cos|tan|cot|sec|csc|log|ln|exp|lim|det|max|min|arg|erf|sinh|cosh|tanh)\b|\bd\s*\/\s*d[a-z]\b|\bdx\b|\bdy\b|\bdt\b/gi;
const UNITS = /\b\d+(?:\.\d+)?\s?(?:m|s|kg|N|J|V|A|Ω|F|H|T|Hz|W|C|mol|K|cm|mm|nm|eV|Pa)(?:\s?[·/]\s?[A-Za-z]+)?\b/g;
const CHEM = /\b(?:[A-Z][a-z]?\d*){2,}(?:\s?(?:→|->|⇌|=)\s?(?:[A-Z][a-z]?\d*){1,})/g;

function lines(text) { return String(text || '').split('\n'); }
function count(re, s) { const m = s.match(re); return m ? m.length : 0; }

/** Ratio helpers over non-whitespace characters. */
export function characterStats(text) {
  const compact = String(text || '').replace(/\s+/g, '');
  const n = compact.length;
  if (!n) return { total: 0, alpha: 0, digit: 0, symbol: 0, alphaRatio: 0, symbolRatio: 0 };
  const alpha = (compact.match(/\p{L}/gu) || []).length;
  const digit = (compact.match(/\p{N}/gu) || []).length;
  const symbol = n - alpha - digit - (compact.match(/[.,;:!?'"()\-–—]/g) || []).length;
  return { total: n, alpha, digit, symbol, alphaRatio: alpha / n, symbolRatio: Math.max(0, symbol) / n };
}

/**
 * Detect OCR garbage: very low letter ratio in prose, long runs of one character,
 * a flood of single-character tokens, or an implausible average word length.
 * Equation-heavy pages legitimately have odd symbols, so math lines are excluded.
 */
export function looksGarbled(text, policy = DEFAULT_POLICY) {
  const prose = lines(text).filter((l) => scoreMathLine(l) < 0.45).join('\n');
  const stats = characterStats(prose);
  if (stats.total < 30) return false;
  if (stats.alphaRatio < policy.minAlphaRatio && stats.digit / stats.total < 0.5) return true;
  if (stats.symbolRatio > policy.maxSymbolRatio) return true;
  if (/(.)\1{9,}/.test(prose)) return true;
  const tokens = prose.split(/\s+/).filter(Boolean);
  if (tokens.length >= 15) {
    const single = tokens.filter((t) => t.length === 1 && !/[aAI\d]/.test(t)).length;
    if (single / tokens.length > 0.35) return true;
    const avg = tokens.reduce((s, t) => s + t.length, 0) / tokens.length;
    if (avg > 18) return true;
  }
  return false;
}

/** Score one line 0..1 for "looks like mathematics / science notation". */
export function scoreMathLine(line) {
  const s = String(line || '').trim();
  if (s.length < 3) return 0;
  const words = (s.match(/\p{L}{3,}/gu) || []).length;
  const tokens = s.split(/\s+/).length;
  const proseWordRatio = tokens ? words / tokens : 0;
  const raw = count(MATH_CHARS, s) * 0.12 + count(GREEK, s) * 0.25 + count(SUPSUB, s) * 0.3
    + count(CARET_UNDERSCORE, s) * 0.35 + count(FRACTION, s) * 0.25 + count(FUNCTIONS, s) * 0.3
    + count(UNITS, s) * 0.12 + count(CHEM, s) * 0.4;
  const eqSign = /[=≈≠≤≥]/.test(s) ? 0.2 : 0;
  const penalty = proseWordRatio > 0.7 ? 0.35 : proseWordRatio > 0.5 ? 0.15 : 0;
  return Math.max(0, Math.min(1, raw + eqSign - penalty));
}

/**
 * Find candidate equation / notation regions in page text. Adjacent math-looking
 * lines are merged. These are CANDIDATES for review or for a math-aware engine;
 * they are not claims that an equation was correctly read.
 */
export function detectMathRegions(text, { threshold = 0.45, mergeGap = 1 } = {}) {
  const all = lines(text);
  const regions = [];
  let current = null;
  all.forEach((line, i) => {
    const score = scoreMathLine(line);
    if (score >= threshold) {
      if (current && i - current.end_line <= mergeGap + 1) {
        current.end_line = i; current.scores.push(score);
      } else {
        if (current) regions.push(current);
        current = { start_line: i, end_line: i, scores: [score] };
      }
    }
  });
  if (current) regions.push(current);
  return regions.map((r) => ({
    start_line: r.start_line,
    end_line: r.end_line,
    text: all.slice(r.start_line, r.end_line + 1).join('\n').trim(),
    score: Math.round((r.scores.reduce((a, b) => a + b, 0) / r.scores.length) * 1000) / 1000,
  })).filter((r) => r.text.length >= 3);
}

/** Share of lines that look like mathematics (used for page-level math warnings). */
export function mathDensity(text) {
  const ls = lines(text).filter((l) => l.trim());
  if (!ls.length) return 0;
  return ls.filter((l) => scoreMathLine(l) >= 0.45).length / ls.length;
}

/** Tiny stop-word language guess (en / sw / fr). Returns {language, confidence}. */
const STOP = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'for', 'with', 'are', 'this', 'be', 'by', 'as', 'on', 'which', 'an', 'from', 'at', 'it'],
  sw: ['na', 'ya', 'wa', 'kwa', 'ni', 'za', 'katika', 'la', 'cha', 'kama', 'hii', 'huo', 'au', 'pia', 'lakini', 'sana', 'kuwa', 'yake', 'wake', 'hiyo'],
  fr: ['le', 'la', 'les', 'des', 'et', 'est', 'une', 'dans', 'pour', 'que', 'qui', 'sur', 'pas', 'par', 'avec', 'sont', 'ce', 'du', 'au', 'plus'],
};
export function detectLanguage(text) {
  const words = String(text || '').toLowerCase().match(/\p{L}+/gu) || [];
  if (words.length < 12) return { language: null, confidence: 0 };
  const scores = {};
  for (const [lang, list] of Object.entries(STOP)) {
    const set = new Set(list);
    scores[lang] = words.filter((w) => set.has(w)).length / words.length;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] < 0.06) return { language: null, confidence: 0 };
  const margin = best[1] - (second?.[1] || 0);
  return { language: best[0], confidence: Math.round(Math.min(1, margin / 0.15 + 0.3) * 100) / 100 };
}

/**
 * Assess one page of extractor output.
 * Returns { status, warnings, blank, score, mathRegions }.
 * `status` may DOWNGRADE what the extractor claimed ("ok" with no text is "empty"),
 * but never upgrades a failed page.
 */
export function assessPage({ text, confidence = null, method = '', claimedStatus = 'ok' }, policy = DEFAULT_POLICY) {
  const warnings = [];
  const t = String(text || '');
  const stats = characterStats(t);
  if (claimedStatus === 'failed' || claimedStatus === 'skipped') {
    return { status: claimedStatus, warnings, blank: false, score: 0, mathRegions: [] };
  }
  if (stats.total === 0) {
    warnings.push('BLANK_PAGE');
    return { status: 'empty', warnings, blank: true, score: 0, mathRegions: [] };
  }
  let status = 'ok';
  if (stats.total < policy.minCharsForOk) { status = 'low_text'; warnings.push('LOW_TEXT'); }

  const isOcr = !policy.textLayerMethods.includes(method);
  if (isOcr && confidence != null && confidence < policy.minOcrConfidence) warnings.push('LOW_CONFIDENCE');
  if (looksGarbled(t, policy)) warnings.push('GARBLED_TEXT');

  const mathRegions = detectMathRegions(t);
  if (mathRegions.length) warnings.push('MATH_REGIONS_DETECTED');
  if (isOcr && mathDensity(t) >= 0.15) warnings.push('EQUATIONS_UNVERIFIED');

  let score = 1;
  if (isOcr) score = confidence == null ? 0.6 : confidence;
  if (warnings.includes('GARBLED_TEXT')) score = Math.min(score, 0.2);
  if (status === 'low_text') score = Math.min(score, 0.4);
  return { status, warnings, blank: false, score: Math.round(score * 1000) / 1000, mathRegions };
}

/**
 * Decide whether a page may enter the search index.
 *  indexed  - usable recognised text
 *  held     - text exists but needs a human look first (low confidence / garbled / math-heavy OCR)
 *  rejected - nothing usable (empty, failed, skipped, too little text)
 * A reviewer 'accepted'/'edited' decision always wins over automatic holds.
 */
export function indexDecision(page, policy = DEFAULT_POLICY) {
  const { status, warnings = [], review_state = 'none' } = page;
  if (review_state === 'rejected') return { index_state: 'rejected', reason: 'REVIEW_REJECTED' };
  if (status === 'failed' || status === 'skipped') return { index_state: 'rejected', reason: 'NO_TEXT' };
  if (status === 'empty') return { index_state: 'rejected', reason: 'BLANK_PAGE' };
  if (review_state === 'accepted' || review_state === 'edited') return { index_state: 'indexed', reason: 'REVIEWED' };
  if (status === 'low_text') return { index_state: 'rejected', reason: 'TOO_LITTLE_TEXT' };
  const blockers = policy.holdOnWarnings.filter((w) => warnings.includes(w));
  if (blockers.length) return { index_state: 'held', reason: blockers[0] };
  return { index_state: 'indexed', reason: 'OK' };
}

/** Aggregate page results into a run-level quality summary. */
export function summarizeQuality(pages) {
  const counted = pages.filter((p) => p.status !== 'skipped');
  const usable = counted.filter((p) => p.status === 'ok');
  const confs = usable.map((p) => p.confidence).filter((c) => typeof c === 'number');
  const avg = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
  const failed = counted.filter((p) => p.status === 'failed').length;
  const empty = counted.filter((p) => p.status === 'empty').length;
  const held = pages.filter((p) => p.index_state === 'held').length;
  const total = counted.length;
  let quality = 'unknown';
  if (total > 0) {
    const goodShare = usable.filter((p) => !(p.warnings || []).some((w) => ['GARBLED_TEXT', 'LOW_CONFIDENCE'].includes(w))).length / total;
    quality = goodShare >= 0.85 && failed === 0 ? 'good' : goodShare >= 0.5 ? 'fair' : 'poor';
  }
  return { quality, avg_confidence: avg == null ? null : Math.round(avg * 1000) / 1000, pages_ok: usable.length, pages_empty: empty, pages_failed: failed, pages_held: held, total };
}

export { countWords };
