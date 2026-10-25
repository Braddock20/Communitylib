/**
 * Stateless MCP (Model Context Protocol) JSON-RPC endpoint helpers.
 * Implements the core Streamable HTTP POST flow (initialize, ping, tools/list,
 * tools/call). It deliberately has no MCP SDK dependency so it can run on
 * Cloudflare Workers without Node-only transports.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

const tool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  },
});
const string = (description, extra = {}) => ({ type: 'string', description, ...extra });
const integer = (description, extra = {}) => ({ type: 'integer', description, ...extra });

export const MCP_TOOLS = [
  tool('library_health', 'Check whether the Worker is responding. This is a liveness check and does not guarantee database/storage readiness.', {}),
  tool('api_capabilities', 'Read the current machine-readable inventory of CommunityLib AI tools and their safety/approval levels.', {}),
  tool('unit_suggest', 'Autocomplete university units by code, title, or alias.', { query: string('Partial unit code or title.') }, ['query']),
  tool('library_search', 'Search public CommunityLib resources by unit code, unit title, topic, or keyword.', {
    query: string('Search query, for example PHY121 or electromagnetic induction.'),
  }, ['query']),
  tool('registry_search', 'Search the verified unit registry and return official codes, titles, aliases, and provenance.', {
    query: string('Optional unit code, title, or alias. Empty string lists registry entries.'),
  }),
  tool('resource_inspect', 'Inspect one public resource and its attached file metadata.', {
    resource_id: integer('Numeric resource ID.', { minimum: 1 }),
  }, ['resource_id']),
  tool('resource_preview', 'Get a resource preview, file types, page-count status, and a short content snippet.', {
    resource_id: integer('Numeric resource ID.', { minimum: 1 }),
  }, ['resource_id']),
  tool('content_search', 'Search extracted document pages for exact phrases or concepts.', {
    query: string('Search query.'),
    unit: string('Optional unit code.'),
    type: string('Optional resource type.'),
    year: string('Optional academic year.'),
    limit: integer('Maximum results (1-50).', { minimum: 1, maximum: 50 }),
  }, ['query']),
  tool('document_analyze', 'Suggest unit, type, academic year, title, topics, and possible segments from document text. Suggestions do not change saved metadata.', {
    filename: string('Original filename.'),
    text: string('Extracted document text. Keep it relevant; the API limits classifier input.'),
  }, ['text']),
  tool('processing_jobs', 'List document-processing jobs. Requires a valid admin bearer token.', {
    status: string('Optional job status filter.'),
  }),
  tool('resource_extract_text', 'Save page text extracted by a trusted client. Requires admin authorization; this does not perform OCR.', {
    resource_id: string('Numeric resource ID.'),
    page_count: integer('Total page count.', { minimum: 1 }),
    pages: { type: 'array', description: 'Ordered page objects.', items: { type: 'object', properties: { page_number: integer('1-based page number.', { minimum: 1 }), text: string('Extracted text for this page.') }, required: ['page_number', 'text'], additionalProperties: false } },
  }, ['resource_id', 'page_count', 'pages']),
  tool('metadata_apply', 'Apply previously reviewed metadata to a resource. Requires admin authorization and explicit tool invocation.', {
    resource_id: string('Numeric resource ID.'),
    suggestion: { type: 'object', description: 'Reviewed metadata suggestion object.' },
  }, ['resource_id', 'suggestion']),
  tool('segment_list', 'List saved segmentation suggestions for a resource. Requires admin authorization.', {
    resource_id: integer('Numeric resource ID.', { minimum: 1 }),
  }, ['resource_id']),
  tool('segment_save', 'Save reviewed page-range suggestions without modifying the original file. Requires admin authorization.', {
    resource_id: string('Numeric resource ID.'),
    segments: { type: 'array', items: { type: 'object' }, description: 'Reviewed segment objects accepted by the API.' },
  }, ['resource_id', 'segments']),
  tool('pdf_split', 'Create derived PDFs for previously reviewed page ranges. Requires admin authorization and enabled processing; source files are preserved.', {
    resource_id: integer('Numeric resource ID.', { minimum: 1 }),
    segments: { type: 'array', items: { type: 'object' }, description: 'Reviewed segment boundaries accepted by the API.' },
  }, ['resource_id', 'segments']),
  tool('publish_segments', 'Publish previously generated segments as separate library resources. Requires admin authorization and explicit review.', {
    resource_id: integer('Numeric source resource ID.', { minimum: 1 }),
  }, ['resource_id']),
  tool('pdf_merge', 'Merge selected compatible PDFs. Requires admin authorization and explicit tool invocation.', {
    resource_ids: { type: 'array', items: integer('Numeric resource ID.', { minimum: 1 }), minItems: 2, maxItems: 10 },
    title: string('Title for the merged PDF.'),
  }, ['resource_ids']),
  tool('study_assistant', 'Generate study help from an existing resource. Requires admin authorization in the current API.', {
    resource_id: string('Numeric resource ID.'),
    action: string('Supported action such as summary, flashcards, quiz, or question answering.'),
    question: string('Optional study question.'),
  }, ['resource_id', 'action']),
];

const TOOL_ROUTES = {
  library_health: () => ({ path: '/health' }),
  api_capabilities: () => ({ path: '/api/ai/tools' }),
  unit_suggest: ({ query }) => ({ path: `/api/search/suggest?q=${encodeURIComponent(query)}` }),
  library_search: ({ query }) => ({ path: `/api/search?q=${encodeURIComponent(query)}` }),
  registry_search: ({ query = '' }) => ({ path: `/api/ai/registry${query ? `?q=${encodeURIComponent(query)}` : ''}` }),
  resource_inspect: ({ resource_id }) => ({ path: `/api/resource/${encodeURIComponent(resource_id)}` }),
  resource_preview: ({ resource_id }) => ({ path: `/api/resource/${encodeURIComponent(resource_id)}/preview` }),
  content_search: ({ query, unit, type, year, limit }) => {
    const p = new URLSearchParams({ q: query });
    if (unit) p.set('unit', unit);
    if (type) p.set('type', type);
    if (year) p.set('year', year);
    if (limit) p.set('limit', String(limit));
    return { path: `/api/search/content?${p}` };
  },
  document_analyze: (args) => ({ path: '/api/ai/analyze', method: 'POST', body: args }),
  processing_jobs: ({ status }) => ({ path: `/api/ai/jobs${status ? `?status=${encodeURIComponent(status)}` : ''}` }),
  resource_extract_text: (args) => ({ path: '/api/ai/extract-text', method: 'POST', body: args }),
  metadata_apply: (args) => ({ path: '/api/ai/apply-metadata', method: 'POST', body: args }),
  segment_list: ({ resource_id }) => ({ path: `/api/ai/segments/${encodeURIComponent(resource_id)}` }),
  segment_save: (args) => ({ path: '/api/ai/segments', method: 'POST', body: args }),
  pdf_split: ({ resource_id, segments }) => ({ path: `/api/ai/split/${encodeURIComponent(resource_id)}`, method: 'POST', body: { segments } }),
  publish_segments: ({ resource_id }) => ({ path: `/api/ai/publish-segments/${encodeURIComponent(resource_id)}`, method: 'POST', body: {} }),
  pdf_merge: (args) => ({ path: '/api/ai/merge', method: 'POST', body: args }),
  study_assistant: (args) => ({ path: '/api/ai/study', method: 'POST', body: args }),
};

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function textResult(data, isError = false) {
  let content;
  try { content = JSON.stringify(data); } catch { content = String(data); }
  if (content.length > 120_000) content = `${content.slice(0, 120_000)}… [output truncated; narrow the query]`;
  return { content: [{ type: 'text', text: content }], ...(isError ? { isError: true } : {}) };
}

/** `dispatch` receives a relative API path and RequestInit and returns Response. */
export async function handleMcpRequest(request, dispatch) {
  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify(jsonRpcError(null, -32700, 'Parse error: expected a JSON-RPC body')), { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }

  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION };
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return new Response(JSON.stringify(jsonRpcError(body?.id, -32600, 'Invalid Request')), { status: 400, headers });
  }

  // Notifications have no id and must not receive a JSON-RPC response.
  if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled') {
    return new Response(null, { status: 202, headers });
  }
  if (body.method === 'ping') return new Response(JSON.stringify(rpcResult(body.id, {})), { status: 200, headers });
  if (body.method === 'initialize') {
    const requested = body.params?.protocolVersion;
    const supported = [MCP_PROTOCOL_VERSION, '2024-11-05'];
    const version = supported.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
    return new Response(JSON.stringify(rpcResult(body.id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'communitylib', title: 'CommunityLib AI Library Manager', version: '4.4.0' },
      instructions: 'Search and inspect public library resources freely. Admin tools require Authorization: Bearer <ADMIN_API_KEY>. Review metadata and segmentation suggestions before applying them. Original files are preserved by default.',
    })), { status: 200, headers: { ...headers, 'MCP-Protocol-Version': version } });
  }
  if (body.method === 'tools/list') return new Response(JSON.stringify(rpcResult(body.id, { tools: MCP_TOOLS })), { status: 200, headers });
  if (body.method !== 'tools/call') return new Response(JSON.stringify(jsonRpcError(body.id, -32601, `Method not found: ${body.method}`)), { status: 200, headers });

  const name = body.params?.name;
  const args = body.params?.arguments ?? {};
  const route = TOOL_ROUTES[name];
  if (!route) return new Response(JSON.stringify(jsonRpcError(body.id, -32602, `Unknown tool: ${String(name || '')}`)), { status: 200, headers });
  if (!args || typeof args !== 'object' || Array.isArray(args)) return new Response(JSON.stringify(jsonRpcError(body.id, -32602, 'Tool arguments must be an object')), { status: 200, headers });

  try {
    const target = route(args);
    const requestHeaders = new Headers({ Accept: 'application/json' });
    const authorization = request.headers.get('authorization');
    const adminKey = request.headers.get('x-admin-key');
    if (authorization) requestHeaders.set('Authorization', authorization);
    else if (adminKey) requestHeaders.set('X-Admin-Key', adminKey);
    if (target.body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    const response = await dispatch(target.path, {
      method: target.method || 'GET', headers: requestHeaders,
      ...(target.body !== undefined ? { body: JSON.stringify(target.body) } : {}),
    });
    const raw = await response.text();
    let result;
    try { result = JSON.parse(raw); } catch { result = { response: raw.slice(0, 120_000) }; }
    return new Response(JSON.stringify(rpcResult(body.id, textResult({ status: response.status, ok: response.ok, data: result }, !response.ok))), { status: 200, headers });
  } catch (error) {
    return new Response(JSON.stringify(rpcResult(body.id, textResult({ error: 'tool_execution_failed', message: error?.message || 'Tool execution failed' }, true))), { status: 200, headers });
  }
}
