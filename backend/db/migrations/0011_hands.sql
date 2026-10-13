ALTER TABLE commissions
  ADD COLUMN work_type TEXT NOT NULL DEFAULT 'standard'
    CHECK (work_type IN ('standard', 'hand', 'bounty', 'crew', 'guild', 'proving_ground')),
  ADD COLUMN category TEXT,
  ADD COLUMN proof_schema JSONB;

ALTER TABLE commissions
  ADD CONSTRAINT commissions_hand_schema_check
  CHECK ((work_type = 'hand' AND category IS NOT NULL AND jsonb_typeof(proof_schema) = 'array')
      OR (work_type <> 'hand' AND proof_schema IS NULL));

CREATE INDEX commissions_hand_marketplace_idx ON commissions (created_at DESC)
  WHERE work_type = 'hand' AND status IN ('open', 'funded') AND provider_user_id IS NULL;
