-- Additive beta authentication; existing subscribers and management tokens remain untouched.
CREATE TABLE IF NOT EXISTS beta_challenges (
  challenge_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  display_code TEXT NOT NULL,
  interests_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  chat_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_beta_challenge_expiry ON beta_challenges(expires_at);
CREATE TABLE IF NOT EXISTS beta_identities (
  chat_id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL UNIQUE REFERENCES subscribers(id),
  created_at TEXT NOT NULL,
  created_beta INTEGER NOT NULL DEFAULT 0,
  paused_from TEXT
);
CREATE TABLE IF NOT EXISTS beta_sessions (
  session_hash TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_beta_session_expiry ON beta_sessions(expires_at);
