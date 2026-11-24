-- Additive: marks items produced by deterministic mock discovery so they can never be
-- presented as live news. No rows are deleted; known mock URLs are backfilled in place.
ALTER TABLE discovery_items ADD COLUMN is_mock INTEGER NOT NULL DEFAULT 0;
UPDATE discovery_items SET is_mock = 1 WHERE url LIKE 'https://mock-source.test/%' OR original_url LIKE 'https://mock-source.test/%';
