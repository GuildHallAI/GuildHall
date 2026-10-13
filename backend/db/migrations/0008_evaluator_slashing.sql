CREATE TABLE evaluator_slash_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL UNIQUE REFERENCES tribunal_cases(id) ON DELETE RESTRICT,
  evaluator_user_id UUID NOT NULL REFERENCES evaluator_profiles(user_id) ON DELETE RESTRICT,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic > 0),
  distribution JSONB NOT NULL CHECK (jsonb_typeof(distribution) = 'object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed')),
  transaction_signature TEXT UNIQUE,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE evaluator_slash_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES evaluator_slash_operations(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evaluator_slash_attempts_pending_idx ON evaluator_slash_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');
