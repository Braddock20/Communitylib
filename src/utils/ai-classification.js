import { normalizeCode } from './hash.js';

/**
 * Find registry codes in text without matching a code embedded in a longer
 * alphanumeric token. Accept spaces, underscores and hyphens inside codes.
 */
export function detectUnitCodeMentions(text, registry = []) {
  const source = String(text || '');
  const byCode = new Map();

  for (const unit of registry) {
    const normalized = normalizeCode(unit.code || unit.unit_code || unit.normalized_code || '');
    if (!normalized) continue;
    const key = String(unit.id ?? normalized);
    if (!byCode.has(normalized)) {
      byCode.set(normalized, {
        id: unit.id ?? null,
        code: String(unit.code_display || unit.display_code || unit.code || unit.unit_code || normalized),
        title: unit.title || unit.unit_title || null,
        _key: key,
      });
    }
  }

  // Tokenize the source once rather than compiling one regular expression per
  // registry unit. This keeps CPU bounded as the registry grows.
  const found = [];
  const seen = new Set();
  const tokenPattern = /(^|[^A-Z0-9])([A-Z]{2,8}[\s_-]*\d{2,4}[A-Z]?)(?=$|[^A-Z0-9])/gi;
  for (const match of source.matchAll(tokenPattern)) {
    const normalized = normalizeCode(match[2]);
    const unit = byCode.get(normalized);
    if (!unit || seen.has(unit._key)) continue;
    seen.add(unit._key);
    found.push({ id: unit.id, code: unit.code, title: unit.title });
  }
  return found;
}

/** Normalize untrusted AI page-range suggestions without making invalid ranges look valid. */
export function sanitizeSuggestedSegments(segments, registry = [], maxSegments = 50) {
  if (!Array.isArray(segments)) return [];
  const knownCodes = new Set(registry.map((u) => normalizeCode(u.code || u.unit_code || '')).filter(Boolean));

  return segments.slice(0, maxSegments).map((raw, index) => {
    const seg = raw && typeof raw === 'object' ? raw : {};
    const startNum = seg.page_start == null || seg.page_start === '' ? NaN : Number(seg.page_start);
    const endNum = seg.page_end == null || seg.page_end === '' ? NaN : Number(seg.page_end);
    const startValid = Number.isInteger(startNum) && startNum >= 1;
    const endValid = Number.isInteger(endNum) && endNum >= 1;
    const rangeValid = startValid && endValid && endNum >= startNum;
    const code = seg.unit_code ? normalizeCode(seg.unit_code) : '';

    return {
      title: String(seg.title || `Segment ${index + 1}`).slice(0, 200),
      unit_code: code && knownCodes.has(code) ? code : null,
      page_start: rangeValid ? startNum : null,
      page_end: rangeValid ? endNum : null,
      confidence: Number.isFinite(Number(seg.confidence))
        ? Math.max(0, Math.min(1, Number(seg.confidence)))
        : 0.3,
      requires_review: true,
      // A numerically plausible range is not proof that it maps to physical PDF pages.
      // Only the split/validation workflow can establish that against a real PDF.
      boundary_valid: false,
    };
  });
}

/** Validate proposed physical split ranges against the actual PDF page count. */
export function validateSegmentBoundaries(segments, totalPages) {
  const errors = [];
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 50) {
    return ['segments must contain 1-50 page ranges'];
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] || {};
    const label = `Segment ${i + 1}`;
    const start = seg.page_start;
    const end = seg.page_end;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      errors.push(`${label}: page_start and page_end must be integers`);
      continue;
    }
    if (start < 1 || end < 1) {
      errors.push(`${label}: page boundaries must be positive`);
      continue;
    }
    if (start > end) {
      errors.push(`${label}: page_start (${start}) must not exceed page_end (${end})`);
      continue;
    }
    if (Number.isInteger(totalPages) && totalPages > 0 && end > totalPages) {
      errors.push(`${label}: page_end (${end}) exceeds document page count (${totalPages})`);
    }
  }
  const valid = segments
    .map((seg, index) => ({ index, start: seg?.page_start, end: seg?.page_end }))
    .filter((seg) => Number.isInteger(seg.start) && Number.isInteger(seg.end) &&
      seg.start >= 1 && seg.end >= seg.start && (!Number.isInteger(totalPages) || totalPages <= 0 || seg.end <= totalPages))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < valid.length; i++) {
    if (valid[i].start <= valid[i - 1].end) {
      errors.push(`Segments ${valid[i - 1].index + 1} and ${valid[i].index + 1}: page ranges overlap`);
    }
  }
  return errors;
}


