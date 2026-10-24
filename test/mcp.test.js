import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest, MCP_PROTOCOL_VERSION, MCP_TOOLS } from '../src/lib/mcp.js';

function request(body, headers = {}) {
  return new Request('https://communitylib.example/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function rpc(body, dispatch, headers = {}) {
  const response = await handleMcpRequest(request(body, headers), dispatch);
  return { response, body: response.status === 202 ? null : await response.json() };
}

test('MCP initialize negotiates a supported protocol and describes the server', async () => {
  const { response, body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } }, async () => { throw new Error('not called'); });
  assert.equal(response.status, 200);
  assert.equal(body.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(body.result.serverInfo.name, 'communitylib');
  assert.ok(body.result.capabilities.tools);
});

test('MCP tools/list publishes a useful tool catalog', async () => {
  const { body } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, async () => { throw new Error('not called'); });
  assert.deepEqual(body.result.tools.map((t) => t.name), MCP_TOOLS.map((t) => t.name));
  assert.ok(body.result.tools.some((t) => t.name === 'library_search'));
  assert.ok(body.result.tools.some((t) => t.name === 'resource_extract_text'));
});

test('read tool calls dispatch to the internal API without needing admin credentials', async () => {
  let captured;
  const { body } = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'library_search', arguments: { query: 'PHY121' } } }, async (path, init) => {
    captured = { path, init };
    return Response.json({ query: 'PHY121', results: [] });
  });
  assert.equal(captured.path, '/api/search?q=PHY121');
  assert.equal(captured.init.method, 'GET');
  assert.equal(body.result.isError, undefined);
  assert.match(body.result.content[0].text, /PHY121/);
});

test('admin tool calls forward bearer credentials and report API authorization errors', async () => {
  let captured;
  const { body } = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'metadata_apply', arguments: { resource_id: '12', suggestion: { unit_code: 'PHY121' } } } }, async (path, init) => {
    captured = { path, init };
    return Response.json({ error: 'admin authorization required' }, { status: 401 });
  }, { Authorization: 'Bearer test-token' });
  assert.equal(captured.path, '/api/ai/apply-metadata');
  assert.equal(captured.init.headers.get('Authorization'), 'Bearer test-token');
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /admin authorization required/);
});

test('MCP rejects malformed requests and unknown tools cleanly', async () => {
  const invalid = await handleMcpRequest(new Request('https://communitylib.example/mcp', { method: 'POST', body: '{' }), async () => Response.json({}));
  assert.equal(invalid.status, 400);
  const { body } = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } }, async () => Response.json({}));
  assert.equal(body.error.code, -32602);
});

test('MCP notifications return HTTP 202 without a JSON-RPC body', async () => {
  const { response, body } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, async () => Response.json({}));
  assert.equal(response.status, 202);
  assert.equal(body, null);
});
