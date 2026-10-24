import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_STATES, canTransition, assertTransition, InvalidTransitionError, backoffMs, failureOutcome, leaseExpired,
  aggregateRun, dedupeKey, requestHash, normalizeState, isActive, isTerminal, ERROR_GUIDE, PERMANENT_ERROR_CODES,
} from '../src/lib/jobs/state.js';

test('state machine allows the documented transitions and nothing else', () => {
  assert.ok(canTransition('queued', 'running'));
  assert.ok(canTransition('running', 'retry_wait'));
  assert.ok(canTransition('retry_wait', 'running'));
  assert.ok(canTransition('failed', 'queued'));
  assert.ok(canTransition('partial', 'queued'));
  assert.equal(canTransition('completed', 'queued'), false, 'completed jobs are immutable; re-run creates a new job');
  assert.equal(canTransition('completed', 'running'), false);
  assert.equal(canTransition('queued', 'completed'), false, 'a job cannot complete without running');
  assert.equal(canTransition('cancelled', 'running'), false);
  assert.throws(() => assertTransition('completed', 'failed'), InvalidTransitionError);
  for (const s of JOB_STATES) assert.ok(canTransition(s, s) === false, `${s} -> ${s} is not a transition`);
});

test('legacy states map to the new vocabulary', () => {
  assert.equal(normalizeState('succeeded'), 'completed');
  assert.equal(normalizeState('needs_review'), 'partial');
  assert.ok(isTerminal('succeeded'));
  assert.ok(isActive('retry_wait'));
  assert.equal(isActive('failed'), false);
});

test('backoff grows exponentially, is capped, jittered and never immediate', () => {
  const noJitter = (attempt) => backoffMs(attempt, { baseMs: 1000, maxMs: 60_000, rand: () => 1 });
  assert.deepEqual([1, 2, 3, 4].map(noJitter), [1000, 2000, 4000, 8000]);
  assert.equal(noJitter(20), 60_000);
  const lo = backoffMs(3, { baseMs: 1000, maxMs: 60_000, rand: () => 0 });
  assert.equal(lo, 2000, 'equal jitter keeps at least half of the delay');
  const samples = new Set(Array.from({ length: 30 }, () => backoffMs(5)));
  assert.ok(samples.size > 10, 'jitter produces varied delays');
});

test('failure outcome: retry, dead-letter, or permanent failure', () => {
  assert.equal(failureOutcome({ attempts: 1, max_attempts: 5 }).status, 'retry_wait');
  assert.ok(failureOutcome({ attempts: 1, max_attempts: 5 }).delay_ms > 0);
  assert.deepEqual(failureOutcome({ attempts: 5, max_attempts: 5 }), { status: 'failed', dead_letter: true, delay_ms: null });
  assert.deepEqual(failureOutcome({ attempts: 1, max_attempts: 5, retryable: false }), { status: 'failed', dead_letter: false, delay_ms: null });
});

test('leaseExpired only applies to running jobs', () => {
  const now = Date.now();
  assert.equal(leaseExpired({ status: 'running', lease_expires_at: new Date(now - 1000) }, now), true);
  assert.equal(leaseExpired({ status: 'running', lease_expires_at: new Date(now + 60_000) }, now), false);
  assert.equal(leaseExpired({ status: 'running', lease_expires_at: null }, now), true);
  assert.equal(leaseExpired({ status: 'queued', lease_expires_at: new Date(now - 1000) }, now), false);
});

test('aggregateRun: blank pages are recorded, empty extractions are failures, partial is honest', () => {
  const ok = { status: 'ok', index_state: 'indexed' };
  assert.equal(aggregateRun([ok, ok, ok]).status, 'completed');
  // PHY121-like: 35 pages, page 1 blank
  const phy = [{ status: 'empty', index_state: 'rejected' }, ...Array.from({ length: 34 }, () => ok)];
  const r = aggregateRun(phy, { expectedPages: 35 });
  assert.equal(r.status, 'completed');
  assert.ok(r.warnings.includes('BLANK_PAGES_PRESENT'));
  assert.deepEqual(aggregateRun([{ status: 'empty' }, { status: 'empty' }]), { status: 'failed', code: 'NO_TEXT_RECOVERED', warnings: [] });
  assert.equal(aggregateRun([{ status: 'failed' }, { status: 'failed' }]).code, 'ALL_PAGES_FAILED');
  assert.equal(aggregateRun([]).code, 'NO_PAGES');
  assert.equal(aggregateRun([ok, { status: 'failed' }]).status, 'partial');
  assert.equal(aggregateRun([ok, { status: 'ok', index_state: 'held' }]).status, 'partial');
  assert.equal(aggregateRun([ok, ok], { expectedPages: 5 }).code, 'MISSING_PAGES');
  const mostlyBlank = aggregateRun([ok, { status: 'empty' }, { status: 'empty' }]);
  assert.equal(mostlyBlank.status, 'partial');
  assert.ok(mostlyBlank.warnings.includes('MANY_EMPTY_PAGES'));
});

test('dedupe keys are stable for identical requests and differ when anything relevant differs', async () => {
  const base = { resource_id: '1', file_id: '2', operation: 'ocr', settings: { mode: 'standard', languages: ['eng'] }, pages: [1, 2] };
  const k = await dedupeKey(base);
  assert.equal(k, await dedupeKey({ ...base, settings: { languages: ['eng'], mode: 'standard' } }));
  assert.notEqual(k, await dedupeKey({ ...base, pages: [1, 3] }));
  assert.notEqual(k, await dedupeKey({ ...base, settings: { ...base.settings, mode: 'high' } }));
  assert.equal(await requestHash({ a: 1, b: 2 }), await requestHash({ b: 2, a: 1 }));
});

test('every permanent error code has operator guidance', () => {
  for (const code of PERMANENT_ERROR_CODES) assert.ok(ERROR_GUIDE[code]?.action, code);
});
