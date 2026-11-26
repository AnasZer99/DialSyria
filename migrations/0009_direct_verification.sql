-- Previously collected direct rows have no persisted proof; keep them but do not
-- deliver them until a permitted source check verifies the exact article or post.
ALTER TABLE direct_items ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified';
