ALTER TABLE commissions
  ADD COLUMN client_user_id UUID REFERENCES wallet_users(id),
  ADD COLUMN provider_user_id UUID REFERENCES wallet_users(id),
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN request_hash TEXT,
  ADD COLUMN accepted_at TIMESTAMPTZ,
  ADD COLUMN funding_signature TEXT,
  ADD COLUMN funded_at TIMESTAMPTZ;

CREATE UNIQUE INDEX commissions_client_idempotency_idx
  ON commissions (client_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX commissions_funding_signature_idx
  ON commissions (funding_signature)
  WHERE funding_signature IS NOT NULL;

CREATE INDEX commissions_open_marketplace_idx
  ON commissions (created_at DESC)
  WHERE status = 'open' AND accepted_at IS NULL;
