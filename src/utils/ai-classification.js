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

export function classifyDocumentEvidence({ text = '', filename = '', registry = [] }) {
  const haystack = `${filename || ''}\n${text || ''}`;
  const registryUnits = Array.isArray(registry) ? registry.filter((unit) => unit && (unit.title || unit.unit_title || unit.code || unit.unit_code)) : [];
  const detectedByCode = detectUnitCodeMentions(haystack, registryUnits);
  const detected = [...detectedByCode];
  const seen = new Set(detected.map((unit) => String(unit.id ?? normalizeCode(unit.code))));

  for (const unit of registryUnits) {
    const key = String(unit.id ?? normalizeCode(unit.code || unit.unit_code || ''));
    if (!key) continue;

    const titleCandidates = [unit.title || unit.unit_title || '', ...(Array.isArray(unit.aliases) ? unit.aliases : [])]
      .filter((value) => typeof value === 'string' && value.trim().length >= 5)
      .map((value) => value.trim());

    const match = titleCandidates.some((candidate) => haystack.toLowerCase().includes(candidate.toLowerCase()));
    if (match && !seen.has(key)) {
      seen.add(key);
      detected.push({
        id: unit.id ?? null,
        code: unit.code_display || unit.display_code || unit.code || unit.unit_code || '',
        title: unit.title || unit.unit_title || null,
      });
    }
  }

  const isMultiUnit = detected.length > 1;
  const primary = detected[0] || null;
  const normalizedPrimaryCode = primary ? normalizeCode(primary.code || '') : '';
  const codeCandidate = normalizeCode((haystack.match(/\b[A-Z]{2,8}[\s_-]*\d{2,4}[A-Z]?\b/i)?.[0] || ''));
  const unverifiedCandidate = codeCandidate && (!normalizedPrimaryCode || codeCandidate !== normalizedPrimaryCode) ? codeCandidate : null;
  const type = /\b(cat|continuous assessment|test)\b/i.test(haystack) ? 'cat'
    : /\b(supplementary|special|end.of.semester|final exam|examination|exam)\b/i.test(haystack) ? 'exam'
    : /\b(assignment|coursework)\b/i.test(haystack) ? 'assignment' : 'notes';
  const yearMatch = haystack.match(/\b(20(?:0\d|1\d|2[0-9]))\b/);
  const confidence = primary ? (isMultiUnit ? 0.58 : 0.74) : (codeCandidate ? 0.18 : 0.06);

  return {
    unit_id: primary?.id ?? null,
    unit_code: primary?.code ?? null,
    unit_title: primary?.title ?? null,
    unit_code_verified: Boolean(primary),
    unverified_code_candidate: unverifiedCandidate,
    type,
    academic_year: yearMatch ? Number(yearMatch[1]) : null,
    display_title: filename ? filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() : (primary?.title || 'Untitled document'),
    topics: [],
    confidence,
    reason: isMultiUnit
      ? `Document appears to contain multiple registry units: ${detected.map((unit) => unit.code).join(', ')}. Manual review required.`
      : primary
        ? 'Matched the filename/text to a verified registry unit using deterministic evidence.'
        : 'No verified registry match was found; human review is required.',
    requires_review: !primary || isMultiUnit || Boolean(unverifiedCandidate),
    detected_units: detected,
    is_multi_unit_document: isMultiUnit,
    provider: 'evidence-classifier',
  };
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
      boundary_valid: rangeValid,
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
