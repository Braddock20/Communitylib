-- Communitylib v4.1.0 performance and safety migration.
-- Additive and safe to re-run. Back up the database before applying.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS resource_topics (
  resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  normalized_topic TEXT NOT NULL,
  PRIMARY KEY (resource_id, normalized_topic)
);

CREATE INDEX IF NOT EXISTS idx_resource_topics_unit ON resource_topics (unit_id);
CREATE INDEX IF NOT EXISTS idx_resource_topics_topic_trgm
  ON resource_topics USING gin (topic gin_trgm_ops);

-- Backfill existing topic arrays without creating duplicate normalized rows.
INSERT INTO resource_topics(resource_id, unit_id, topic, normalized_topic)
SELECT DISTINCT ON (r.id, normalized_topic) r.id, r.unit_id, btrim(topic_value),
       regexp_replace(lower(btrim(topic_value)), '[[:space:]]+', ' ', 'g') AS normalized_topic
FROM resources r
CROSS JOIN LATERAL unnest(COALESCE(r.topics, '{}'::text[])) AS topic_value
WHERE btrim(topic_value) <> ''
ORDER BY r.id, normalized_topic
ON CONFLICT (resource_id, normalized_topic)
DO UPDATE SET unit_id=EXCLUDED.unit_id, topic=EXCLUDED.topic;

CREATE OR REPLACE FUNCTION communitylib_sync_resource_topics() RETURNS trigger AS $$
BEGIN
  DELETE FROM resource_topics WHERE resource_id = NEW.id;
  INSERT INTO resource_topics(resource_id, unit_id, topic, normalized_topic)
  SELECT DISTINCT ON (normalized_topic) NEW.id, NEW.unit_id, btrim(topic_value),
         regexp_replace(lower(btrim(topic_value)), '[[:space:]]+', ' ', 'g') AS normalized_topic
  FROM unnest(COALESCE(NEW.topics, '{}'::text[])) AS topic_value
  WHERE btrim(topic_value) <> ''
  ORDER BY normalized_topic
  ON CONFLICT (resource_id, normalized_topic)
  DO UPDATE SET unit_id=EXCLUDED.unit_id, topic=EXCLUDED.topic;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_resources_sync_topics ON resources;
CREATE TRIGGER trg_resources_sync_topics
AFTER INSERT OR UPDATE OF topics, unit_id ON resources
FOR EACH ROW EXECUTE FUNCTION communitylib_sync_resource_topics();

-- Covering indexes for the feed's fixed 14-day log window.
CREATE INDEX IF NOT EXISTS idx_download_logs_created_cover
  ON download_logs (created_at DESC) INCLUDE (unit_id);
CREATE INDEX IF NOT EXISTS idx_search_logs_created_cover
  ON search_logs (created_at DESC) INCLUDE (unit_id);

-- Keep the file proxy's visibility lookup indexed at library growth scale.
CREATE INDEX IF NOT EXISTS idx_resource_files_file_url ON resource_files (file_url);
CREATE INDEX IF NOT EXISTS idx_resources_combined_pdf_url
  ON resources (combined_pdf_url) WHERE combined_pdf_url IS NOT NULL;
