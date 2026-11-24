-- Additive: one row per prepared notification. Nothing is deleted; delivery status is
-- tracked separately from preparation (prepared -> sent | failed; sent is terminal).
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  interest_key TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT,
  url TEXT NOT NULL,
  published_at TEXT,
  excerpt TEXT,
  status TEXT NOT NULL DEFAULT 'prepared',
  prepared_at TEXT NOT NULL,
  sent_at TEXT,
  error TEXT,
  UNIQUE (subscriber_id, item_kind, item_id),
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notifications_owner ON notifications(subscriber_id, status);
