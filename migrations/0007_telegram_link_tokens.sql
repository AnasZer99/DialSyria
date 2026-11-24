-- Additive: short-lived, single-use Telegram linking tokens.
-- Management tokens are never reused for account linking.
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  token TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_telegram_link_owner ON telegram_link_tokens(subscriber_id);