const TOPIC_LEXICON = Object.freeze({
  physics: [
    ['Electricity and magnetism', /\b(coulomb|electric field|electric potential|voltage|capacitance|capacitor|current electricity|resistance|ohm.s law|magnetic flux|faraday|lenz law|electromagnetic induction|gauss law)\b/i],
    ['Mechanics', /\b(mechanics|newton.s laws?|kinematics|dynamics|momentum|projectile motion|work and energy|rotational motion|friction)\b/i],
    ['Waves and optics', /\b(wave motion|interference|diffraction|polarization|refraction|reflection|lens|optics|simple harmonic motion)\b/i],
    ['Thermodynamics', /\b(thermodynamics|heat transfer|specific heat|entropy|gas laws|thermal expansion)\b/i],
    ['Modern physics', /\b(photoelectric effect|quantum|radioactivity|nuclear physics|atomic spectra|relativity)\b/i],
  ],
  chemistry: [
    ['Organic chemistry', /\b(alkane|alkene|alkyne|functional group|organic chemistry|stereochemistry|isomerism|nucleophilic|electrophilic|benzene|aromatic compound)\b/i],
    ['Chemical bonding', /\b(ionic bond|covalent bond|molecular geometry|hybridization|bond energy|intermolecular forces)\b/i],
    ['Acids and bases', /\b(ph|buffer solution|acid.base|titration|neutralization|equilibrium constant)\b/i],
    ['Chemical kinetics', /\b(reaction rate|chemical kinetics|activation energy|rate law|catalyst)\b/i],
    ['Electrochemistry', /\b(electrochemistry|electrolysis|galvanic cell|redox|oxidation|reduction potential)\b/i],
  ],
  mathematics: [
    ['Calculus', /\b(derivative|differentiation|integration|integral calculus|limits? of functions|partial derivative)\b/i],
    ['Linear algebra', /\b(matrix|matrices|determinant|eigenvalue|eigenvector|linear transformation)\b/i],
    ['Differential equations', /\b(differential equation|ordinary differential|boundary value problem)\b/i],
    ['Probability and statistics', /\b(probability distribution|standard deviation|hypothesis testing|regression|correlation|random variable)\b/i],
  ],
  computing: [
    ['Programming', /\b(algorithm|pseudocode|programming|variable declaration|function definition|recursion|data structure)\b/i],
    ['Databases', /\b(sql|relational database|normalization|primary key|foreign key|database schema)\b/i],
    ['Computer networks', /\b(tcp\/ip|osi model|routing|network protocol|subnetting|computer networks?)\b/i],
  ],
  engineering: [
    ['Engineering drawing', /\b(orthographic projection|isometric drawing|sectional view|dimensioning|engineering drawing)\b/i],
    ['Materials science', /\b(tensile strength|stress.strain|yield strength|heat treatment|material properties|hardness test)\b/i],
    ['Manufacturing processes', /\b(casting|machining|welding|forming process|manufacturing process|cnc)\b/i],
  ],
});

function phraseInText(phrase, text) {
  const p = String(phrase || '').trim().toLowerCase();
  if (p.length < 5) return false;
  // Permit punctuation/whitespace variation while retaining word boundaries.
  const escaped = p.split(/[^a-z0-9]+/i).filter(Boolean).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\W_]+');
  if (!escaped) return false;
  try { return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text); }
  catch { return false; }
}

/**
 * Deterministic document intelligence. This is evidence ranking, not a claimed
 * probability: explicit registered codes in body text outrank filename hints,
 * and the function returns every supported unit rather than forcing one label.
 */
