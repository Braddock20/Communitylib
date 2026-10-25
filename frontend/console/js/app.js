import { ApiClient, BrowserProcessor, browserAdapters } from './processor.js';

const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v); }
  for (const k of kids.flat()) e.append(k instanceof Node ? k : document.createTextNode(String(k ?? '')));
  return e;
}
let api = null;
let current = { runId: null };
const running = new Map(); // jobId -> AbortController
let autoQueueEnabled = localStorage.getItem('communitylib.autoRunQueue') !== 'false';
let autoQueueScheduled = false;

const TABS = [['jobs', 'Jobs'], ['new', 'New job'], ['review', 'Review'], ['search', 'Search']];
function show(name) {
  for (const [k] of TABS) $(`#v-${k}`).classList.toggle('hide', k !== name);
  [...$('#tabs').children].forEach((b) => b.classList.toggle('on', b.dataset.t === name));
  if (name === 'jobs') loadJobs();
}
function msg(el, text, cls = '') { el.replaceChildren(h('span', { class: cls }, text)); }
async function guard(el, fn) { try { return await fn(); } catch (e) { msg(el, `${e.code || 'error'}: ${e.message}`, 'bad'); } }

$('#unlock').addEventListener('click', async () => {
  const k = $('#key').value.trim(); $('#key').value = '';
  api = new ApiClient({ adminKey: k });
  try {
    const hl = await api.req('/api/ai/processing/health');
    $('#auth').classList.add('hide'); $('#app').classList.remove('hide');
    $('#who').textContent = `Unlocked · ${Object.entries(hl.jobs_by_status || {}).map(([a, b]) => `${a}:${b}`).join(' ') || 'no jobs yet'}`;
    $('#tabs').replaceChildren(...TABS.map(([t, l]) => h('button', { 'data-t': t, onclick: () => show(t) }, l)));
    buildNew(); buildSearch(); show('jobs');
  } catch (e) { api = null; msg($('#authmsg'), e.status === 401 ? 'Wrong admin key.' : `Could not reach the API: ${e.message}`, 'bad'); }
});

