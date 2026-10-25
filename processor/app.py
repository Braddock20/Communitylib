"""CommunityLib OCR + archive ingestion engine for Cloudflare Containers.

The Worker owns auth, PostgreSQL, B2, the unit registry and classification rules.
This Linux service performs CPU-heavy extraction and feeds results back through
Worker APIs. ZIP imports fan out into normal CommunityLib resources, so the
existing verified-unit classification and indexing pipeline remains authoritative.
"""
from __future__ import annotations
import asyncio, csv, hashlib, hmac, io, json, logging, os, re, shutil, subprocess, tempfile, time, zipfile
from pathlib import PurePosixPath
from typing import Any
from datetime import datetime, timezone
from xml.etree import ElementTree

import fitz
import httpx
import pytesseract
from PIL import Image, ImageOps, ImageEnhance, ImageFilter
from fastapi import FastAPI, Header, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import JSONResponse

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("communitylib-ocr")
API = os.getenv("COMMUNITYLIB_API_URL", "").rstrip("/")
ADMIN_KEY = os.getenv("ADMIN_API_KEY", "")
SHARED_SECRET = os.getenv("PROCESSOR_SHARED_SECRET", "")
SHARD = os.getenv("PROCESSOR_SHARD", "processor-0")
POLL_SECONDS = max(2, min(60, int(os.getenv("POLL_SECONDS", "5"))))
MAX_PAGES = max(1, min(10000, int(os.getenv("MAX_PAGES_PER_JOB", "1000"))))
CONCURRENCY = max(1, min(4, int(os.getenv("PROCESSOR_CONCURRENCY", "2"))))
MAX_ARCHIVE_ENTRIES = max(1, min(10000, int(os.getenv("MAX_ARCHIVE_ENTRIES", "5000"))))
MAX_ARCHIVE_DEPTH = max(0, min(8, int(os.getenv("MAX_ARCHIVE_DEPTH", "4"))))
MAX_ARCHIVE_UNPACKED_BYTES = max(1, int(os.getenv("MAX_ARCHIVE_UNPACKED_GB", "4"))) * 1024**3
MAX_ARCHIVE_ENTRY_BYTES = max(1, int(os.getenv("MAX_ARCHIVE_ENTRY_MB", "25"))) * 1024**2
MAX_IMPORT_FILES = max(1, min(10000, int(os.getenv("MAX_IMPORT_FILES", "2000"))))
DEFAULT_LANG = os.getenv("OCR_DEFAULT_LANG", "eng+swa")
OCR_FALLBACK_LANGS = [x.strip() for x in os.getenv("OCR_FALLBACK_LANGS", "eng+swa,eng,fra+eng,deu+eng,ara,hin,chi_sim,jpn,rus").split(",") if x.strip()]
app = FastAPI(title="CommunityLib OCR Engine", version="5.0.0")
stop_event = asyncio.Event()
active_jobs = 0
poll_task = None

