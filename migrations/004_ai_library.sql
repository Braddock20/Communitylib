-- Communitylib v4 AI library intelligence migration.
-- Safe to run after schema.sql. Does not rename/delete existing objects or change B2 keys.
CREATE TABLE IF NOT EXISTS unit_aliases (
  id BIGSERIAL PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(unit_id, normalized_alias)
);
CREATE INDEX IF NOT EXISTS idx_unit_aliases_normalized ON unit_aliases(normalized_alias);
CREATE INDEX IF NOT EXISTS idx_unit_aliases_trgm ON unit_aliases USING gin (normalized_alias gin_trgm_ops);

CREATE TABLE IF NOT EXISTS unit_sources (
  id BIGSERIAL PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_reference TEXT,
  source_date DATE,
  source_type TEXT NOT NULL DEFAULT 'unverified',
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_unit_sources_unit ON unit_sources(unit_id);

ALTER TABLE resources ADD COLUMN IF NOT EXISTS extracted_text TEXT;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS metadata_confidence NUMERIC(4,3);
ALTER TABLE resources ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE resources ADD COLUMN IF NOT EXISTS preview_snippet TEXT;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS original_title TEXT;

ALTER TABLE resource_files ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE resource_files ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE resource_files ADD COLUMN IF NOT EXISTS page_count INTEGER;
ALTER TABLE resource_files ADD COLUMN IF NOT EXISTS thumbnail_key TEXT;
ALTER TABLE resource_files ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'ready';

CREATE TABLE IF NOT EXISTS document_processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id BIGINT REFERENCES resources(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','needs_review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status_created ON document_processing_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS document_segments (
  id BIGSERIAL PRIMARY KEY,
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  segment_index INTEGER NOT NULL,
  unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
  title TEXT,
  page_start INTEGER,
  page_end INTEGER,
  confidence NUMERIC(4,3),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','approved','rejected','generated')),
  source_resource_id BIGINT REFERENCES resources(id) ON DELETE SET NULL,
  generated_file_key TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (page_start IS NULL OR page_start >= 1),
  CHECK (page_end IS NULL OR page_end >= page_start),
  UNIQUE(resource_id, segment_index)
);
CREATE INDEX IF NOT EXISTS idx_document_segments_resource ON document_segments(resource_id, segment_index);

CREATE TABLE IF NOT EXISTS document_relations (
  id BIGSERIAL PRIMARY KEY,
  resource_a BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  resource_b BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('possible_continuation','duplicate_scan','same_document','related')),
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (resource_a <> resource_b),
  UNIQUE(resource_a, resource_b, relation_type)
);

CREATE TABLE IF NOT EXISTS ai_audit_log (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  entity_type TEXT,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
