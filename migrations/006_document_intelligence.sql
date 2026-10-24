-- Communitylib v4.3.0 -- document-intelligence migration.
--
-- ADDITIVE and idempotent: safe to re-run. It never drops, renames or rewrites
-- existing data, never touches B2 keys, and does not alter resources.extracted_text.
-- The only change to an existing table's rules is widening the status CHECK on
-- document_processing_jobs (old values stay valid) and adding nullable/defaulted
-- columns, so every existing query and API consumer keeps working.
--
-- BEFORE APPLYING TO PRODUCTION: take a Neon branch/backup, apply to the branch
-- first, run `node scripts/verify-migration.mjs` against it, then apply to main.
-- Rollback: migrations/006_rollback.sql (guarded; see its header).
-- Requires migrations 004 and 005 (document_processing_jobs, ai_audit_log).

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refuse to run if prerequisites are missing instead of failing half-way.
DO $$
BEGIN
  IF to_regclass('public.document_processing_jobs') IS NULL OR to_regclass('public.ai_audit_log') IS NULL THEN
    RAISE EXCEPTION 'Migration 004 (AI library) must be applied before 006.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. File inspection: what a stored file really is (content sniffing result).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_inspections (
  file_id        BIGINT PRIMARY KEY REFERENCES resource_files(id) ON DELETE CASCADE,
  resource_id    BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  detected_kind  TEXT NOT NULL,                 -- pdf, docx, xlsx, pptx, csv, tsv, txt, md, html, jpeg, png, webp, zip, unknown
  detected_mime  TEXT,
  declared_ext   TEXT,
  ext_matches    BOOLEAN NOT NULL DEFAULT true,
  size_bytes     BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256         TEXT,
  page_count     INTEGER CHECK (page_count IS NULL OR page_count >= 0),
  sheet_count    INTEGER CHECK (sheet_count IS NULL OR sheet_count >= 0),
  slide_count    INTEGER CHECK (slide_count IS NULL OR slide_count >= 0),
  encrypted      BOOLEAN NOT NULL DEFAULT false,
  text_layer     TEXT NOT NULL DEFAULT 'unknown' CHECK (text_layer IN ('text','image','mixed','none','unknown')),
  validation     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {ok, errors:[], warnings:[]}
  capabilities   JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {executors:[...], operations:[...]}
  inspected_by   TEXT,
  inspected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_file_inspections_resource ON file_inspections (resource_id);
CREATE INDEX IF NOT EXISTS idx_file_inspections_kind ON file_inspections (detected_kind) WHERE ext_matches = false;

-- ---------------------------------------------------------------------------
-- 2. Processing jobs: extend the existing table rather than adding a second one.
-- ---------------------------------------------------------------------------
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS file_id            BIGINT REFERENCES resource_files(id) ON DELETE CASCADE;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS operation          TEXT;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS executor           TEXT;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS stage              TEXT;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS progress           NUMERIC(5,4) NOT NULL DEFAULT 0;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS pages_total        INTEGER;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS pages_done         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS pages_failed       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS max_attempts       INTEGER NOT NULL DEFAULT 5;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS priority           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS next_attempt_at    TIMESTAMPTZ;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS lease_token_hash   TEXT;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS lease_expires_at   TIMESTAMPTZ;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS leased_by          TEXT;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS heartbeat_at       TIMESTAMPTZ;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS idempotency_key    TEXT;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS request_hash       TEXT;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS dedupe_key         TEXT;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS settings           JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS processor_version  TEXT;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS run_id             BIGINT;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS started_at         TIMESTAMPTZ;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS completed_at       TIMESTAMPTZ;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS dead_lettered_at   TIMESTAMPTZ;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS error_details      JSONB;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS requested_by       TEXT;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS request_id         TEXT;