SUPPORTED_EXTS = {
    "pdf", "png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "gif",
    "txt", "md", "markdown", "csv", "tsv", "html", "htm", "json", "xml", "yaml", "yml", "log", "ini", "rtf",
    "doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "odp", "ods", "epub", "eml",
}
MIME = {
    "pdf": "application/pdf", "txt": "text/plain", "md": "text/markdown", "markdown": "text/markdown",
    "csv": "text/csv", "tsv": "text/tab-separated-values", "html": "text/html", "htm": "text/html",
    "json": "application/json", "xml": "application/xml", "yaml": "text/yaml", "yml": "text/yaml", "log": "text/plain", "ini": "text/plain",
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp", "tif": "image/tiff", "tiff": "image/tiff", "bmp": "image/bmp", "gif": "image/gif",
    "doc": "application/msword", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "ppt": "application/vnd.ms-powerpoint", "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "xls": "application/vnd.ms-excel", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "odt": "application/vnd.oasis.opendocument.text", "ods": "application/vnd.oasis.opendocument.spreadsheet", "odp": "application/vnd.oasis.opendocument.presentation",
    "rtf": "application/rtf", "epub": "application/epub+zip", "eml": "message/rfc822", "msg": "application/octet-stream",
}
OFFICE_EXTS = {"doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "odp", "ods", "rtf"}
TEXT_EXTS = {"txt", "md", "markdown", "csv", "tsv", "html", "htm", "json", "xml", "yaml", "yml", "log", "ini", "eml"}

class ProcessingFault(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message); self.code = code; self.retryable = retryable


def safe_text(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16", "cp1252", "latin-1"):
        try: return data.decode(enc)
        except (UnicodeDecodeError, LookupError): pass
    return data.decode("utf-8", errors="replace")


def clean_html(text: str) -> str:
    text = re.sub(r"(?is)<(script|style|noscript|svg).*?>.*?</\1>", " ", text)
    text = re.sub(r"(?s)<!--.*?-->", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(a, b)
    return re.sub(r"[ \t\r\f\v]+", " ", text).strip()


def preprocess_image(image: Image.Image) -> Image.Image:
    im = ImageOps.exif_transpose(image).convert("RGB")
    # Keep OCR fast: upscale small scans, normalize contrast, avoid expensive filters by default.
    if max(im.size) < 1800:
        scale = min(2.0, 1800 / max(im.size))
        if scale > 1.05:
            im = im.resize((int(im.width * scale), int(im.height * scale)), Image.Resampling.LANCZOS)
    im = ImageOps.grayscale(im)
    im = ImageOps.autocontrast(im)
    return im


def ocr_image(image: Image.Image, settings: dict) -> tuple[str, float | None, str]:
    requested = settings.get("languages")
    if isinstance(requested, list): requested = "+".join(str(x) for x in requested if x)
    lang = str(requested or "").strip()
    psm = max(3, min(13, int(settings.get("psm") or 3)))
    im = preprocess_image(image)
    try:
        if not lang:
            # Tesseract's orientation/script detector gives a useful first guess without
            # forcing every installed language model into every OCR call.
            script_lang = {
                "Latin": DEFAULT_LANG, "Arabic": "ara", "Cyrillic": "rus+eng", "Greek": "ell+eng",
                "Hebrew": "heb", "Han": "chi_sim+eng", "Japanese": "jpn", "Hangul": "kor",
                "Devanagari": "hin+eng", "Bengali": "ben+eng", "Tamil": "tam+eng", "Telugu": "tel+eng",
                "Kannada": "kan+eng", "Malayalam": "mal+eng", "Gujarati": "guj+eng", "Gurmukhi": "pan+eng",
                "Thai": "tha", "Lao": "lao", "Myanmar": "mya", "Sinhala": "sin", "Armenian": "hye",
                "Georgian": "kat", "Ethiopic": "amh", "Khmer": "khm", "Syriac": "syr", "Tibetan": "bod",
            }
            try:
                osd = pytesseract.image_to_osd(im, config="--psm 0")
                match = re.search(r"(?m)^Script:\s*(.+?)\s*$", osd)
                lang = script_lang.get(match.group(1), DEFAULT_LANG) if match else DEFAULT_LANG
            except Exception:
                lang = DEFAULT_LANG
        data = pytesseract.image_to_data(im, lang=lang, config=f"--psm {psm}", output_type=pytesseract.Output.DICT)
        text = pytesseract.image_to_string(im, lang=lang, config=f"--psm {psm}") or ""
        vals = [int(v) for v in data.get("conf", []) if str(v).lstrip("-").isdigit() and int(v) >= 0]
        conf = round(sum(vals) / len(vals) / 100, 3) if vals else None
        # Retry only when nearly no text was recovered; never make every page run every model.
        if len("".join(text.split())) < 20:
            for candidate in OCR_FALLBACK_LANGS:
                if candidate == lang: continue
                try:
                    attempt = pytesseract.image_to_string(im, lang=candidate, config=f"--psm {psm}") or ""
                    if len("".join(attempt.split())) > len("".join(text.split())):
                        text, lang = attempt, candidate
                except pytesseract.TesseractError:
                    continue
        return text, conf, lang
    finally:
        im.close()


def extract_pdf(data: bytes, settings: dict, max_pages: int) -> list[dict]:
    try: doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc: raise ProcessingFault("CORRUPT_FILE", f"Cannot open PDF: {exc}")
    try:
        if doc.is_encrypted: raise ProcessingFault("PASSWORD_PROTECTED", "The PDF is encrypted or password-protected")
        if doc.page_count < 1: raise ProcessingFault("CORRUPT_FILE", "PDF contains no pages")
        if doc.page_count > max_pages: raise ProcessingFault("TOO_MANY_PAGES", f"PDF has {doc.page_count} pages; configured limit is {max_pages}")
        pages = []
        for n in range(doc.page_count):
            page = doc.load_page(n)
            text = page.get_text("text", sort=True) or ""
            method, confidence, lang = "pdf-text", None, None
            compact = "".join(text.split())
            if (len(compact) < 80 or len(text.split()) < 10) and bool(settings.get("ocr", True)):
                dpi = max(100, min(400, int(settings.get("dpi") or 220)))
                pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
                original_text = text
                with Image.open(io.BytesIO(pix.tobytes("png"))) as image:
                    ocr_text, confidence, lang = ocr_image(image, settings)
                if original_text.strip() and ocr_text.strip():
                    a = re.sub(r"\s+", "", original_text).casefold()
                    b = re.sub(r"\s+", "", ocr_text).casefold()
                    text = ocr_text if (a and a in b) or (b and b in a) else original_text.strip() + "\n" + ocr_text.strip()
                else:
                    text = ocr_text or original_text
                method = "tesseract-ocr"
            status = "ok" if len("".join(text.split())) >= 20 else ("empty" if not text.strip() else "low_text")
            pages.append({"page_number": n + 1, "location_kind": "page", "status": status, "method": method,
                          "text": text[:200000], "confidence": confidence, "language": lang,
                          "warnings": ["OCR_LOW_CONFIDENCE"] if confidence is not None and confidence < 0.55 else []})
        return pages
    finally: doc.close()


def office_to_pdf(data: bytes, kind: str, settings: dict, max_pages: int) -> list[dict]:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice: raise ProcessingFault("OFFICE_CONVERTER_MISSING", "LibreOffice converter is not installed", True)
    with tempfile.TemporaryDirectory(prefix="clib-office-") as tmp:
        source = os.path.join(tmp, f"input.{kind}")
        with open(source, "wb") as f: f.write(data)
        try:
            run = subprocess.run([soffice, "-env:UserInstallation=file://" + os.path.join(tmp, "profile"), "--headless", "--convert-to", "pdf", "--outdir", tmp, source],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180, check=False)
        except subprocess.TimeoutExpired: raise ProcessingFault("CONVERSION_TIMEOUT", "Office-to-PDF conversion timed out", True)
        target = os.path.join(tmp, "input.pdf")
        if run.returncode != 0 or not os.path.exists(target):
            raise ProcessingFault("CONVERSION_FAILED", (run.stderr.decode("utf-8", "replace") or run.stdout.decode("utf-8", "replace") or "Office conversion failed")[:250], False)
        with open(target, "rb") as f: pdf = f.read()
        return extract_pdf(pdf, settings, max_pages)


def extract_source(data: bytes, kind: str, settings: dict, max_pages: int) -> list[dict]:
    kind = kind.lower().lstrip(".")
    if kind == "pdf": return extract_pdf(data, settings, max_pages)
    if kind in {"jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp", "gif"}:
        try:
            with Image.open(io.BytesIO(data)) as im:
                text, confidence, lang = ocr_image(im, settings)
            return [{"page_number": 1, "location_kind": "image", "status": "ok" if len("".join(text.split())) >= 20 else ("empty" if not text.strip() else "low_text"),
                     "method": "tesseract-ocr", "text": text[:200000], "confidence": confidence, "language": lang,
                     "warnings": ["OCR_LOW_CONFIDENCE"] if confidence is not None and confidence < 0.55 else []}]
        except ProcessingFault: raise
        except Exception as exc: raise ProcessingFault("CORRUPT_FILE", f"Cannot read image: {exc}")
    if kind in OFFICE_EXTS: return office_to_pdf(data, kind, settings, max_pages)
    if kind == "epub":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                parts = []
                for name in z.namelist():
                    if name.lower().endswith((".xhtml", ".html", ".htm")) and len(parts) < 500:
                        parts.append(clean_html(safe_text(z.read(name))))
                text = "\n\n".join(x for x in parts if x)
        except Exception as exc: raise ProcessingFault("CORRUPT_FILE", f"Cannot read EPUB: {exc}")
    elif kind in TEXT_EXTS:
        text = safe_text(data)
        if kind in {"html", "htm"}: text = clean_html(text)
        elif kind in {"csv", "tsv"}:
            delimiter = "\t" if kind == "tsv" else None
            try:
                sample = text[:4096]
                if delimiter is None: delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
                rows = csv.reader(io.StringIO(text), delimiter=delimiter)
                text = "\n".join(" | ".join(cell.strip() for cell in row) for row in rows)
            except Exception: pass
        elif kind == "rtf": text = re.sub(r"\\'[0-9a-fA-F]{2}|\\[a-zA-Z]+-?\d* ?|[{}]", " ", text)
    elif kind in {"msg"}:
        raise ProcessingFault("UNSUPPORTED_FORMAT", "Outlook .msg requires an optional parser; export it as .eml or PDF")
    else: raise ProcessingFault("UNSUPPORTED_FORMAT", f"Unsupported format: {kind}")
    text = text.replace("\x00", "")
    # Split long text into bounded logical pages so the Worker page payload remains manageable.
    chunks = [text[i:i + 30000] for i in range(0, len(text), 30000)] or [""]
    if len(chunks) > max_pages: raise ProcessingFault("TOO_MANY_PAGES", f"Text content expands to {len(chunks)} chunks; configured limit is {max_pages}")
    return [{"page_number": i + 1, "location_kind": "section", "status": "ok" if len("".join(chunk.split())) >= 20 else ("empty" if not chunk.strip() else "low_text"),
             "method": "text-extraction", "text": chunk, "confidence": None, "language": None, "warnings": []} for i, chunk in enumerate(chunks)]


async def request_json(client: httpx.AsyncClient, method: str, path: str, *, key: str, body: dict | None = None):
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if SHARED_SECRET: headers["X-Processor-Key"] = SHARED_SECRET
    r = await client.request(method, API + path, headers=headers, json=body, timeout=120)
    if r.status_code >= 400: raise RuntimeError(f"API {method} {path} returned {r.status_code}: {r.text[:500]}")
    return r.json() if r.content else {}

async def heartbeat(client: httpx.AsyncClient, job_id: str, lease: str, stage: str):
    return await request_json(client, "POST", f"/api/ai/jobs/{job_id}/heartbeat", key=lease, body={"stage": stage})

async def maintain_lease(client: httpx.AsyncClient, job_id: str, lease: str):
    while not stop_event.is_set():
        await asyncio.sleep(25)
        try:
            await heartbeat(client, job_id, lease, "extracting")
        except Exception as exc:
            log.warning("lease heartbeat stopped job=%s reason=%s", job_id, str(exc)[:160])
            return

async def submit_pages(client: httpx.AsyncClient, job_id: str, lease: str, pages: list[dict], *, page_count: int, done: int, total: int, first: bool):
    body: dict[str, Any] = {"pages": pages, "progress": {"stage": "extracting", "done": done, "total": total}}
    if first: body["run"] = {"page_count": page_count}
    return await request_json(client, "POST", f"/api/ai/jobs/{job_id}/pages", key=lease, body=body)

async def process_job(client: httpx.AsyncClient, row: dict):
    global active_jobs
    job_id = str(row.get("id")); active_jobs += 1
    try:
        claimed = await request_json(client, "POST", f"/api/ai/jobs/{job_id}/claim", key=ADMIN_KEY,
            body={"executor": "external", "client": {"name": f"communitylib-{SHARD}", "executor": "external", "extractor": "pymupdf+tesseract+libreoffice", "version": "5.0.0"}})
        lease = claimed["lease"]["token"]; plan = claimed["plan"]
        try:
            source = await client.get(API + plan["source_url"], headers={"Authorization": f"Bearer {lease}", "X-Processor-Key": SHARED_SECRET}, timeout=180)
            if source.status_code >= 400: raise RuntimeError(f"source fetch failed: HTTP {source.status_code}")
            data = source.content
            expected = (plan.get("file") or {}).get("sha256")
            if expected and hashlib.sha256(data).hexdigest() != expected: raise ProcessingFault("SOURCE_CHANGED", "Source SHA-256 differs from upload record")
            settings = plan.get("settings") or {}
            lease_task = asyncio.create_task(maintain_lease(client, job_id, lease))
            try:
                pages = await asyncio.to_thread(extract_source, data, str((plan.get("file") or {}).get("kind", "")).lower(), settings, MAX_PAGES)
            finally:
                lease_task.cancel()
                try: await lease_task
                except asyncio.CancelledError: pass
            page_count = max((int(p.get("page_number") or 1) for p in pages), default=1)
            wanted = set(plan.get("pages") or [])
            if wanted: pages = [p for p in pages if p["page_number"] in wanted]
            if not pages: raise ProcessingFault("NO_TEXT_RECOVERED", "No pages were available to process")
            total = len(pages)
            first = True
            for start in range(0, total, 5):
                await heartbeat(client, job_id, lease, "extracting")
                batch = pages[start:start + 5]
                await submit_pages(client, job_id, lease, batch, page_count=page_count, done=min(start + len(batch), total), total=total, first=first)
                first = False
            await request_json(client, "POST", f"/api/ai/jobs/{job_id}/complete", key=lease, body={})
            log.info("processed job=%s pages=%s shard=%s", job_id, total, SHARD)
        except ProcessingFault as exc:
            try: await request_json(client, "POST", f"/api/ai/jobs/{job_id}/fail", key=lease, body={"code": exc.code, "message": str(exc)[:250], "retryable": exc.retryable})
            except Exception: log.exception("failed to report processing fault job=%s", job_id)
        except Exception as exc:
            log.exception("processor error job=%s", job_id)
            try: await request_json(client, "POST", f"/api/ai/jobs/{job_id}/fail", key=lease, body={"code": "INTERNAL_ERROR", "message": str(exc)[:250], "retryable": True})
            except Exception: log.exception("failed to report error job=%s", job_id)
    except Exception as exc:
        # Claim can fail because another shard won the race; that's normal.
        log.info("job not claimed or wrapper failed id=%s reason=%s", job_id, str(exc)[:180])
    finally: active_jobs = max(0, active_jobs - 1)


def archive_entries(data: bytes, prefix: str = "", depth: int = 0, budget: dict | None = None):
    """Yield safe, bounded regular files from ZIPs, including nested ZIPs."""
    if budget is None: budget = {"entries": 0, "unpacked": 0, "yielded": 0, "skipped": []}
    if depth > MAX_ARCHIVE_DEPTH: return
    try: zf = zipfile.ZipFile(io.BytesIO(data))
    except Exception as exc: raise ProcessingFault("INVALID_ARCHIVE", f"Invalid ZIP archive: {exc}")
    with zf:
        for info in zf.infolist():
            if info.is_dir(): continue
            budget["entries"] += 1
            if budget["entries"] > MAX_ARCHIVE_ENTRIES: raise ProcessingFault("ARCHIVE_ENTRY_LIMIT", f"ZIP contains more than {MAX_ARCHIVE_ENTRIES} entries")
            raw = info.filename.replace("\\", "/")
            path = PurePosixPath(raw)
            if path.is_absolute() or ".." in path.parts or not path.parts or raw.startswith("/"): continue
            if any(part.startswith(".") or part == "__MACOSX" for part in path.parts): continue
            # Reject symlinks and special files.
            mode = (info.external_attr >> 16) & 0xFFFF
            if mode and (mode & 0o170000) not in (0, 0o100000): continue
            name = f"{prefix}/{raw}".strip("/")
            if info.flag_bits & 0x1:
                budget.setdefault("skipped", []).append({"path": name, "reason": "encrypted_entry"}); continue
            if info.file_size < 0 or info.file_size > MAX_ARCHIVE_ENTRY_BYTES:
                budget.setdefault("skipped", []).append({"path": name, "reason": "entry_exceeds_size_limit"}); continue
            if info.compress_size > 0 and info.file_size / info.compress_size > 1000:
                budget.setdefault("skipped", []).append({"path": name, "reason": "suspicious_compression_ratio"}); continue
            budget["unpacked"] += info.file_size
            if budget["unpacked"] > MAX_ARCHIVE_UNPACKED_BYTES: raise ProcessingFault("ARCHIVE_EXPANSION_LIMIT", "ZIP expanded size exceeds configured safety limit")
            try: payload = zf.read(info)
            except Exception:
                budget.setdefault("skipped", []).append({"path": name, "reason": "cannot_read_entry"}); continue
            if name.lower().endswith(".zip"):
                yield from archive_entries(payload, name, depth + 1, budget)
            elif payload:
                budget["yielded"] += 1
                if budget["yielded"] > MAX_IMPORT_FILES: raise ProcessingFault("ARCHIVE_FILE_LIMIT", f"Archive contains more than {MAX_IMPORT_FILES} files")
                yield name, payload, budget


async def upload_one(client: httpx.AsyncClient, name: str, data: bytes, archive_path: str, import_note: str = ""):
    base = os.path.basename(name)[:240] or "document.bin"
    ext = base.rsplit(".", 1)[-1].lower() if "." in base else ""
    headers = {"Authorization": f"Bearer {ADMIN_KEY}", "X-Processor-Key": SHARED_SECRET}
    form = {
        "type": "other", "title": f"Unclassified - {base.rsplit('.', 1)[0][:170]}",
        "uploader_name": "CommunityLib Auto Import", "note": (f"Automatic import path: {archive_path}" + (f" | Import note: {import_note.strip()}" if import_note.strip() else ""))[:1000],
    }
    files = {"files": (base, data, MIME.get(ext, "application/octet-stream"))}
    response = await client.post(API + "/api/upload", headers=headers, data=form, files=files, timeout=180)
    if response.status_code >= 400:
        return {"path": archive_path, "filename": base, "status": "rejected", "http_status": response.status_code, "reason": response.text[:350]}
    body = response.json()
    return {"path": archive_path, "filename": base, "status": "uploaded", "resource_id": body.get("resource", {}).get("id"),
            "processing": body.get("processing", {}), "unit": body.get("unit", {}).get("code_display") or body.get("unit", {}).get("code")}


async def require_internal(x_processor_key: str | None):
    if not SHARED_SECRET or not x_processor_key or not hmac.compare_digest(x_processor_key, SHARED_SECRET):
        raise HTTPException(status_code=401, detail="processor authentication failed")

@app.get("/health")
def health():
    configured = bool(API and ADMIN_KEY and SHARED_SECRET)
    return {"ok": configured, "service": "communitylib-cloudflare-ocr", "version": "5.0.0", "configured": configured,
            "shard": SHARD, "active_jobs": active_jobs, "formats": len(SUPPORTED_EXTS), "tesseract_languages": (pytesseract.get_languages(config="") if shutil.which("tesseract") else [])}

@app.get("/api/ocr/health")
def api_health(): return health()

@app.get("/api/ocr/v1/health")
def admin_api_health(): return health()

@app.get("/api/ocr/v1/capabilities")
def capabilities():
    return {"service": "CommunityLib OCR Engine", "version": "5.0.0", "formats": sorted(SUPPORTED_EXTS),
            "archive": {"nested_zip": True, "max_depth": MAX_ARCHIVE_DEPTH, "max_entries": MAX_ARCHIVE_ENTRIES,
                        "max_unpacked_gb": MAX_ARCHIVE_UNPACKED_BYTES // 1024**3, "max_entry_mb": MAX_ARCHIVE_ENTRY_BYTES // 1024**2},
            "ocr": {"engine": "Tesseract", "installed_languages": pytesseract.get_languages(config=""), "default_languages": DEFAULT_LANG,
                    "language_override": "pass languages in processing job settings"},
            "notes": ["Cloudflare and account plan limits still apply; no service can provide literally unlimited compute.",
                      "Low-confidence or multi-unit files remain unclassified for safe review."]}

@app.post("/api/ocr/v1/ingest/file")
async def ingest_file(file: UploadFile = File(...), note: str = Form(default=""), x_processor_key: str | None = Header(default=None)):
    await require_internal(x_processor_key)
    name = file.filename or "upload.bin"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in SUPPORTED_EXTS: raise HTTPException(status_code=415, detail=f"unsupported format: {ext or 'unknown'}")
    data = await file.read(MAX_ARCHIVE_ENTRY_BYTES + 1)
    if not data: raise HTTPException(status_code=400, detail="empty file")
    if len(data) > MAX_ARCHIVE_ENTRY_BYTES: raise HTTPException(status_code=413, detail="file exceeds configured per-file limit")
    async with httpx.AsyncClient() as client:
        return await upload_one(client, name, data, name, note)

@app.post("/api/ocr/v1/ingest/archive")
async def ingest_archive(file: UploadFile = File(...), note: str = Form(default=""), x_processor_key: str | None = Header(default=None)):
    await require_internal(x_processor_key)
    name = file.filename or "upload.zip"
    if not name.lower().endswith(".zip"): raise HTTPException(status_code=415, detail="upload a .zip archive")
    # Worker/Cloudflare request limits still cap the compressed upload size.
    max_compressed = int(os.getenv("MAX_ARCHIVE_UPLOAD_MB", "90")) * 1024**2
    data = await file.read(max_compressed + 1)
    if len(data) > max_compressed: raise HTTPException(status_code=413, detail=f"compressed archive exceeds {max_compressed // 1024**2}MB edge-safe limit")
    if not data: raise HTTPException(status_code=400, detail="empty archive")
    uploaded, skipped, errors = [], [], []
    budget = {"entries": 0, "unpacked": 0, "yielded": 0, "skipped": []}
    async with httpx.AsyncClient() as client:
        try:
            batch = []
            async def flush_batch(items):
                results = await asyncio.gather(*(upload_one(client, path, payload, path, note) for path, payload in items), return_exceptions=True)
                for (path, _payload), result in zip(items, results):
                    if isinstance(result, Exception): errors.append({"path": path, "status": "rejected", "reason": str(result)[:300]})
                    elif result["status"] == "uploaded": uploaded.append(result)
                    else: errors.append(result)
            for path, payload, _ in archive_entries(data, name, budget=budget):
                ext = path.rsplit(".", 1)[-1].lower()
                if ext not in SUPPORTED_EXTS:
                    skipped.append({"path": path, "reason": "unsupported_format"}); continue
                batch.append((path, payload))
                if len(batch) >= 4:
                    await flush_batch(batch); batch = []
            if batch: await flush_batch(batch)
            skipped.extend(budget.get("skipped", []))
        except ProcessingFault as exc:
            raise HTTPException(status_code=413 if "LIMIT" in exc.code else 400, detail={"code": exc.code, "message": str(exc), "uploaded_before_error": len(uploaded)})
    return {"ok": not errors, "archive": name, "counts": {"entries_seen": budget["entries"], "files_found": budget["yielded"], "uploaded": len(uploaded), "skipped": len(skipped), "errors": len(errors)},
            "expanded_bytes": budget["unpacked"], "uploaded": uploaded, "skipped": skipped, "errors": errors,
            "message": "Files were added to CommunityLib. Backend OCR, verified-unit classification and search indexing continue asynchronously."}

def retry_due(job: dict) -> bool:
    if job.get("status") != "retry_wait" or not job.get("next_attempt_at"): return True
    try:
        value = str(job["next_attempt_at"]).replace("Z", "+00:00")
        due = datetime.fromisoformat(value)
        if due.tzinfo is None: due = due.replace(tzinfo=timezone.utc)
        return due.timestamp() <= time.time()
    except Exception:
        return True

async def poll_loop():
    if not (API and ADMIN_KEY and SHARED_SECRET):
        log.error("Missing COMMUNITYLIB_API_URL, ADMIN_API_KEY, or PROCESSOR_SHARED_SECRET; worker will not poll")
        return
    semaphore = asyncio.Semaphore(CONCURRENCY)
    async with httpx.AsyncClient() as client:
        while not stop_event.is_set():
            try:
                responses = await asyncio.gather(*[
                    client.get(API + "/api/ai/jobs", headers={"Authorization": f"Bearer {ADMIN_KEY}", "X-Processor-Key": SHARED_SECRET},
                               params={"status": status, "limit": 20}, timeout=30)
                    for status in ("queued", "retry_wait")
                ])
                jobs_by_id = {}
                for response in responses:
                    response.raise_for_status()
                    for job in response.json().get("jobs", []): jobs_by_id[str(job.get("id"))] = job
                jobs = [j for j in jobs_by_id.values() if j.get("executor") == "external" and retry_due(j)]
                async def guarded(job):
                    async with semaphore: await process_job(client, job)
                if jobs:
                    await asyncio.gather(*(guarded(job) for job in jobs), return_exceptions=True)
            except Exception: log.exception("queue polling failed")
            try: await asyncio.wait_for(stop_event.wait(), timeout=POLL_SECONDS)
            except asyncio.TimeoutError: pass

@app.on_event("startup")
async def startup():
    global poll_task
    stop_event.clear()
    poll_task = asyncio.create_task(poll_loop())

@app.on_event("shutdown")
async def shutdown():
    stop_event.set()
    if poll_task:
        try: await asyncio.wait_for(poll_task, timeout=5)
        except Exception: poll_task.cancel()
