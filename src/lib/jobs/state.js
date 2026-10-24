// Pure job-state logic: states, legal transitions, backoff, failure policy and
// run aggregation. No I/O, so it is trivially unit-testable and shared by the Worker,
// the scheduled recovery task and the external processor.
import { sha256Hex, stableStringify } from '../shared/canonical.js';

export const JOB_STATES = Object.freeze(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'retry_wait']);
/** States written by pre-4.3 Workers; still valid in the database, mapped for display. */
export const LEGACY_STATE_MAP = Object.freeze({ succeeded: 'completed', needs_review: 'partial' });
export const ACTIVE_STATES = Object.freeze(['queued', 'running', 'retry_wait']);
export const TERMINAL_STATES = Object.freeze(['completed', 'partial', 'failed', 'cancelled']);

export function normalizeState(status) { return LEGACY_STATE_MAP[status] || status; }
export function isActive(status) { return ACTIVE_STATES.includes(normalizeState(status)); }
export function isTerminal(status) { return TERMINAL_STATES.includes(normalizeState(status)); }

const TRANSITIONS = {
  queued: ['running', 'cancelled', 'failed'],
  retry_wait: ['queued', 'running', 'cancelled', 'failed'],
  running: ['completed', 'partial', 'failed', 'retry_wait', 'cancelled', 'queued'],
  // Manual retries re-open terminal states explicitly; completed jobs are immutable (re-run = new job).
  failed: ['queued'],
  partial: ['queued'],
  cancelled: ['queued'],
  completed: [],
};

export function canTransition(from, to) {
  const f = normalizeState(from);
  const t = normalizeState(to);
  return Boolean(TRANSITIONS[f]?.includes(t));
}

