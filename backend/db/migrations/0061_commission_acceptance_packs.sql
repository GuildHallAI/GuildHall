-- Declarative, bounded acceptance checks. Packs are part of commission terms and
-- never execute client-supplied code inside the GuildHall backend.
ALTER TABLE commissions
  ADD COLUMN acceptance_pack JSONB,
  ADD CONSTRAINT commissions_acceptance_pack_object
    CHECK (acceptance_pack IS NULL OR jsonb_typeof(acceptance_pack) = 'object');

CREATE TABLE commission_submission_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  submission_id UUID NOT NULL UNIQUE REFERENCES commission_submissions(id) ON DELETE RESTRICT,
  pack_hash TEXT NOT NULL CHECK (pack_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  results JSONB NOT NULL CHECK (jsonb_typeof(results) = 'array'),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commission_submission_verifications_commission_idx
  ON commission_submission_verifications (commission_id, verified_at DESC);
