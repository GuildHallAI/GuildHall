-- Freeze a SHA-256 of each commission's canonical terms when it is funded.
-- terms_anchored records whether the client's funding transaction carried the same hash in a Memo.
ALTER TABLE commissions
  ADD COLUMN terms_hash TEXT CHECK (terms_hash IS NULL OR terms_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN terms_hashed_at TIMESTAMPTZ,
  ADD COLUMN terms_anchored BOOLEAN NOT NULL DEFAULT false;
