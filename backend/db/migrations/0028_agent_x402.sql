ALTER TABLE agent_accounts
  ADD COLUMN allowed_x402_hosts TEXT[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(allowed_x402_hosts) <= 50);

CREATE TABLE agent_x402_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_url_hash CHAR(64) NOT NULL CHECK (request_url_hash ~ '^[0-9a-f]{64}$'),
  request_host TEXT NOT NULL,
  request_method TEXT NOT NULL CHECK (request_method IN ('GET', 'POST')),
  reserved_atomic NUMERIC(20, 0) NOT NULL CHECK (reserved_atomic >= 0),
  charged_atomic NUMERIC(20, 0) CHECK (charged_atomic IS NULL OR charged_atomic >= 0),
  payment_mint TEXT,
  payment_network TEXT,
  payment_recipient TEXT,
  state TEXT NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'succeeded', 'unpaid', 'failed', 'outcome_unknown')),
  response_status SMALLINT CHECK (response_status BETWEEN 100 AND 599),
  response_content_type TEXT,
  response_ciphertext BYTEA,
  response_nonce BYTEA,
  response_auth_tag BYTEA,
  response_key_version SMALLINT CHECK (response_key_version = 1),
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key),
  CHECK (
    (response_ciphertext IS NULL AND response_nonce IS NULL AND response_auth_tag IS NULL AND response_key_version IS NULL)
    OR
    (response_ciphertext IS NOT NULL AND response_nonce IS NOT NULL AND response_auth_tag IS NOT NULL AND response_key_version = 1)
  )
);

CREATE INDEX agent_x402_requests_recent_idx
  ON agent_x402_requests (account_id, created_at DESC);
CREATE INDEX agent_x402_requests_unknown_idx
  ON agent_x402_requests (created_at)
  WHERE state IN ('prepared', 'outcome_unknown');
