-- A shared, leased job per normalized interest. Existing interests are seeded lazily.
CREATE TABLE IF NOT EXISTS interest_monitor_jobs (
  interest_key TEXT PRIMARY KEY,
  interest_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','source_linked','no_source','temporary_failure')),
  source_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_discovery_at TEXT,
  next_attempt_at TEXT,
  error_code TEXT,
  claim_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interest_monitor_due ON interest_monitor_jobs(next_attempt_at,lease_until);