-- Widen the status CHECK. Old values (succeeded, needs_review) stay valid so
-- legacy rows and any older Worker version keep working during a rolling deploy.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'document_processing_jobs'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%' AND pg_get_constraintdef(oid) ILIKE '%queued%'
  LOOP
    EXECUTE format('ALTER TABLE document_processing_jobs DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE document_processing_jobs ADD CONSTRAINT document_processing_jobs_status_check
    CHECK (status IN ('queued','running','completed','partial','failed','cancelled','retry_wait','succeeded','needs_review'));
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_processing_jobs_executor_check') THEN
    ALTER TABLE document_processing_jobs ADD CONSTRAINT document_processing_jobs_executor_check
      CHECK (executor IS NULL OR executor IN ('browser','worker','external'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_processing_jobs_progress_check') THEN
    ALTER TABLE document_processing_jobs ADD CONSTRAINT document_processing_jobs_progress_check
      CHECK (progress >= 0 AND progress <= 1 AND pages_done >= 0 AND pages_failed >= 0 AND attempts >= 0 AND max_attempts >= 1);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_idempotency_key ON document_processing_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Duplicate-job suppression: only one ACTIVE job per logical request.
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_active_dedupe ON document_processing_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued','running','retry_wait');
CREATE INDEX IF NOT EXISTS idx_jobs_resource_created ON document_processing_jobs (resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_claimable ON document_processing_jobs (executor, priority DESC, created_at)
  WHERE status IN ('queued','retry_wait');
CREATE INDEX IF NOT EXISTS idx_jobs_running_lease ON document_processing_jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_jobs_created_cursor ON document_processing_jobs (created_at DESC, id);

CREATE TABLE IF NOT EXISTS job_attempts (
  id            BIGSERIAL PRIMARY KEY,
  job_id        UUID NOT NULL REFERENCES document_processing_jobs(id) ON DELETE CASCADE,
  attempt_no    INTEGER NOT NULL CHECK (attempt_no >= 1),
  executor      TEXT,
  client        TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  outcome       TEXT CHECK (outcome IS NULL OR outcome IN ('success','partial','failed','timeout','cancelled','lease_expired')),
  error_code    TEXT,
  error_message TEXT,
  duration_ms   INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  metrics       JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (job_id, attempt_no)
);

-- Transactional outbox: the job row and its "please dispatch me" intent commit
-- together; a drainer (cron / queue consumer / waitUntil) delivers it at least once.
CREATE TABLE IF NOT EXISTS job_outbox (
  id            BIGSERIAL PRIMARY KEY,
  job_id        UUID NOT NULL REFERENCES document_processing_jobs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('dispatch_external','enqueue_job')),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,       -- identifiers only, never document content
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dead')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON job_outbox (available_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_job ON job_outbox (job_id);

-- ---------------------------------------------------------------------------
-- 3. Canonical extraction: runs (versioned) and page-level results.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extraction_runs (
  id               BIGSERIAL PRIMARY KEY,
  resource_id      BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  file_id          BIGINT NOT NULL REFERENCES resource_files(id) ON DELETE CASCADE,
  job_id           UUID REFERENCES document_processing_jobs(id) ON DELETE SET NULL,
  source_sha256    TEXT NOT NULL,                      -- hash of the ORIGINAL file at extraction time
  source_size      BIGINT,
  source_kind      TEXT NOT NULL,
  executor         TEXT,
  extractor        TEXT NOT NULL,                      -- e.g. pdfjs-text, tesseract.js, poppler+tesseract, docx-ooxml
  extractor_version TEXT NOT NULL,
  settings         JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings_hash    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','partial','failed','cancelled')),
  is_active        BOOLEAN NOT NULL DEFAULT false,
  page_count       INTEGER CHECK (page_count IS NULL OR page_count >= 0),
  pages_ok         INTEGER NOT NULL DEFAULT 0,
  pages_empty      INTEGER NOT NULL DEFAULT 0,
  pages_failed     INTEGER NOT NULL DEFAULT 0,
  pages_held       INTEGER NOT NULL DEFAULT 0,         -- extracted but held back from search pending review
  avg_confidence   NUMERIC(4,3),
  quality          TEXT NOT NULL DEFAULT 'unknown' CHECK (quality IN ('good','fair','poor','unknown')),
  language         TEXT,
  title            TEXT,
  doc_metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings         JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_code       TEXT,
  error_details    JSONB,
  supersedes_run_id BIGINT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  activated_at     TIMESTAMPTZ,
  activated_by     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_runs_one_active_per_file ON extraction_runs (file_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_runs_resource ON extraction_runs (resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_file ON extraction_runs (file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_job ON extraction_runs (job_id);

ALTER TABLE document_processing_jobs DROP CONSTRAINT IF EXISTS document_processing_jobs_run_id_fkey;
ALTER TABLE document_processing_jobs ADD CONSTRAINT document_processing_jobs_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES extraction_runs(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS extraction_pages (
  run_id          BIGINT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  location_kind   TEXT NOT NULL DEFAULT 'page' CHECK (location_kind IN ('page','sheet','slide','section','image','file')),
  page_number     INTEGER NOT NULL CHECK (page_number >= 1),   -- 1-based position within location_kind
  resource_id     BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  file_id         BIGINT NOT NULL REFERENCES resource_files(id) ON DELETE CASCADE,
  label           TEXT,                                        -- sheet name, slide title, archive member path ...
  status          TEXT NOT NULL CHECK (status IN ('ok','empty','low_text','failed','skipped')),
  method          TEXT NOT NULL,                               -- pdf-text, ocr, docx, xlsx, pptx, csv, html, text, image-ocr ...
  text            TEXT NOT NULL DEFAULT '',                    -- SOURCE text exactly as extracted
  corrected_text  TEXT,                                        -- reviewer correction; never overwrites `text`
  char_count      INTEGER NOT NULL DEFAULT 0,
  word_count      INTEGER NOT NULL DEFAULT 0,
  confidence      NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  blocks          JSONB NOT NULL DEFAULT '[]'::jsonb,          -- headings/paragraphs/lists/tables/equation+figure refs
  warnings        JSONB NOT NULL DEFAULT '[]'::jsonb,
  language        TEXT,
  rotation        SMALLINT,
  width           REAL,
  height          REAL,
  text_sha256     TEXT,
  ocr             JSONB,                                       -- engine, version, dpi, psm, languages, preprocess flags, cache key
  signature       INTEGER[],                                   -- MinHash signature (64 values) for near-duplicate search
  index_state     TEXT NOT NULL DEFAULT 'pending' CHECK (index_state IN ('pending','indexed','held','rejected')),
  review_state    TEXT NOT NULL DEFAULT 'none' CHECK (review_state IN ('none','needs_review','accepted','rejected','edited')),
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,
  error           JSONB,
  is_active       BOOLEAN NOT NULL DEFAULT false,              -- mirrors extraction_runs.is_active (kept in sync on activate/deactivate)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  tsv             TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(corrected_text, text, ''))) STORED,
  PRIMARY KEY (run_id, location_kind, page_number)
);
CREATE INDEX IF NOT EXISTS idx_pages_search ON extraction_pages USING gin (tsv) WHERE is_active AND index_state = 'indexed';
CREATE INDEX IF NOT EXISTS idx_pages_resource_active ON extraction_pages (resource_id, location_kind, page_number) WHERE is_active AND index_state = 'indexed';
CREATE INDEX IF NOT EXISTS idx_pages_file ON extraction_pages (file_id);
CREATE INDEX IF NOT EXISTS idx_pages_review ON extraction_pages (run_id, review_state) WHERE review_state IN ('needs_review');
CREATE INDEX IF NOT EXISTS idx_pages_failed ON extraction_pages (run_id) WHERE status IN ('failed','low_text');
CREATE INDEX IF NOT EXISTS idx_pages_text_hash ON extraction_pages (text_sha256) WHERE text_sha256 IS NOT NULL AND char_count > 0;

CREATE TABLE IF NOT EXISTS page_equations (
  id             BIGSERIAL PRIMARY KEY,
  run_id         BIGINT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  location_kind  TEXT NOT NULL DEFAULT 'page',
  page_number    INTEGER NOT NULL CHECK (page_number >= 1),
  idx            INTEGER NOT NULL CHECK (idx >= 0),
  bbox           JSONB,                                        -- {x,y,w,h} in page-relative 0..1 units
  source_text    TEXT,                                         -- raw OCR text of the region (never replaced)
  latex          TEXT,                                         -- sanitized LaTeX suggestion, if any engine produced one
  latex_valid    BOOLEAN NOT NULL DEFAULT false,
  engine         TEXT,
  confidence     NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  status         TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('unverified','needs_review','verified','rejected')),
  warnings       JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, location_kind, page_number, idx),
  FOREIGN KEY (run_id, location_kind, page_number) REFERENCES extraction_pages(run_id, location_kind, page_number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_equations_status ON page_equations (run_id, status);

-- ---------------------------------------------------------------------------
-- 4. Derived artifacts (thumbnails, exports, ...). Originals are never listed here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS derived_artifacts (
  id            BIGSERIAL PRIMARY KEY,
  resource_id   BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  file_id       BIGINT REFERENCES resource_files(id) ON DELETE CASCADE,
  run_id        BIGINT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('thumbnail','page_image','text_export','markdown_export','segment_pdf','study_export','other')),
  storage_key   TEXT NOT NULL UNIQUE,
  content_type  TEXT NOT NULL,
  size_bytes    BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256        TEXT,
  is_public     BOOLEAN NOT NULL DEFAULT false,               -- true only for thumbnails/page images of visible resources
  retention_until TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (storage_key LIKE 'units/%/derived/%')                -- derived namespace: never collides with originals
);
CREATE INDEX IF NOT EXISTS idx_artifacts_resource ON derived_artifacts (resource_id, kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_retention ON derived_artifacts (retention_until) WHERE retention_until IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Metadata suggestions, decisions and reversible changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metadata_suggestions (
  id            BIGSERIAL PRIMARY KEY,
  resource_id   BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  run_id        BIGINT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','edited','rejected','reverted','superseded')),
  payload       JSONB NOT NULL,                               -- unit/type/year/title/topics/language/topic_ranges ...
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,           -- [{field, page, quote, verified}]
  confidence    NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  provider      TEXT,
  model         TEXT,
  requires_review BOOLEAN NOT NULL DEFAULT true,
  inconsistencies JSONB NOT NULL DEFAULT '[]'::jsonb,         -- possible incorrect existing metadata
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON metadata_suggestions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suggestions_resource ON metadata_suggestions (resource_id, created_at DESC);

CREATE TABLE IF NOT EXISTS metadata_changes (
  id            BIGSERIAL PRIMARY KEY,
  resource_id   BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  suggestion_id BIGINT REFERENCES metadata_suggestions(id) ON DELETE SET NULL,
  actor         TEXT NOT NULL,
  actor_role    TEXT,
  source        TEXT NOT NULL DEFAULT 'apply-metadata' CHECK (source IN ('apply-metadata','suggestion-review','revert')),
  before_state  JSONB NOT NULL,
  after_state   JSONB NOT NULL,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at   TIMESTAMPTZ,
  reverted_by   TEXT,
  revert_of     BIGINT REFERENCES metadata_changes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_resource ON metadata_changes (resource_id, applied_at DESC);

-- ---------------------------------------------------------------------------
-- 6. Duplicate candidates (never auto-merged; decisions are recorded, not enforced).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS duplicate_candidates (
  id            BIGSERIAL PRIMARY KEY,
  resource_a    BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  resource_b    BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('exact_file','exact_text','near_text','metadata','filename')),
  score         NUMERIC(4,3) NOT NULL CHECK (score >= 0 AND score <= 1),
  signals       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed_duplicate','not_duplicate','related','dismissed')),
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (resource_a < resource_b),
  UNIQUE (resource_a, resource_b)
);
CREATE INDEX IF NOT EXISTS idx_dups_status_score ON duplicate_candidates (status, score DESC);
CREATE INDEX IF NOT EXISTS idx_dups_b ON duplicate_candidates (resource_b);

-- ---------------------------------------------------------------------------
-- 7. Search / embedding state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_index_state (
  resource_id      BIGINT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  active_run_id    BIGINT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  pages_indexed    INTEGER NOT NULL DEFAULT 0,
  pages_held       INTEGER NOT NULL DEFAULT 0,
  fts_config       TEXT NOT NULL DEFAULT 'english',
  last_indexed_at  TIMESTAMPTZ,
  embedding_model  TEXT,
  embedding_version TEXT,
  embedded_pages   INTEGER NOT NULL DEFAULT 0,
  stale            BOOLEAN NOT NULL DEFAULT false
);

-- Embeddings are optional. Stored as REAL[] so no extension is required; hybrid
-- ranking re-ranks lexical candidates in the Worker. Neon pgvector can replace
-- this later without changing the API (see docs/ARCHITECTURE.md).
CREATE TABLE IF NOT EXISTS page_embeddings (
  run_id         BIGINT NOT NULL,
  location_kind  TEXT NOT NULL DEFAULT 'page',
  page_number    INTEGER NOT NULL,
  model          TEXT NOT NULL,
  model_version  TEXT NOT NULL DEFAULT '1',
  dim            INTEGER NOT NULL CHECK (dim > 0),
  embedding      REAL[] NOT NULL,
  text_sha256    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, location_kind, page_number, model),
  FOREIGN KEY (run_id, location_kind, page_number) REFERENCES extraction_pages(run_id, location_kind, page_number) ON DELETE CASCADE,
  CHECK (cardinality(embedding) = dim)
);

-- ---------------------------------------------------------------------------
-- 8. Study materials (generated; fully separate from source documents).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_materials (
  id            BIGSERIAL PRIMARY KEY,
  resource_id   BIGINT REFERENCES resources(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('summary','section_summary','explanation','key_terms','definitions','revision_notes',
                  'flashcards','mcq','short_answer','exam','worked_examples','formulas','study_guide','comparison','answer')),
  title         TEXT,
  scope         JSONB NOT NULL DEFAULT '{}'::jsonb,           -- pages / topic / question / resource_ids
  content       JSONB NOT NULL,                               -- validated structured output
  citations     JSONB NOT NULL DEFAULT '[]'::jsonb,           -- only pages that were actually retrieved
  grounding     JSONB NOT NULL DEFAULT '{}'::jsonb,           -- explicit / inferred / uncertain / not_covered counts
  provider      TEXT,
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated','edited','archived')),
  supersedes_id BIGINT REFERENCES study_materials(id) ON DELETE SET NULL,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_study_resource ON study_materials (resource_id, created_at DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 9. Quotas / usage accounting, admin-tunable settings, legacy-text history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_counters (
  day      DATE NOT NULL,
  scope    TEXT NOT NULL,                                      -- ai.neurons, ai.requests, ocr.pages, jobs.created, embed.pages, ...
  subject  TEXT NOT NULL DEFAULT 'global',
  amount   BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0),
  PRIMARY KEY (day, scope, subject)
);

CREATE TABLE IF NOT EXISTS processing_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resource_text_history (
  id               BIGSERIAL PRIMARY KEY,
  resource_id      BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  previous_text    TEXT,
  previous_snippet TEXT,
  replaced_by_run  BIGINT REFERENCES extraction_runs(id) ON DELETE SET NULL,
  actor            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_text_history_resource ON resource_text_history (resource_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 10. Audit trail: reuse ai_audit_log (add attribution columns, keep old rows valid).
-- ---------------------------------------------------------------------------
ALTER TABLE ai_audit_log ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE ai_audit_log ADD COLUMN IF NOT EXISTS actor_role TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_entity ON ai_audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON ai_audit_log (created_at DESC, id DESC);

INSERT INTO schema_migrations(version, name) VALUES ('006', 'document_intelligence')
ON CONFLICT (version) DO NOTHING;

COMMIT;
