CREATE TABLE evaluator_stake_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES evaluator_profiles(user_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  destination_wallet TEXT NOT NULL,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic > 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed')),
  transaction_signature TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE evaluator_stake_withdrawal_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id UUID NOT NULL REFERENCES evaluator_stake_withdrawals(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evaluator_withdrawal_attempts_pending_idx ON evaluator_stake_withdrawal_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');
