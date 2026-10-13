CREATE TABLE work_record_chain_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_record_id UUID NOT NULL UNIQUE REFERENCES work_records(id) ON DELETE RESTRICT,
  record_hash TEXT NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  memo_data TEXT NOT NULL CHECK (char_length(memo_data) BETWEEN 1 AND 566),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed')),
  transaction_signature TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX work_record_chain_operations_pending_idx ON work_record_chain_operations (created_at)
  WHERE state IN ('pending', 'submitted', 'failed');

CREATE TABLE work_record_chain_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES work_record_chain_operations(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX work_record_chain_attempts_pending_idx ON work_record_chain_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');
