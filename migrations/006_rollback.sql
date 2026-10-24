-- Communitylib v4.3.0 -- ROLLBACK of migration 006.  DESTRUCTIVE for derived data.
--
-- What it removes: every table created by 006 (extraction runs/pages, equations,
-- derived-artifact rows, suggestions, duplicate candidates, embeddings, study
-- materials, usage counters, settings, job attempts/outbox, file inspections)
-- and the columns 006 added to document_processing_jobs / ai_audit_log.
--
-- What it NEVER touches: resources, resource_files, units, original files in B2,
-- resources.extracted_text, comments, search/download logs, document_segments,
-- document_relations, or the job rows themselves (their states are mapped back to
-- the pre-006 vocabulary).
--
-- It does not delete B2 objects. Derived objects referenced by derived_artifacts
-- (keys under units/<id>/derived/...) become orphans; list them first with
--   SELECT storage_key FROM derived_artifacts WHERE deleted_at IS NULL;
-- and delete them from B2 separately if wanted.
--
-- Guard: it will not run unless you opt in IN THE SAME SESSION first:
--   SET communitylib.confirm_rollback = 'yes';
-- Take a Neon branch/backup first. Deploy the previous Worker version BEFORE or
-- right after this script; Worker 4.3.0 expects these tables.

BEGIN;

DO $$
BEGIN
  IF current_setting('communitylib.confirm_rollback', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Refusing to roll back 006: run  SET communitylib.confirm_rollback = ''yes'';  in this session first.';
  END IF;
END $$;

DROP TABLE IF EXISTS page_embeddings CASCADE;
DROP TABLE IF EXISTS page_equations CASCADE;
DROP TABLE IF EXISTS search_index_state CASCADE;
DROP TABLE IF EXISTS study_materials CASCADE;
DROP TABLE IF EXISTS metadata_changes CASCADE;
DROP TABLE IF EXISTS metadata_suggestions CASCADE;
DROP TABLE IF EXISTS duplicate_candidates CASCADE;
DROP TABLE IF EXISTS derived_artifacts CASCADE;
DROP TABLE IF EXISTS resource_text_history CASCADE;
DROP TABLE IF EXISTS job_outbox CASCADE;
DROP TABLE IF EXISTS job_attempts CASCADE;
DROP TABLE IF EXISTS extraction_pages CASCADE;
ALTER TABLE document_processing_jobs DROP CONSTRAINT IF EXISTS document_processing_jobs_run_id_fkey;
DROP TABLE IF EXISTS extraction_runs CASCADE;
DROP TABLE IF EXISTS file_inspections CASCADE;
DROP TABLE IF EXISTS usage_counters CASCADE;
DROP TABLE IF EXISTS processing_settings CASCADE;

-- Map job states back to the pre-006 vocabulary, then restore the old CHECK.
UPDATE document_processing_jobs SET status = 'succeeded'    WHERE status = 'completed';
UPDATE document_processing_jobs SET status = 'needs_review' WHERE status = 'partial';
UPDATE document_processing_jobs SET status = 'queued'       WHERE status = 'retry_wait';
UPDATE document_processing_jobs SET status = 'failed'       WHERE status = 'cancelled';

DROP INDEX IF EXISTS uq_jobs_idempotency_key;
DROP INDEX IF EXISTS uq_jobs_active_dedupe;
DROP INDEX IF EXISTS idx_jobs_resource_created;
DROP INDEX IF EXISTS idx_jobs_claimable;
DROP INDEX IF EXISTS idx_jobs_running_lease;
DROP INDEX IF EXISTS idx_jobs_created_cursor;

ALTER TABLE document_processing_jobs DROP CONSTRAINT IF EXISTS document_processing_jobs_status_check;
ALTER TABLE document_processing_jobs DROP CONSTRAINT IF EXISTS document_processing_jobs_executor_check;
ALTER TABLE document_processing_jobs DROP CONSTRAINT IF EXISTS document_processing_jobs_progress_check;
ALTER TABLE document_processing_jobs ADD CONSTRAINT document_processing_jobs_status_check
  CHECK (status IN ('queued','running','succeeded','failed','needs_review'));

ALTER TABLE document_processing_jobs
  DROP COLUMN IF EXISTS file_id, DROP COLUMN IF EXISTS operation, DROP COLUMN IF EXISTS executor,
  DROP COLUMN IF EXISTS stage, DROP COLUMN IF EXISTS progress, DROP COLUMN IF EXISTS pages_total,
  DROP COLUMN IF EXISTS pages_done, DROP COLUMN IF EXISTS pages_failed, DROP COLUMN IF EXISTS max_attempts,
  DROP COLUMN IF EXISTS priority, DROP COLUMN IF EXISTS next_attempt_at, DROP COLUMN IF EXISTS lease_token_hash,
  DROP COLUMN IF EXISTS lease_expires_at, DROP COLUMN IF EXISTS leased_by, DROP COLUMN IF EXISTS heartbeat_at,
  DROP COLUMN IF EXISTS idempotency_key, DROP COLUMN IF EXISTS request_hash, DROP COLUMN IF EXISTS dedupe_key,
  DROP COLUMN IF EXISTS settings, DROP COLUMN IF EXISTS processor_version, DROP COLUMN IF EXISTS run_id,
  DROP COLUMN IF EXISTS cancel_requested_at, DROP COLUMN IF EXISTS started_at, DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS dead_lettered_at, DROP COLUMN IF EXISTS error_details, DROP COLUMN IF EXISTS requested_by,
  DROP COLUMN IF EXISTS request_id;

DROP INDEX IF EXISTS idx_audit_entity;
DROP INDEX IF EXISTS idx_audit_created;
ALTER TABLE ai_audit_log DROP COLUMN IF EXISTS request_id, DROP COLUMN IF EXISTS actor_role;

DELETE FROM schema_migrations WHERE version = '006';

COMMIT;
