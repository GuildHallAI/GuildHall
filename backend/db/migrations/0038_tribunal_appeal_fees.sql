CREATE TABLE tribunal_appeal_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES tribunal_cases(id) ON DELETE RESTRICT,
  appeal_tier TEXT NOT NULL CHECK (appeal_tier IN ('warden', 'panel')),
  appellant_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  fee_wallet_public_key TEXT NOT NULL UNIQUE,
  encrypted_secret_key BYTEA NOT NULL,
  encryption_nonce BYTEA NOT NULL,
  encryption_auth_tag BYTEA NOT NULL,
  encryption_key_version SMALLINT NOT NULL CHECK (encryption_key_version = 1),
  cluster TEXT NOT NULL CHECK (cluster IN ('localnet', 'devnet', 'testnet', 'mainnet-beta')),
  mint TEXT NOT NULL,
  base_fee_atomic NUMERIC(30, 0) NOT NULL CHECK (base_fee_atomic >= 0),
  discount_bps INTEGER NOT NULL CHECK (discount_bps BETWEEN 0 AND 10000),
  charged_fee_atomic NUMERIC(30, 0) NOT NULL CHECK (charged_fee_atomic >= 0),
  payment_signature TEXT UNIQUE,
  appealed_verdict TEXT NOT NULL CHECK (appealed_verdict IN ('client', 'provider', 'split', 'dismissed')),
  won BOOLEAN,
  state TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (state IN ('awaiting_payment', 'paid', 'appealed', 'refund_pending', 'treasury_pending', 'complete', 'waived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, appeal_tier),
  CHECK ((charged_fee_atomic = 0 AND state IN ('waived', 'paid', 'complete')) OR charged_fee_atomic > 0)
);

CREATE TABLE tribunal_appeal_fee_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_id UUID NOT NULL UNIQUE REFERENCES tribunal_appeal_fees(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('refund', 'treasury')),
  amount_atomic NUMERIC(30, 0) NOT NULL CHECK (amount_atomic > 0),
  destination_wallet TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed')),
  transaction_signature TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tribunal_appeal_fee_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES tribunal_appeal_fee_operations(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tribunal_appeal_fee_ops_pending_idx ON tribunal_appeal_fee_operations (created_at)
  WHERE state IN ('pending', 'submitted', 'failed');
CREATE INDEX tribunal_appeal_fee_attempts_pending_idx ON tribunal_appeal_fee_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');
