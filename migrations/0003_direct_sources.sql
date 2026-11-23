CREATE TABLE IF NOT EXISTS direct_sources (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, name TEXT NOT NULL, discovered_at TEXT NOT NULL, last_checked_at TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS direct_source_interests (interest_key TEXT NOT NULL, source_id TEXT NOT NULL, last_checked_at TEXT, PRIMARY KEY(interest_key,source_id));
CREATE TABLE IF NOT EXISTS direct_items (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content TEXT NOT NULL, published_at TEXT, first_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS direct_runs (id TEXT PRIMARY KEY, interest_key TEXT NOT NULL, mode TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, report TEXT);
CREATE TABLE IF NOT EXISTS direct_provider_backoff (provider TEXT PRIMARY KEY, until_at TEXT NOT NULL, reason TEXT NOT NULL);
