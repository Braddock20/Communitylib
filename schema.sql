-- ============================================================
-- University of Eldoret Student Resources - Database Schema
-- Target: Neon (Postgres, serverless)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy / partial text search
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ---------- Faculties & Courses (optional org layer) ----------

CREATE TABLE IF NOT EXISTS faculties (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS courses (
  id          SERIAL PRIMARY KEY,
  faculty_id  INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  UNIQUE (faculty_id, name)
);

-- ---------- Units (e.g. "MAT 201 - Linear Algebra") ----------
-- A unit is the core organizing object. Everything (notes/CATs/exams)
-- hangs off a unit. Units are looked up by code+title.

CREATE TABLE IF NOT EXISTS units (
  id              SERIAL PRIMARY KEY,
  code            TEXT NOT NULL,              -- e.g. "MAT201"  (normalized, no spaces, uppercase)
  code_display    TEXT NOT NULL,               -- e.g. "MAT 201" (as typed by uploader)
  title           TEXT NOT NULL,               -- e.g. "Linear Algebra"
  course_id       INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  year_of_study   SMALLINT,                    -- 1-6, optional
  resource_count  INTEGER NOT NULL DEFAULT 0,  -- denormalized counter, updated on upload
  download_count  INTEGER NOT NULL DEFAULT 0,  -- denormalized counter, updated on download
  search_count    INTEGER NOT NULL DEFAULT 0,  -- how many times this unit surfaced in a search
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, title)
);

CREATE INDEX IF NOT EXISTS idx_units_code_trgm ON units USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_units_title_trgm ON units USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_units_download_count ON units (download_count DESC);
CREATE INDEX IF NOT EXISTS idx_units_search_count ON units (search_count DESC);

-- ---------- Resources ----------
-- One resource = one logical item a student uploaded: a set of notes,
-- one CAT, or one exam. type + year distinguish CATs/exams across years.
-- A resource can have MULTIPLE underlying files (resource_files) -
-- e.g. "Chapter 1-5 notes" uploaded as 5 separate PDFs/images, or a
-- multi-image scan of a CAT that gets combined into one downloadable PDF.

DO $$
BEGIN
  CREATE TYPE resource_type AS ENUM ('notes', 'cat', 'exam', 'assignment', 'other');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS resources (
  id              BIGSERIAL PRIMARY KEY,
  unit_id         INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  type            resource_type NOT NULL,
  academic_year   SMALLINT,                     -- e.g. 2023 (relevant for cat/exam), NULL for notes
  title           TEXT NOT NULL,                 -- e.g. "CAT 1 - Semester 1" or "Full notes: Chapters 1-6"
  uploader_name   TEXT,                          -- optional / can be "Anonymous"
  note            TEXT,                          -- short note left by uploader
  file_count      INTEGER NOT NULL DEFAULT 0,
  primary_ext     TEXT,                          -- pdf / docx / jpg / mixed - for badges in UI
  thumbnail_url   TEXT,                          -- B2 url of generated thumbnail
  combined_pdf_url TEXT,                         -- if multi-image, the generated single-PDF download
  content_hash    TEXT,                          -- hash of the full resource (for duplicate detection)
  download_count  INTEGER NOT NULL DEFAULT 0,
  view_count      INTEGER NOT NULL DEFAULT 0,
  comment_count   INTEGER NOT NULL DEFAULT 0,
  is_flagged      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resources_unit ON resources (unit_id);
CREATE INDEX IF NOT EXISTS idx_resources_type_year ON resources (unit_id, type, academic_year);
CREATE INDEX IF NOT EXISTS idx_resources_download_count ON resources (download_count DESC);
CREATE INDEX IF NOT EXISTS idx_resources_created_at ON resources (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resources_content_hash ON resources (content_hash);
CREATE INDEX IF NOT EXISTS idx_resources_visible_unit_created ON resources (unit_id, created_at DESC) WHERE is_flagged = false;

-- ---------- Resource Files ----------
-- The individual files inside a resource (handles "notes come in chunks").

CREATE TABLE IF NOT EXISTS resource_files (
  id              BIGSERIAL PRIMARY KEY,
  resource_id     BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  order_index     INTEGER NOT NULL DEFAULT 0,   -- preserves upload/chapter order
  file_name       TEXT NOT NULL,                 -- original filename, e.g. "chapter3.pdf"
  file_url        TEXT NOT NULL,                 -- B2 object url/key
  file_ext        TEXT NOT NULL,                 -- pdf, docx, jpg, png...
  file_size_bytes BIGINT,
  file_hash       TEXT NOT NULL,                 -- sha256 of this individual file (dedup at file level)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resource_files_resource ON resource_files (resource_id, order_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_files_hash_unit ON resource_files (file_hash);

-- ---------- Comments ----------

CREATE TABLE IF NOT EXISTS comments (
  id              BIGSERIAL PRIMARY KEY,
  resource_id     BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  author_name     TEXT NOT NULL DEFAULT 'Anonymous',
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comments_resource ON comments (resource_id, created_at DESC);

-- ---------- Search & download logs (fuel the feed-ranking algorithm) ----------

CREATE TABLE IF NOT EXISTS search_logs (
  id          BIGSERIAL PRIMARY KEY,
  query       TEXT NOT NULL,
  unit_id     INTEGER REFERENCES units(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_search_logs_created ON search_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_logs_unit_created ON search_logs (unit_id, created_at DESC);

CREATE TABLE IF NOT EXISTS download_logs (
  id          BIGSERIAL PRIMARY KEY,
  resource_id BIGINT REFERENCES resources(id) ON DELETE CASCADE,
  unit_id     INTEGER REFERENCES units(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_download_logs_created ON download_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_download_logs_unit ON download_logs (unit_id, created_at DESC);

-- ---------- Trigram search helper view (units + latest resource activity) ----------

CREATE OR REPLACE VIEW unit_feed_stats AS
SELECT
  u.id,
  u.code_display,
  u.title,
  u.resource_count,
  u.download_count,
  u.search_count,
  MAX(r.created_at) AS last_activity,
  COUNT(r.id) FILTER (WHERE r.created_at > now() - interval '14 days') AS recent_uploads
FROM units u
LEFT JOIN resources r ON r.unit_id = u.id
GROUP BY u.id;

-- ---------- Defensive constraints ----------
-- These are safe on fresh installs. If an old database contains invalid
-- negative counters, clean those rows before applying the CHECK constraints.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'units_resource_count_nonnegative'
  ) THEN
    ALTER TABLE units ADD CONSTRAINT units_resource_count_nonnegative CHECK (resource_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'units_download_count_nonnegative'
  ) THEN
    ALTER TABLE units ADD CONSTRAINT units_download_count_nonnegative CHECK (download_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'resources_counts_nonnegative'
  ) THEN
    ALTER TABLE resources ADD CONSTRAINT resources_counts_nonnegative
      CHECK (file_count >= 0 AND download_count >= 0 AND view_count >= 0 AND comment_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'resource_files_size_nonnegative'
  ) THEN
    ALTER TABLE resource_files ADD CONSTRAINT resource_files_size_nonnegative
      CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0);
  END IF;
END $$;
