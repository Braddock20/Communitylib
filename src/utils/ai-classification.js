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
