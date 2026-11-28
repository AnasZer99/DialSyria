CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  whatsapp TEXT,
  telegram_chat_id TEXT,
  language TEXT NOT NULL DEFAULT 'ar',
  delivery_hour INTEGER NOT NULL DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'trial',
  trial_ends_at TEXT,
  expires_at TEXT,
  magic_token TEXT,
  magic_expires TEXT,
  created_at TEXT NOT NULL,
  last_digest_at TEXT
);

CREATE TABLE IF NOT EXISTS subscriber_topics (
  subscriber_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  PRIMARY KEY (subscriber_id, topic)
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  topic TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  published_at TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  inserted INTEGER NOT NULL DEFAULT 0,
  feeds_ok INTEGER NOT NULL DEFAULT 0,
  feeds_fail INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  topics TEXT NOT NULL,
  articles_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);

-- Per-source observability for the daily RSS run (see migrations/0014).
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
-- Per-source unclassified (excluded) counts in their own idempotent companion
-- table; definition matches migrations/0015 exactly so fresh schema.sql
-- databases and migration upgrades converge on the same shape (safe on every
-- path: existing DBs, new DBs, repeated applications).
CREATE TABLE IF NOT EXISTS ingestion_source_skips (
  run_started_at TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  unclassified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_started_at, source_id)
);
CREATE INDEX IF NOT EXISTS idx_ingestion_source_skips_run ON ingestion_source_skips(run_started_at);
CREATE INDEX IF NOT EXISTS idx_articles_scope_topic ON articles(scope, topic, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_fetched ON articles(fetched_at);
