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
