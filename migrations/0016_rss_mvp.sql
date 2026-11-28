-- RSS MVP: one-time Telegram pairing codes + per-subscriber Telegram delivery prefs.
-- Additive and idempotent; never alters or drops existing tables or data.
CREATE TABLE IF NOT EXISTS rss_link_codes (
  code TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rss_link_codes_sub ON rss_link_codes(subscriber_id);

CREATE TABLE IF NOT EXISTS rss_telegram_prefs (
  subscriber_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);