// ------------------------------------------------------------------ jobs
async function loadJobs() {
  const box = $('#v-jobs'); box.replaceChildren(h('div', { class: 'mut' }, 'Loading…'));
  await guard(box, async () => {
    const { jobs } = await api.req('/api/ai/jobs?limit=30');
    const toggle = h('input', { type: 'checkbox', checked: autoQueueEnabled, style: 'width:auto;min-height:0', onchange: (ev) => {
      autoQueueEnabled = ev.target.checked;
      localStorage.setItem('communitylib.autoRunQueue', String(autoQueueEnabled));
      loadJobs();
    } });
    const controls = h('div', { class: 'row' }, h('button', { onclick: loadJobs }, 'Refresh'), h('label', {}, toggle, ' Auto-process queued jobs on this device'));
    const status = h('div', { class: 'mut' }, autoQueueEnabled
      ? 'Queue automation is enabled. Processing runs in this browser while this console stays open; completed runs are not published to search automatically.'
      : 'Queue automation is paused. Use “Process here” on a job to run it manually.');
    box.replaceChildren(controls, status, ...jobs.map(jobCard), jobs.length ? '' : h('p', { class: 'mut' }, 'No jobs yet. Create one in "New job".'));
    const next = jobs.find(j => ['queued', 'retry_wait'].includes(j.state || j.status));
    if (autoQueueEnabled && next && running.size === 0 && !autoQueueScheduled) {
      autoQueueScheduled = true;
      setTimeout(() => {
        autoQueueScheduled = false;
        if (!api || !autoQueueEnabled || running.size > 0) return;
        if (typeof pdfjsLib === 'undefined' || typeof Tesseract === 'undefined') {
          status.textContent = 'Auto-processing paused: PDF.js / Tesseract.js did not load. Check connectivity, then refresh or process manually.';
          return;
        }
        const progress = h('progress', { max: 1, value: 0 });
        const log = h('div', { class: 'mut' });
        const card = h('div', { class: 'card' }, h('strong', {}, `Auto-processing resource ${next.resource_id}`), progress, log);
        box.insertBefore(card, box.children[2] || null);
        runJob(next, progress, log, { disabled: false });
      }, 0);
    }
  });
}
function jobCard(j) {
  const prog = h('progress', { max: 100, value: Math.round(100 * Number(j.progress || 0)) });
  const log = h('div', { class: 'mut' });
  const st = j.state || j.status; const bad = ['failed', 'cancelled'].includes(st);
  const card = h('div', { class: 'card' },
    h('div', { class: 'row' }, h('strong', {}, `Resource ${j.resource_id}`), h('span', { class: `tag ${bad ? 'bad' : st === 'completed' ? 'ok' : ''}` }, st), h('span', { class: 'mut' }, `${j.operation}/${j.mode || ''}`)),
    h('div', { class: 'mut' }, `${j.pages_done ?? 0} pages done${j.error_code ? ` · ${j.error_code}` : ''}`), prog, log,
    h('div', { class: 'row' },
      ['queued', 'retry_wait'].includes(st) ? h('button', { class: 'p', onclick: (ev) => runJob(j, prog, log, ev.target) }, 'Process here') : '',
      st === 'running' && running.has(j.id) ? h('button', { onclick: () => running.get(j.id).abort() }, 'Stop') : '',
      ['queued', 'retry_wait', 'running'].includes(st) ? h('button', { onclick: async () => { await guard(log, () => api.req(`/api/ai/jobs/${j.id}/cancel`, { method: 'POST', body: {} })); loadJobs(); } }, 'Cancel') : '',
      ['failed', 'partial', 'cancelled'].includes(st) ? h('button', { onclick: async () => { await guard(log, () => api.req(`/api/ai/jobs/${j.id}/retry`, { method: 'POST', body: {} })); loadJobs(); } }, 'Retry') : '',
      h('button', { onclick: () => openRuns(j.resource_id) }, 'Review')));
  return card;
}
async function runJob(j, prog, log, btn) {
  if (typeof pdfjsLib === 'undefined' || typeof Tesseract === 'undefined') return msg(log, 'PDF.js / Tesseract.js did not load (offline or blocked CDN).', 'bad');
  btn.disabled = true; const ac = new AbortController(); running.set(j.id, ac);
  const ad = browserAdapters({ pdfjs: pdfjsLib, Tesseract, workerSrc: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js' });
  const proc = new BrowserProcessor({ api, ...ad, batchSize: 4 });
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  try {
    const s = await proc.run(j.id, { signal: ac.signal, onProgress: (p) => { prog.max = p.total || 1; prog.value = p.done; msg(log, `${p.stage} ${p.done}/${p.total}${p.pageNumber ? ` · page ${p.pageNumber} ${p.status}` : ''}`); } });
    msg(log, s.cancelled ? 'Stopped.' : `Done: ${s.pages} pages (${s.ocr_pages} by OCR).`, s.cancelled ? 'warn' : 'ok');
  } catch (e) { msg(log, `${e.code || 'error'}: ${e.message}`, 'bad'); }
  finally { running.delete(j.id); try { await wake?.release(); } catch { /* ignore */ } setTimeout(loadJobs, 1200); }
}

// ------------------------------------------------------------------ new job
function buildNew() {
  const box = $('#v-new'); const out = h('div', { class: 'mut' });
  const rid = h('input', { inputmode: 'numeric', placeholder: 'e.g. 1' });
  const mode = h('select', {}, h('option', { value: 'standard' }, 'Standard (OCR pages without text)'), h('option', { value: 'fast' }, 'Fast (text layer only)'), h('option', { value: 'high' }, 'High (300 dpi, slower)'));
  const lang = h('input', { value: 'eng' });
  const pages = h('input', { placeholder: 'all pages, or e.g. 1-5,9' });
  const act = h('input', { type: 'checkbox', style: 'width:auto;min-height:0' });
  box.replaceChildren(h('div', { class: 'card' },
    h('label', {}, 'Resource ID'), rid, h('label', {}, 'Quality'), mode, h('label', {}, 'Languages (OCR codes, + separated)'), lang, h('label', {}, 'Pages (optional)'), pages,
    h('label', {}, h('span', {}, act, ' Activate for search automatically when complete (the original file is never changed)')),
    h('p', {}, h('button', { class: 'p', onclick: () => guard(out, async () => {
      const body = { resource_id: rid.value.trim(), operation: 'ocr', mode: mode.value, languages: lang.value.split('+').map((s) => s.trim()).filter(Boolean), activate: act.checked };
      if (pages.value.trim()) body.pages = pages.value.trim();
      const r = await api.req('/api/ai/jobs', { method: 'POST', body });
      msg(out, r.deduplicated ? 'An identical job is already active; showing it.' : 'Job created.', 'ok'); show('jobs');
    }) }, 'Create job')), out));
}

// ------------------------------------------------------------------ review
async function openRuns(resourceId) {
  show('review'); const box = $('#v-review'); box.replaceChildren(h('div', { class: 'mut' }, 'Loading…'));
  await guard(box, async () => {
    const { runs } = await api.req(`/api/ai/resources/${resourceId}/runs`);
    box.replaceChildren(h('h3', {}, `Resource ${resourceId} extraction runs`), ...runs.map((r) => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('strong', {}, `Run ${r.id}`), h('span', { class: 'tag' }, r.status), r.is_active ? h('span', { class: 'tag ok' }, 'active in search') : ''),
      h('div', { class: 'mut' }, `${r.page_count ?? '?'} pages · ${r.pages_ok ?? 0} ok · ${r.pages_held ?? 0} held for review · ${r.pages_failed ?? 0} failed`),
      h('div', { class: 'row' }, h('button', { onclick: () => openPages(r.id) }, 'Pages'),
        r.is_active ? h('button', { onclick: async () => { await api.req(`/api/ai/runs/${r.id}/deactivate`, { method: 'POST', body: {} }); openRuns(resourceId); } }, 'Deactivate')
          : h('button', { class: 'p', onclick: async () => { await guard(box, () => api.req(`/api/ai/runs/${r.id}/activate`, { method: 'POST', body: {} })); openRuns(resourceId); } }, 'Activate')))),
      runs.length ? '' : h('p', { class: 'mut' }, 'No runs yet.'));
  });
}
async function openPages(runId, filter = 'needs_review') {
  const box = $('#v-review'); current.runId = runId; box.replaceChildren(h('div', { class: 'mut' }, 'Loading…'));
  await guard(box, async () => {
    const q = filter ? `&review_state=${filter}` : '';
    const { pages } = await api.req(`/api/ai/runs/${runId}/pages?include=text&limit=50${q}`);
    const bar = h('div', { class: 'row' }, h('button', { class: filter ? 'on' : '', onclick: () => openPages(runId, 'needs_review') }, 'Needs review'), h('button', { class: filter ? '' : 'on', onclick: () => openPages(runId, '') }, 'All pages'));
    box.replaceChildren(h('h3', {}, `Run ${runId}`), bar, ...pages.map((p) => pageCard(runId, p)), pages.length ? '' : h('p', { class: 'mut' }, 'Nothing here.'));
  });
}
function pageCard(runId, p) {
  const ta = h('textarea', { rows: 6 }); ta.value = p.text || ''; const st = h('span', { class: 'mut' });
  const act = (action, extra = {}) => async () => { await guard(st, async () => { const r = await api.req(`/api/ai/runs/${runId}/pages/review`, { method: 'POST', body: { actions: [{ page: p.page_number, action, ...extra }] } }); msg(st, r.results[0].ok ? `${action} saved` : r.results[0].reason, r.results[0].ok ? 'ok' : 'bad'); }); };
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('strong', {}, `Page ${p.page_number}`), h('span', { class: 'tag' }, p.status), h('span', { class: 'tag' }, p.index_state), h('span', { class: 'mut' }, p.confidence != null ? `${Math.round(p.confidence * 100)}% conf` : '')),
    h('div', { class: 'mut' }, (p.warnings || []).join(', ')), ta,
    h('div', { class: 'row' }, h('button', { onclick: act('accept') }, 'Accept'), h('button', { onclick: act('reject') }, 'Reject'), h('button', { class: 'p', onclick: () => act('edit', { corrected_text: ta.value })() }, 'Save edit')), st);
}

