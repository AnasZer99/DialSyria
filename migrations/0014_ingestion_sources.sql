-- Ingestion observability. Additive only: no existing row is modified or removed,
-- and re-running the migration is safe.
--
-- Note: indexes on the legacy `articles` table live in schema.sql (the table is
-- created there, not by an earlier migration), so this migration must not touch it.
CREATE TABLE IF NOT EXISTS ingestion_sources (
  run_started_at TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  parsed INTEGER NOT NULL DEFAULT 0,
  recent INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (run_started_at, source_id)
);
CREATE INDEX IF NOT EXISTS idx_ingestion_sources_run ON ingestion_sources(run_started_at);