export function classifyDocumentEvidence({ text = '', filename = '', registry = [] } = {}) {
  const body = String(text || '').slice(0, 250_000);
  const name = String(filename || '').slice(0, 500);
  const combined = `${name}\n${body}`;
  const bodyCodes = detectUnitCodeMentions(body, registry);
  const filenameCodes = detectUnitCodeMentions(name, registry);
  const bodyCodeOrder = new Map(bodyCodes.map((u, i) => [String(u.id ?? normalizeCode(u.code)), i]));
  const scores = new Map();
  const add = (unit, points, evidence) => {
    const key = String(unit.id ?? normalizeCode(unit.code || unit.unit_code || ''));
    if (!key) return;
    const row = scores.get(key) || { id: unit.id ?? null, code: unit.code_display || unit.display_code || unit.code || unit.unit_code, title: unit.title || unit.unit_title || null, score: 0, evidence: [] };
    row.score += points;
    row.evidence.push(evidence);
    scores.set(key, row);
  };

  for (const u of bodyCodes) add(u, 12, 'registered_code_in_body');
  for (const u of filenameCodes) add(u, 5, 'registered_code_in_filename');

  for (const unit of registry) {
    const title = unit.title || unit.unit_title || '';
    if (title && phraseInText(title, body)) add(unit, 9, 'official_title_in_body');
    else if (title && phraseInText(title, name)) add(unit, 4, 'official_title_in_filename');
    const aliases = Array.isArray(unit.aliases) ? unit.aliases : [];
    for (const alias of aliases) {
      if (phraseInText(alias, body)) { add(unit, 4, 'registered_alias_in_body'); break; }
      if (phraseInText(alias, name)) { add(unit, 2, 'registered_alias_in_filename'); break; }
    }
  }

  const ranked = [...scores.values()].map(row => ({ ...row, score: Math.min(30, row.score), evidence: [...new Set(row.evidence)] }))
    .sort((a, b) => {
      const ai = bodyCodeOrder.get(String(a.id ?? normalizeCode(a.code)));
      const bi = bodyCodeOrder.get(String(b.id ?? normalizeCode(b.code)));
      if (ai != null || bi != null) return (ai ?? Number.MAX_SAFE_INTEGER) - (bi ?? Number.MAX_SAFE_INTEGER);
      return b.score - a.score || String(a.code).localeCompare(String(b.code));
    });
  const bodySupported = ranked.filter(row => row.evidence.some(e => e.endsWith('_in_body')));
  const detected = bodySupported.length ? bodySupported : ranked.filter(row => row.evidence.some(e => e.endsWith('_in_filename')));
  const topics = [];
  for (const groups of Object.values(TOPIC_LEXICON)) {
    for (const [label, pattern] of groups) if (pattern.test(body)) topics.push(label);
  }

  const primary = detected[0] || null;
  const second = detected[1] || null;
  const strongCode = Boolean(primary?.evidence.includes('registered_code_in_body'));
  const multiUnit = detected.length > 1;
  // Evidence tier is intentionally categorical; do not expose it as calibrated probability.
  const tier = !primary ? 'none' : multiUnit ? 'multiple' : strongCode ? 'strong' : primary.evidence.includes('official_title_in_body') ? 'strong' : primary.evidence.some(e => e.endsWith('_in_body')) ? 'moderate' : 'weak';
  return {
    detected_units: detected.map(({ id, code, title, score, evidence }) => ({ id, code, title, score, evidence })),
    primary_unit: primary,
    topics: [...new Set(topics)].slice(0, 20),
    multi_unit: multiUnit,
    evidence_tier: tier,
    // Helpful conflict signal: filename suggests a different registered unit from body.
    filename_conflict: Boolean(bodySupported.length && filenameCodes.some(f => !bodySupported.some(b => String(b.id) === String(f.id)))),
    second_unit: second,
    text_chars: body.length,
    body_code_count: bodyCodes.length,
    filename_code_count: filenameCodes.length,
    source: 'deterministic-evidence-v1',
  };
}

/** Conservative document-type detection; specific evidence beats generic words. */
export function inferDocumentType(text = '', filename = '') {
  const source = `${filename}\n${text}`.toLowerCase();
  if (/\b(assignment|coursework|individual task|group project)\b/.test(source)) return 'assignment';
  if (/\b(cat\s*\d*|continuous assessment|class test|quiz|test paper)\b/.test(source)) return 'cat';
  if (/\b(final exam|end.of.semester|supplementary exam|special exam|examination paper|past paper|exam paper)\b/.test(source)) return 'exam';
  if (/\b(notes|lecture|chapter|topic|handout|revision)\b/.test(source)) return 'notes';
  return 'other';
}