export class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`illegal job transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.code = 'INVALID_TRANSITION';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half is random, so
 * retries are spread out (no thundering herd) yet never fire immediately.
 * attempt is the number of attempts ALREADY made (1 after the first failure).
 */
export function backoffMs(attempt, { baseMs = 15_000, maxMs = 15 * 60_000, factor = 2, rand = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + rand() * (exp / 2));
}

/**
 * What happens to a job whose attempt just failed?
 *   non-retryable            -> failed (permanent)
 *   retryable, attempts left -> retry_wait with backoff
 *   retryable, none left     -> failed + dead-lettered
 */
export function failureOutcome({ attempts, max_attempts, retryable = true }, opts = {}) {
  if (!retryable) return { status: 'failed', dead_letter: false, delay_ms: null };
  if (attempts >= max_attempts) return { status: 'failed', dead_letter: true, delay_ms: null };
  return { status: 'retry_wait', dead_letter: false, delay_ms: backoffMs(attempts, opts) };
}

export function leaseExpired(job, now = Date.now()) {
  if (normalizeState(job.status) !== 'running') return false;
  const t = job.lease_expires_at ? new Date(job.lease_expires_at).getTime() : 0;
  return !t || t < now;
}

/** Error codes that are never worth retrying (the input is the problem, not the attempt). */
export const PERMANENT_ERROR_CODES = Object.freeze([
  'PASSWORD_PROTECTED', 'CORRUPT_FILE', 'UNSUPPORTED_FORMAT', 'TYPE_MISMATCH', 'FILE_TOO_LARGE',
  'TOO_MANY_PAGES', 'ARCHIVE_UNSAFE', 'NO_TEXT_RECOVERED', 'SOURCE_CHANGED', 'RESOURCE_NOT_FOUND',
]);

/** Human-readable explanation + suggested action for the admin UI and runbook. */
export const ERROR_GUIDE = Object.freeze({
  PASSWORD_PROTECTED: { message: 'The document is password-protected.', action: 'Ask the uploader for an unprotected copy; Communitylib never stores or guesses passwords.' },
  CORRUPT_FILE: { message: 'The file is damaged or not a valid document.', action: 'Re-upload the original. For PDFs, try repairing with qpdf --replace-input.' },
  UNSUPPORTED_FORMAT: { message: 'This file type is not supported for extraction.', action: 'Convert to PDF, DOCX, XLSX, PPTX, CSV, TXT or an image.' },
  TYPE_MISMATCH: { message: 'The file contents do not match its extension.', action: 'Check the file; rename it correctly or re-upload.' },
  FILE_TOO_LARGE: { message: 'The file exceeds the processing size limit for the chosen executor.', action: 'Use the browser executor, split the file, or configure the external processor.' },
  TOO_MANY_PAGES: { message: 'The document has more pages than a single run allows.', action: 'Process page ranges separately.' },
  ARCHIVE_UNSAFE: { message: 'The archive failed safety checks (path traversal, too many/too large entries, or nesting).', action: 'Do not process; inspect the archive manually.' },
  NO_TEXT_RECOVERED: { message: 'No text could be recovered from any page.', action: 'Try the high-quality OCR mode, check the scan quality, or retry specific pages.' },
  SOURCE_CHANGED: { message: 'The original file changed since the job was created.', action: 'Create a new job; existing runs refer to the old hash.' },
  RESOURCE_NOT_FOUND: { message: 'The resource or file no longer exists or was flagged.', action: 'Nothing to do unless the resource is restored.' },
  LEASE_EXPIRED: { message: 'The worker stopped reporting progress (closed tab, crash or timeout).', action: 'The job was re-queued automatically; reopen the processing page or wait for the external processor.' },
  OCR_TIMEOUT: { message: 'OCR for a page took too long.', action: 'Retry the page or use the standard (not high-quality) profile.' },
  PROVIDER_UNAVAILABLE: { message: 'The AI or processor service is unavailable or over quota.', action: 'Wait for the quota reset or check the provider configuration.' },
  PROCESSOR_NOT_CONFIGURED: { message: 'No external processor is configured.', action: 'Use the browser executor or set PROCESSOR_URL and PROCESSOR_TOKEN.' },
  INTERNAL_ERROR: { message: 'Unexpected error.', action: 'Check Workers logs with the job id; retry once.' },
});

/**
 * Decide the final run/job status from the page results.
 *   failed    - no usable text anywhere (NO_TEXT_RECOVERED / ALL_PAGES_FAILED / NO_PAGES)
 *   partial   - some pages failed, were held, were too short, are missing, or most are blank
 *   completed - every expected page produced usable text or is an (expected) blank page
 * Blank pages alone do not make a run partial (cover pages and separators exist),
 * but they are always recorded with a BLANK_PAGE warning and counted.
 */
export function aggregateRun(pages, { expectedPages = null } = {}) {
  const counted = pages.filter((p) => p.status !== 'skipped');
  if (counted.length === 0) return { status: 'failed', code: 'NO_PAGES', warnings: [] };
  const ok = counted.filter((p) => p.status === 'ok').length;
  const failed = counted.filter((p) => p.status === 'failed').length;
  const lowText = counted.filter((p) => p.status === 'low_text').length;
  const empty = counted.filter((p) => p.status === 'empty').length;
  const held = counted.filter((p) => p.index_state === 'held').length;
  const warnings = [];
  if (ok === 0) {
    return { status: 'failed', code: failed === counted.length ? 'ALL_PAGES_FAILED' : 'NO_TEXT_RECOVERED', warnings };
  }
  if (empty > 0) warnings.push('BLANK_PAGES_PRESENT');
  const missing = expectedPages != null ? Math.max(0, expectedPages - counted.length) : 0;
  if (missing > 0) warnings.push('MISSING_PAGES');
  if (empty / counted.length > 0.5) warnings.push('MANY_EMPTY_PAGES');
  const partial = failed > 0 || lowText > 0 || held > 0 || missing > 0 || empty / counted.length > 0.5;
  return { status: partial ? 'partial' : 'completed', code: partial ? (failed ? 'SOME_PAGES_FAILED' : missing ? 'MISSING_PAGES' : 'NEEDS_REVIEW') : null, warnings };
}

export async function dedupeKey({ resource_id, file_id, operation, settings, pages }) {
  return (await sha256Hex(stableStringify({ r: String(resource_id), f: file_id == null ? null : String(file_id), o: operation, s: settings || {}, p: pages || null }))).slice(0, 40);
}

export async function requestHash(body) {
  return (await sha256Hex(stableStringify(body))).slice(0, 40);
}
