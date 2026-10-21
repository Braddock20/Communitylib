import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunitylibAgenticTools } from '../frontend/agentic-tools.js';

test('agentic tools client requires an API base and normalizes trailing slash', () => {
  assert.throws(() => new CommunitylibAgenticTools(), /apiBase is required/);
  const client = new CommunitylibAgenticTools({ apiBase: 'https://example.workers.dev/' });
  assert.equal(client.apiBase, 'https://example.workers.dev');
});

test('admin tools fail closed when no admin key was supplied', async () => {
  const client = new CommunitylibAgenticTools({
    apiBase: 'https://example.workers.dev',
    fetchImpl: async () => { throw new Error('fetch should not be called'); },
  });
  await assert.rejects(client.listSegments('1'), /requires an admin key/);
  await assert.rejects(client.extractPdf('1'), /requires an admin key/);
});

test('client propagates structured API errors and uses bearer auth when configured', async () => {
  let captured;
  const client = new CommunitylibAgenticTools({
    apiBase: 'https://example.workers.dev', adminKey: 'test-key',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: false, status: 401, json: async () => ({ error: 'admin authorization required' }) };
    },
  });
  await assert.rejects(client.listSegments('1'), /admin authorization required/);
  assert.equal(captured.url, 'https://example.workers.dev/api/ai/segments/1');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-key');
});
