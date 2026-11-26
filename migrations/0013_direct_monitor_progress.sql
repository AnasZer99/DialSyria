-- Additive staging-safe state for bounded per-interest source catch-up.
-- Candidates are untrusted and never read by the notification pipeline.
CREATE TABLE IF NOT EXISTS direct_monitor_cursors (
  interest_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  head_id TEXT,
  next_before TEXT,
  stop_after TEXT,
  window_start TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(interest_key,source_id)
);
CREATE TABLE IF NOT EXISTS direct_monitor_candidates (
  interest_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  published_at TEXT,
  first_seen TEXT NOT NULL,
  score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(interest_key,source_id,url)
);
CREATE INDEX IF NOT EXISTS idx_direct_monitor_candidates_due ON direct_monitor_candidates(interest_key,source_id,status,next_attempt_at,first_seen);
