-- Existing beta users do not opt in implicitly: NULL requires explicit consent.
ALTER TABLE beta_identities ADD COLUMN notifications_enabled_at TEXT;
ALTER TABLE notifications ADD COLUMN observed_at TEXT;
-- Reserve one canonical URL per beta subscriber even across different item stores.
CREATE TABLE IF NOT EXISTS beta_notification_keys (
  subscriber_id TEXT NOT NULL,
  url_key TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  PRIMARY KEY(subscriber_id,url_key)
);
