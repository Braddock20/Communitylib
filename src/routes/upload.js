import { Hono } from 'hono';
import { getDb } from '../db.js';
import { getStorage } from '../storage.js';
import { sha256Hex, combineHashes, normalizeCode, normalizeText } from '../utils/hash.js';
import { imagesToPdf, isImageExt, isPdfConvertibleImageExt } from '../utils/pdf.js';

const upload = new Hono();

const VALID_TYPES = new Set(['notes', 'cat', 'exam', 'assignment', 'other']);
const ALLOWED_EXTS = new Set([
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt',
  'jpg', 'jpeg', 'png', 'webp',
]);

function envInt(env, key, fallback, min, max) {
  const n = Number.parseInt(env?.[key] ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

upload.post('/', async (c) => {
  const env = c.env;

  // Reject obviously oversized requests before parsing multipart data.
  const contentLength = Number(c.req.header('content-length'));
  const maxTotalBytes = envInt(env, 'MAX_TOTAL_UPLOAD_MB', 100, 1, 1024) * 1024 * 1024;
  if (Number.isFinite(contentLength) && contentLength > maxTotalBytes) {
    return c.json({ error: `upload exceeds maximum total size of ${Math.round(maxTotalBytes / 1024 / 1024)}MB` }, 413);
  }

  const sql = getDb(env);
  const storage = getStorage(env);

  let form;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'invalid multipart/form-data upload' }, 400);
  }

  const unitCodeRaw = form.get('unit_code');
  const unitTitleRaw = (form.get('unit_title') || '').toString();
  const unitTitle = unitTitleRaw.trim().replace(/\s+/g, ' ');
  const type = (form.get('type') || 'notes').toString().trim().toLowerCase();
  const academicYearRaw = form.get('academic_year');
  const academicYear = academicYearRaw == null || String(academicYearRaw).trim() === ''
    ? null
    : Number.parseInt(String(academicYearRaw), 10);
  const uploaderName = (form.get('uploader_name') || 'Anonymous').toString().trim().slice(0, 80) || 'Anonymous';
  const note = (form.get('note') || '').toString().trim().slice(0, 1000);
  const resourceTitle = (form.get('title') || '').toString().trim().slice(0, 200);

  if (!unitCodeRaw || !unitTitle) {
    return c.json({ error: 'unit_code and unit_title are required' }, 400);
  }
  if (!VALID_TYPES.has(type)) {
    return c.json({ error: `type must be one of: ${[...VALID_TYPES].join(', ')}` }, 400);
  }
  if ((type === 'cat' || type === 'exam') && (!Number.isInteger(academicYear) || academicYear < 2000 || academicYear > 2100)) {
    return c.json({ error: 'academic_year must be a valid year for cat/exam uploads' }, 400);
  }
  if (academicYear != null && (!Number.isInteger(academicYear) || academicYear < 1900 || academicYear > 2100)) {
    return c.json({ error: 'academic_year must be a valid year' }, 400);
  }

  const files = form.getAll('files').filter((f) => f && typeof f.arrayBuffer === 'function' && typeof f.size === 'number');
  if (files.length === 0) return c.json({ error: 'at least one file is required' }, 400);

  const maxFiles = envInt(env, 'MAX_FILES_PER_UPLOAD', 20, 1, 100);
  const maxSizeBytes = envInt(env, 'MAX_FILE_SIZE_MB', 50, 1, 250) * 1024 * 1024;

  if (files.length > maxFiles) return c.json({ error: `too many files (max ${maxFiles})` }, 400);

  const totalSize = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  if (totalSize > maxTotalBytes) {
    return c.json({ error: `upload exceeds maximum total size of ${Math.round(maxTotalBytes / 1024 / 1024)}MB` }, 413);
  }

  for (const f of files) {
    if (!f.name || f.size <= 0) return c.json({ error: 'empty or unnamed files are not allowed' }, 400);
    if (f.size > maxSizeBytes) return c.json({ error: `${f.name} exceeds the per-file limit` }, 413);

    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return c.json({ error: `${f.name}: unsupported file type` }, 400);
    }
  }

  const code = normalizeCode(unitCodeRaw.toString());
  if (!code || code.length > 40) return c.json({ error: 'invalid unit_code' }, 400);

  // Serialize unit creation for the same logical code/title. The advisory
  // lock is held for the duration of this SQL statement.
  const unitKey = `${code}:${normalizeText(unitTitle)}`;
  const [unitResult] = await sql`
    WITH lock AS (
      SELECT pg_advisory_xact_lock(hashtext(${unitKey}))
    ),
    existing AS (
      SELECT u.* FROM units u, lock
      WHERE u.code = ${code} AND lower(u.title) = ${normalizeText(unitTitle)}
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO units (code, code_display, title)
      SELECT ${code}, ${unitCodeRaw.toString().trim().slice(0, 80)}, ${unitTitle.slice(0, 200)}
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      ON CONFLICT (code, title) DO UPDATE SET code_display = units.code_display
      RETURNING *
    )
    SELECT row_to_json(existing) AS row FROM existing
    UNION ALL
    SELECT row_to_json(inserted) AS row FROM inserted
    LIMIT 1
  `;
  const unit = unitResult?.row;
  if (!unit) throw new Error('could not create or find unit');

  const fileEntries = [];
  for (const f of files) {
    const bytes = await f.arrayBuffer();
    const hash = await sha256Hex(bytes);
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    fileEntries.push({
      name: f.name.slice(0, 255),
      bytes,
      hash,
      ext,
      size: Number(f.size),
      type: f.type || 'application/octet-stream',
    });
  }

  // Catch duplicates inside the same request before touching storage.
  const uniqueHashes = new Set();
  const internalDuplicates = [];
  for (const f of fileEntries) {
    if (uniqueHashes.has(f.hash)) internalDuplicates.push(f.name);
    uniqueHashes.add(f.hash);
  }
  if (internalDuplicates.length) {
    return c.json({
      error: 'duplicate_files',
      message: 'The same file appears more than once in this upload.',
      files: internalDuplicates,
    }, 409);
  }

  const hashes = fileEntries.map((f) => f.hash);
  const existing = await sql`
    SELECT file_hash, resource_id
    FROM resource_files
    WHERE file_hash = ANY(${hashes})
  `;
  if (existing.length > 0) {
    return c.json({
      error: 'duplicate_files',
      message: 'One or more of these files already exist in the system.',
      duplicate_resource_ids: [...new Set(existing.map((e) => e.resource_id))],
    }, 409);
  }

  const contentHash = await combineHashes(hashes);
  const [dupResource] = await sql`
    SELECT id FROM resources
    WHERE content_hash = ${contentHash} AND unit_id = ${unit.id}
    LIMIT 1
  `;
  if (dupResource) {
    return c.json({
      error: 'duplicate_resource',
      message: 'This exact set of files was already uploaded for this unit.',
      resource_id: dupResource.id,
    }, 409);
  }

  const uploadedFiles = [];
  const uploadedKeys = [];

  try {
    // UUID-based keys avoid Date.now() collisions under concurrent uploads.
    for (let i = 0; i < fileEntries.length; i++) {
      const f = fileEntries[i];
      const key = `units/${unit.id}/${type}/${crypto.randomUUID()}-${sanitizeFilename(f.name)}`;
      const { url } = await storage.putObject(key, f.bytes, f.type);
      uploadedKeys.push(key);
      uploadedFiles.push({ ...f, key, url });
    }

    const allImages = uploadedFiles.every((f) => isImageExt(f.ext));
    const canCombineImages = allImages && uploadedFiles.length > 1 &&
      uploadedFiles.every((f) => isPdfConvertibleImageExt(f.ext));

    let combinedPdfUrl = null;
    let combinedPdfKey = null;
    if (canCombineImages) {
      const pdfBytes = await imagesToPdf(uploadedFiles.map((f) => ({ bytes: f.bytes, ext: f.ext })));
      combinedPdfKey = `units/${unit.id}/${type}/${crypto.randomUUID()}-combined.pdf`;
      combinedPdfUrl = (await storage.putObject(combinedPdfKey, pdfBytes, 'application/pdf')).url;
      uploadedKeys.push(combinedPdfKey);
    }

    const primaryExt = allImages ? 'image' : uploadedFiles.length === 1 ? uploadedFiles[0].ext : 'mixed';
    const thumbnailUrl = allImages ? uploadedFiles[0].url : null;

    const finalTitle = resourceTitle ||
      (type === 'cat' ? `CAT - ${academicYear}` :
       type === 'exam' ? `Exam - ${academicYear}` :
       `${capitalize(type)} - ${unit.code_display}`);

    // One DB statement: resource + child files + counters succeed/fail
    // together. JSON is only server-generated data, not executable SQL.
    const fileJson = JSON.stringify(uploadedFiles.map((f, i) => ({
      order_index: i,
      file_name: f.name,
      file_url: f.url,
      file_ext: f.ext,
      file_size_bytes: f.size,
      file_hash: f.hash,
    })));

    try {
      await sql`
        WITH inserted AS (
          INSERT INTO resources
            (unit_id, type, academic_year, title, uploader_name, note, file_count,
             primary_ext, thumbnail_url, combined_pdf_url, content_hash)
          VALUES
            (${unit.id}, ${type}, ${academicYear}, ${finalTitle}, ${uploaderName},
             ${note || null}, ${uploadedFiles.length}, ${primaryExt}, ${thumbnailUrl},
             ${combinedPdfUrl}, ${contentHash})
          RETURNING id
        ),
        inserted_files AS (
          INSERT INTO resource_files
            (resource_id, order_index, file_name, file_url, file_ext, file_size_bytes, file_hash)
          SELECT
            inserted.id, f.order_index, f.file_name, f.file_url, f.file_ext,
            f.file_size_bytes, f.file_hash
          FROM inserted
          CROSS JOIN LATERAL jsonb_to_recordset(${fileJson}::jsonb) AS f(
            order_index integer,
            file_name text,
            file_url text,
            file_ext text,
            file_size_bytes bigint,
            file_hash text
          )
          RETURNING id
        )
        UPDATE units
        SET resource_count = resource_count + 1
        WHERE id = ${unit.id}
      `;
    } catch (err) {
      // Most importantly: don't leave B2 objects behind if DB insertion
      // loses a race on a duplicate hash/content hash.
      await Promise.allSettled(uploadedKeys.map((key) => storage.deleteObject(key)));
      throw err;
    }

    const [resource] = await sql`SELECT * FROM resources WHERE content_hash = ${contentHash} AND unit_id = ${unit.id} LIMIT 1`;
    const savedFiles = await sql`
      SELECT id, order_index, file_name AS name, file_url AS url, file_ext AS ext, file_size_bytes
      FROM resource_files WHERE resource_id = ${resource.id}
      ORDER BY order_index ASC
    `;

    return c.json({ resource: { ...resource, files: savedFiles }, unit }, 201);
  } catch (err) {
    // Covers storage/PDF failures after some objects were already written.
    await Promise.allSettled(uploadedKeys.map((key) => storage.deleteObject(key)));
    throw err;
  }
});

function sanitizeFilename(name) {
  const cleaned = String(name || 'file').normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(-100);
  return cleaned || 'file';
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default upload;