// ------------------------------------------------------------------ search
function buildSearch() {
  const box = $('#v-search'); const q = h('input', { type: 'search', placeholder: 'Search inside documents…' }); const out = h('div');
  const go = () => guard(out, async () => {
    if (!q.value.trim()) return;
    out.replaceChildren(h('div', { class: 'mut' }, 'Searching…'));
    const r = await api.req(`/api/search/content?q=${encodeURIComponent(q.value.trim())}&limit=30`);
    out.replaceChildren(h('div', { class: 'mut' }, r.note), ...r.results.map((res) => h('div', { class: 'card' },
      h('strong', {}, `${res.unit.code} · ${res.resource_title}`),
      ...res.hits.map((hit) => h('div', {}, h('span', { class: 'tag' }, `p.${hit.page}`), ' ', hit.low_confidence ? h('span', { class: 'tag warn' }, 'low confidence ') : '', snippet(hit.snippet_html))))),
      r.results.length ? '' : h('p', { class: 'mut' }, 'No matches.'));
  });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  box.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'row' }, q, h('button', { class: 'p', onclick: go }, 'Search'))), out);
}
// Server escapes text and only adds <mark>; we still build DOM nodes instead of using innerHTML.
function snippet(html) {
  const span = h('span', {}); const parts = String(html).split(/(<mark>|<\/mark>)/); let inMark = false;
  for (const p of parts) { if (p === '<mark>') inMark = true; else if (p === '</mark>') inMark = false; else if (p) { const t = new DOMParser().parseFromString(p, 'text/html').documentElement.textContent; span.append(inMark ? h('mark', {}, t) : document.createTextNode(t)); } }
  return span;
}
