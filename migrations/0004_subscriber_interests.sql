-- Additive: legacy topics and subscriber data are left unchanged.
CREATE TABLE IF NOT EXISTS subscriber_interests (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (subscriber_id, normalized_text),
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subscriber_interests_owner ON subscriber_interests(subscriber_id);
