/**
 * Communitylib Agentic Tools client.
 * Load PDF.js first and set pdfjsLib.GlobalWorkerOptions.workerSrc.
 * The API key is supplied explicitly to the constructor and is never persisted.
 * This client never auto-publishes or physically splits a PDF.
 */
export class CommunitylibAgenticTools {
  constructor({ apiBase, adminKey = '', pdfjs = globalThis.pdfjsLib, fetchImpl = globalThis.fetch } = {}) {
    if (!apiBase) throw new Error('apiBase is required');
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.adminKey = adminKey;
    this.pdfjs = pdfjs;
    this.fetchImpl = fetchImpl;
  }

  headers(json = false) {
    const headers = { Accept: 'application/json' };
    if (json) headers['Content-Type'] = 'application/json';
    if (this.adminKey) headers.Authorization = `Bearer ${this.adminKey}`;
    return headers;
  }

  async request(path, { method = 'GET', body, admin = false } = {}) {
    if (admin && !this.adminKey) throw new Error('This tool requires an admin key supplied to the client.');
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || `Request failed (${response.status})`);
    return data;
  }

  tools() { return this.request('/api/ai/tools'); }
  searchLibrary(query) { return this.request(`/api/search?q=${encodeURIComponent(query)}`); }
  searchRegistry(query = '') { return this.request(`/api/ai/registry${query ? `?q=${encodeURIComponent(query)}` : ''}`); }
  inspectResource(id) { return this.request(`/api/resource/${encodeURIComponent(id)}`); }
  previewResource(id) { return this.request(`/api/resource/${encodeURIComponent(id)}/preview`); }
  listSegments(id) { return this.request(`/api/ai/segments/${encodeURIComponent(id)}`, { admin: true }); }
  saveSegments(resourceId, segments) {
    return this.request('/api/ai/segments', { method: 'POST', body: { resource_id: String(resourceId), segments }, admin: true });
  }
  applyMetadata(resourceId, suggestion) {
    return this.request('/api/ai/apply-metadata', { method: 'POST', body: { resource_id: String(resourceId), suggestion }, admin: true });
  }
  splitPdf(resourceId, segments) {
    return this.request(`/api/ai/split/${encodeURIComponent(resourceId)}`, { method: 'POST', body: { segments }, admin: true });
  }
  publishSegments(resourceId) {
    return this.request(`/api/ai/publish-segments/${encodeURIComponent(resourceId)}`, { method: 'POST', body: {}, admin: true });
  }
  mergePdfs(resourceIds, title) {
    return this.request('/api/ai/merge', { method: 'POST', body: { resource_ids: resourceIds, title }, admin: true });
  }
  jobs(status = '') {
    return this.request(`/api/ai/jobs${status ? `?status=${encodeURIComponent(status)}` : ''}`, { admin: true });
  }
  study(resourceId, action, question = '') {
    return this.request('/api/ai/study', { method: 'POST', body: { resource_id: String(resourceId), action, ...(question ? { question } : {}) }, admin: true });
  }

  /** Extract every PDF page in the browser, then securely persist page text. */
  async extractPdf(resourceId) {
    if (!this.adminKey) throw new Error('PDF extraction requires an admin key.');
    if (!this.pdfjs || typeof this.pdfjs.getDocument !== 'function') {
      throw new Error('PDF.js is not loaded. Load pdf.min.mjs/pdf.min.js and configure its worker first.');
    }
    const preview = await this.previewResource(resourceId);
    if (preview.preview_kind !== 'pdf' || !preview.preview_url) throw new Error('This resource does not expose a PDF preview URL.');
    const url = new URL(preview.preview_url, `${this.apiBase}/`).href;
    const task = this.pdfjs.getDocument({ url, withCredentials: false });
    const pdf = await task.promise;
    const pages = [];
    let totalChars = 0;
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.map((item) => typeof item.str === 'string' ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
        totalChars += text.length;
        if (totalChars > 700000) throw new Error('This PDF contains over 700,000 characters of extracted text. Use smaller batches or a dedicated OCR/processing service.');
        pages.push({ page_number: pageNumber, text: text.slice(0, 12000) });
        page.cleanup?.();
      }
      const saved = await this.request('/api/ai/extract-text', {
        method: 'POST', body: { resource_id: String(resourceId), page_count: pdf.numPages, pages }, admin: true,
      });
      return { ...saved, pages_extracted: pages.length, empty_pages: pages.filter((p) => !p.text).map((p) => p.page_number), note: 'Text extraction does not perform OCR on image-only scanned pages.' };
    } finally {
      await pdf.destroy?.();
    }
  }

  /**
   * Run the safe first-stage pipeline: inspect -> extract if needed -> classify.
   * It returns suggestions only. Metadata application and PDF splitting are
   * separate explicit calls so a model cannot silently mutate/publish content.
   */
  async analyzeResource(resourceId) {
    const resourceData = await this.inspectResource(resourceId);
    const resource = resourceData.resource;
    if (!resource) throw new Error('Resource response did not contain resource metadata.');
    let text = String(resource.extracted_text || '');
    let extraction = null;
    if (!text.trim()) {
      extraction = await this.extractPdf(resourceId);
      const refreshed = await this.inspectResource(resourceId);
      text = String(refreshed.resource?.extracted_text || '');
    }
    if (!text.trim()) throw new Error('No extractable text was found. Scanned/image-only PDFs require OCR.');
    const analysis = await this.request('/api/ai/analyze', {
      method: 'POST', body: { filename: resource.title || `resource-${resourceId}.pdf`, text: text.slice(0, 24000) },
    });
    return {
      resource_id: String(resourceId), extraction,
      analysis: analysis.suggestions || analysis,
      requires_human_review: true,
      safe_next_actions: ['Review unit and title', 'Review page boundaries', 'Call applyMetadata only after confirming metadata', 'Call saveSegments only after confirming page ranges'],
      warning: text.length > 24000 ? 'Classifier input was limited to the first 24,000 characters. Review later pages separately before relying on segmentation.' : 'Classifier suggestions are not automatically applied.',
    };
  }
}

export default CommunitylibAgenticTools;
