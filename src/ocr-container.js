import { DurableObject } from 'cloudflare:workers';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cloudflare Container Durable Object. Heavy OCR runs in Linux, never in the Worker CPU budget. */
export class OCRContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.starting = null;
  }

  async fetch(request) {
    const container = this.ctx.container;
    if (!container) return Response.json({ error: 'container_binding_unavailable' }, { status: 503 });
    this.shard = request.headers.get('x-processor-shard') || this.shard || 'processor-0';
    this.starting ??= this.startAndWaitForPort(this.shard).finally(() => { this.starting = null; });
    try {
      await this.starting;
      const incoming = new URL(request.url);
      const target = new URL(`http://container${incoming.pathname}${incoming.search}`);
      const headers = new Headers(request.headers);
      headers.delete('authorization');
      headers.delete('x-admin-key');
      headers.set('x-processor-key', this.env.PROCESSOR_SHARED_SECRET || '');
      const forwarded = new Request(target, { method: request.method, headers, body: ['GET','HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' });
      return await container.getTcpPort(8080).fetch(forwarded);
    } catch (error) {
      console.error('OCR container startup/forward failed', error?.message || String(error));
      return Response.json({ error: 'ocr_container_start_failed', message: 'Container startup failed; retry shortly.' }, { status: 503 });
    }
  }

  async startAndWaitForPort(shard) {
    const container = this.ctx.container;
    if (!container.running) {
      await container.start({
        enableInternet: true,
        env: {
          COMMUNITYLIB_API_URL: this.env.COMMUNITYLIB_API_URL || 'https://communitylib.talesapi.workers.dev',
          ADMIN_API_KEY: this.env.ADMIN_API_KEY || '',
          PROCESSOR_SHARED_SECRET: this.env.PROCESSOR_SHARED_SECRET || '',
          PROCESSOR_SHARD: String(shard || 'processor-0'),
          POLL_SECONDS: this.env.OCR_POLL_SECONDS || '5',
          PROCESSOR_CONCURRENCY: this.env.OCR_PROCESSOR_CONCURRENCY || '2',
          MAX_PAGES_PER_JOB: this.env.OCR_MAX_PAGES_PER_JOB || '1000',
          MAX_ARCHIVE_ENTRIES: this.env.OCR_MAX_ARCHIVE_ENTRIES || '5000',
          MAX_ARCHIVE_DEPTH: this.env.OCR_MAX_ARCHIVE_DEPTH || '4',
          MAX_ARCHIVE_UNPACKED_GB: this.env.OCR_MAX_ARCHIVE_UNPACKED_GB || '4',
          MAX_ARCHIVE_ENTRY_MB: this.env.OCR_MAX_ARCHIVE_ENTRY_MB || '25',
          MAX_ARCHIVE_UPLOAD_MB: this.env.OCR_MAX_ARCHIVE_UPLOAD_MB || '90',
          MAX_IMPORT_FILES: this.env.OCR_MAX_IMPORT_FILES || '2000',
          OCR_DEFAULT_LANG: this.env.OCR_DEFAULT_LANG || 'eng+swa',
        },
      });
    }
    // Keep active jobs alive while avoiding an always-on idle container.
    await container.setInactivityTimeout(120_000);
    const port = container.getTcpPort(8080);
    let lastError;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const response = await port.fetch('http://container/health', { signal: AbortSignal.timeout(1500) });
        if (response.ok) return;
        lastError = new Error(`health returned ${response.status}`);
      } catch (error) { lastError = error; }
      await sleep(250);
    }
    throw new Error('OCR container did not become ready on port 8080', { cause: lastError });
  }
}
