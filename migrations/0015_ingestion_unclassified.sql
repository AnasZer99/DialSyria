-- Track how many parsed items each source skipped for lack of a confident
-- topic classification (excluded instead of defaulting to a category).
--
-- Deliberately a separate companion table with CREATE TABLE IF NOT EXISTS so
-- this migration is safe on EVERY upgrade path: existing databases, fresh
-- databases created from schema.sql, and repeated applications. It never
-- alters or drops existing tables or data.
CREATE TABLE IF NOT EXISTS ingestion_source_skips (
  run_started_at TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  unclassified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_started_at, source_id)
);
CREATE INDEX IF NOT EXISTS idx_ingestion_source_skips_run ON ingestion_source_skips(run_started_at);
