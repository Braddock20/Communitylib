/*
 * Communitylib document preview web component.
 * Include PDF.js first, then this file. It consumes GET /api/resource/:id/preview.
 * PDF rendering happens in the browser; the API never pretends an unrendered PDF
 * thumbnail exists. The component can be embedded in any future frontend.
 */
class CommunitylibDocumentPreview extends HTMLElement {
  connectedCallback() {
    if (this._started) return;
    this._started = true;
    this.attachShadow({ mode: 'open' });
    this.renderShell();
    this.load().catch((error) => this.showError(error?.message || 'Preview unavailable'));
  }

  renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;color:var(--cl-text,#f3f4f6);font:14px/1.45 system-ui,sans-serif}
        .card{overflow:hidden;border:1px solid var(--cl-border,#30333a);border-radius:16px;background:var(--cl-card,#17191e);max-width:440px}
        .page{height:220px;background:#202329;display:flex;align-items:center;justify-content:center;overflow:hidden}
        canvas{max-width:100%;max-height:220px;object-fit:contain;background:white}
        img{max-width:100%;max-height:220px;object-fit:contain}
        .fallback{padding:24px;color:#b9bec8;text-align:center}
        .meta{padding:13px 15px}.title{font-weight:650;overflow-wrap:anywhere}.kind{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#a9afbb;margin-bottom:5px}
        .snippet{color:#c4c8d0;margin-top:7px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
        .footer{display:flex;gap:8px;align-items:center;color:#939aa7;font-size:12px;margin-top:10px}
        .dot{width:5px;height:5px;border-radius:50%;background:#7b8290}
        .error{padding:20px;color:#c4c8d0}
      </style>
      <article class="card" aria-busy="true">
        <div class="page"><div class="fallback">Preparing document preview…</div></div>
        <div class="meta"><div class="kind">DOCUMENT</div><div class="title">Loading…</div><div class="snippet"></div><div class="footer"></div></div>
      </article>`;
  }

  async load() {
    const id = this.getAttribute('resource-id');
    if (!id || !/^\d+$/.test(id)) throw new Error('A valid resource-id attribute is required.');
    const apiBase = (this.getAttribute('api-base') || '').replace(/\/+$/, '');
    const response = await fetch(`${apiBase}/api/resource/${id}/preview`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(response.status === 404 ? 'Document not found.' : 'Could not load preview.');
    const data = await response.json();
    const root = this.shadowRoot;
    root.querySelector('.title').textContent = data.title || 'Untitled document';
    root.querySelector('.kind').textContent = `${data.type || 'file'}${data.page_count ? ` · ${data.page_count} pages` : ''}`;
    root.querySelector('.snippet').textContent = data.snippet || 'No text snippet available.';
    root.querySelector('.footer').textContent = `${data.file_count || 0} file${data.file_count === 1 ? '' : 's'} · Communitylib`;
    const page = root.querySelector('.page');
    page.replaceChildren();
    const resolvedPreviewUrl = data.preview_url ? new URL(data.preview_url, apiBase || globalThis.location.origin).href : null;
    if (data.preview_kind === 'image' && resolvedPreviewUrl) {
      const img = document.createElement('img');
      img.alt = `Preview of ${data.title || 'document'}`;
      img.src = resolvedPreviewUrl;
      img.onerror = () => this.showFallback('Image preview unavailable');
      page.append(img);
    } else if (data.preview_kind === 'pdf' && resolvedPreviewUrl && globalThis.pdfjsLib) {
      await this.renderPdf(resolvedPreviewUrl, page);
    } else {
      const box = document.createElement('div');
      box.className = 'fallback';
      box.textContent = data.preview_kind === 'pdf'
        ? 'PDF preview renderer is not loaded. Include PDF.js to show the first page.'
        : 'No visual preview is available for this file type.';
      page.append(box);
    }
    root.querySelector('.card').setAttribute('aria-busy', 'false');
  }

  async renderPdf(url, container) {
    const pdfjs = globalThis.pdfjsLib;
    const task = pdfjs.getDocument({ url });
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1.6, 420 / base.width, 220 / base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.setAttribute('aria-label', 'First page preview');
    container.append(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const footer = this.shadowRoot.querySelector('.footer');
    footer.textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'} · Communitylib`;
  }

  showFallback(message) {
    const page = this.shadowRoot.querySelector('.page');
    if (!page) return;
    const box = document.createElement('div');
    box.className = 'fallback';
    box.textContent = message;
    page.replaceChildren(box);
  }

  showError(message) {
    const card = this.shadowRoot?.querySelector('.card');
    if (!card) return;
    card.innerHTML = '';
    const error = document.createElement('div');
    error.className = 'error';
    error.textContent = message;
    card.append(error);
    card.setAttribute('aria-busy', 'false');
  }
}
if (!customElements.get('communitylib-document-preview')) {
  customElements.define('communitylib-document-preview', CommunitylibDocumentPreview);
}
