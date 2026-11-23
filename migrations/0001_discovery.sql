-- Additive tables: existing subscribers and articles remain untouched.
CREATE TABLE IF NOT EXISTS discovery_runs (id TEXT PRIMARY KEY, interest TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, report TEXT);
CREATE TABLE IF NOT EXISTS discovery_sources (host TEXT PRIMARY KEY, name TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discovery_source_interests (interest_key TEXT NOT NULL, host TEXT NOT NULL, PRIMARY KEY(interest_key, host));
CREATE TABLE IF NOT EXISTS discovery_items (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT, source TEXT, published_at TEXT, discovered_at TEXT NOT NULL, source_host TEXT);
CREATE TABLE IF NOT EXISTS discovery_item_interests (interest_key TEXT NOT NULL, item_id TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY(interest_key, item_id));
