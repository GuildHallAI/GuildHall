CREATE TABLE surety_pool (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  wallet_public_key TEXT NOT NULL UNIQUE,
  encrypted_secret_key BYTEA NOT NULL,
  encryption_nonce BYTEA NOT NULL,
  encryption_auth_tag BYTEA NOT NULL,
  encryption_key_version SMALLINT NOT NULL CHECK (encryption_key_version = 1),
  cluster TEXT NOT NULL CHECK (cluster IN ('localnet', 'devnet', 'testnet', 'mainnet-beta')),
  asset_mint TEXT NOT NULL,
  accounted_balance_atomic NUMERIC(20, 0) NOT NULL DEFAULT 0 CHECK (accounted_balance_atomic >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE surety_pool_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  wallet_address TEXT NOT NULL,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic > 0),
  shares_atomic NUMERIC(20, 0) CHECK (shares_atomic IS NULL OR shares_atomic > 0),
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  unsigned_transaction TEXT NOT NULL,
  transaction_signature TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'awaiting' CHECK (state IN ('awaiting', 'confirmed', 'cancelled')),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL AND transaction_signature IS NOT NULL AND shares_atomic IS NOT NULL)),
  CHECK (state <> 'awaiting' OR (confirmed_at IS NULL AND transaction_signature IS NULL AND shares_atomic IS NULL))
);
CREATE UNIQUE INDEX surety_one_pending_deposit_idx ON surety_pool_deposits ((state)) WHERE state = 'awaiting';
CREATE INDEX surety_pool_deposits_user_idx ON surety_pool_deposits (user_id, created_at DESC);

CREATE TABLE surety_pool_share_accounts (
  user_id UUID PRIMARY KEY REFERENCES wallet_users(id) ON DELETE RESTRICT,
  shares_atomic NUMERIC(20, 0) NOT NULL DEFAULT 0 CHECK (shares_atomic >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE surety_withdrawal_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  wallet_address TEXT NOT NULL,
  shares_atomic NUMERIC(20, 0) NOT NULL CHECK (shares_atomic > 0),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'processing', 'confirmed', 'cancelled', 'failed', 'wiped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX surety_withdrawal_queue_idx ON surety_withdrawal_requests (created_at, id)
  WHERE state IN ('queued', 'processing', 'failed');

CREATE TABLE surety_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL UNIQUE REFERENCES commissions(id) ON DELETE RESTRICT,
  client_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  client_wallet TEXT NOT NULL,
  work_category TEXT NOT NULL,
  sla_hours SMALLINT,
  coverage_atomic NUMERIC(20, 0) NOT NULL CHECK (coverage_atomic > 0),
  premium_atomic NUMERIC(20, 0) NOT NULL CHECK (premium_atomic > 0),
  treasury_fee_atomic NUMERIC(20, 0) NOT NULL CHECK (treasury_fee_atomic >= 0),
  premium_rate_bps SMALLINT NOT NULL CHECK (premium_rate_bps BETWEEN 1 AND 5000),
  observed_overturn_rate_percent NUMERIC(7, 4),
  rate_sample_size INTEGER NOT NULL DEFAULT 0 CHECK (rate_sample_size >= 0),
  state TEXT NOT NULL DEFAULT 'awaiting_premium'
    CHECK (state IN ('awaiting_premium', 'active', 'claim_pending', 'claim_submitted', 'claimed', 'released', 'refunded', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  premium_signature TEXT UNIQUE,
  premium_confirmed_at TIMESTAMPTZ,
  premium_unsigned_transaction TEXT,
  premium_recent_blockhash TEXT,
  premium_last_valid_block_height BIGINT,
  treasury_fee_paid BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state IN ('active', 'claim_pending', 'claim_submitted', 'claimed', 'released', 'refunded')) = (premium_signature IS NOT NULL AND premium_confirmed_at IS NOT NULL))
);
CREATE INDEX surety_policies_active_idx ON surety_policies (commission_id)
  WHERE state IN ('active', 'claim_pending', 'claim_submitted');

CREATE TABLE surety_pool_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('claim', 'premium_fee', 'premium_refund', 'withdrawal')),
  reference_id UUID NOT NULL,
  destination_wallet TEXT NOT NULL,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic > 0),
  shares_atomic NUMERIC(20, 0),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'submitted', 'confirmed', 'failed')),
  transaction_signature TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, reference_id),
  CHECK ((kind = 'withdrawal') = (shares_atomic IS NOT NULL))
);
CREATE INDEX surety_pool_operations_queue_idx ON surety_pool_operations (created_at)
  WHERE state IN ('queued', 'submitted', 'failed');

CREATE TABLE surety_pool_operation_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES surety_pool_operations(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX surety_pool_operation_attempts_pending_idx ON surety_pool_operation_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');
