ALTER TABLE tribunal_cases
  ADD COLUMN precedent_ref UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN precedent_client_consent_at TIMESTAMPTZ,
  ADD COLUMN precedent_provider_consent_at TIMESTAMPTZ;

CREATE INDEX tribunal_precedents_public_idx
  ON tribunal_cases (decided_at DESC)
  WHERE stage = 'decided';
