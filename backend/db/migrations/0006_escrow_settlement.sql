ALTER TABLE commission_escrow_operations
  DROP CONSTRAINT commission_escrow_operations_operation_check,
  ADD CONSTRAINT commission_escrow_operations_operation_check
    CHECK (operation IN ('fund', 'release', 'refund', 'sweep', 'split'));

ALTER TABLE commission_escrow_operations
  ADD COLUMN signed_transaction BYTEA,
  ADD COLUMN recent_blockhash TEXT,
  ADD COLUMN last_valid_block_height BIGINT,
  ADD COLUMN fee_atomic NUMERIC(20, 0) NOT NULL DEFAULT 0 CHECK (fee_atomic >= 0),
  ADD COLUMN distribution JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(distribution) = 'object');

CREATE TABLE commission_escrow_operation_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES commission_escrow_operations(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX commission_operation_attempts_pending_idx
  ON commission_escrow_operation_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');

ALTER TABLE commission_escrow_operations
  ADD CONSTRAINT commission_escrow_operations_signed_tx_check
  CHECK ((signed_transaction IS NULL AND recent_blockhash IS NULL AND last_valid_block_height IS NULL)
      OR (signed_transaction IS NOT NULL AND recent_blockhash IS NOT NULL AND last_valid_block_height IS NOT NULL));
