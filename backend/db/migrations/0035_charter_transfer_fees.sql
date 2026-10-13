ALTER TABLE charters
  ADD COLUMN fee_wallet_public_key TEXT UNIQUE,
  ADD COLUMN encrypted_fee_secret_key BYTEA,
  ADD COLUMN fee_encryption_nonce BYTEA,
  ADD COLUMN fee_encryption_auth_tag BYTEA,
  ADD COLUMN fee_encryption_key_version SMALLINT,
  ADD COLUMN fee_account_cursor TEXT,
  ADD COLUMN fee_reconciled_at TIMESTAMPTZ;

ALTER TABLE charters ADD CONSTRAINT charters_fee_wallet_encryption_complete CHECK (
  (fee_wallet_public_key IS NULL AND encrypted_fee_secret_key IS NULL AND fee_encryption_nonce IS NULL
    AND fee_encryption_auth_tag IS NULL AND fee_encryption_key_version IS NULL)
  OR (fee_wallet_public_key IS NOT NULL AND encrypted_fee_secret_key IS NOT NULL AND fee_encryption_nonce IS NOT NULL
    AND fee_encryption_auth_tag IS NOT NULL AND fee_encryption_key_version = 1)
);

CREATE TABLE charter_transfer_fee_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES charters(user_id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'collecting' CHECK (state IN ('collecting', 'distributing', 'complete')),
  collected_amount_atomic NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (collected_amount_atomic >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX charter_transfer_fee_one_open_operation_idx
  ON charter_transfer_fee_operations (user_id) WHERE state <> 'complete';

CREATE TABLE charter_transfer_fee_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES charter_transfer_fee_operations(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('collect', 'distribute')),
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX charter_transfer_fee_attempts_pending_idx
  ON charter_transfer_fee_attempts (updated_at) WHERE state IN ('prepared', 'submitted');
