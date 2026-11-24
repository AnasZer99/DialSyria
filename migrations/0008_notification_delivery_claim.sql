-- Additive: claim timestamp for in-flight notification delivery so overlapping
-- scheduled runs cannot double-send. No rows are deleted.
ALTER TABLE notifications ADD COLUMN claimed_at TEXT;
