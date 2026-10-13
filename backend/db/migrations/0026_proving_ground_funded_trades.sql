CREATE TABLE proving_ground_funded_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES proving_ground_accounts(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  input_mint TEXT NOT NULL,
  output_mint TEXT NOT NULL,
  input_amount_atomic NUMERIC(30, 0) NOT NULL CHECK (input_amount_atomic > 0),
  expected_output_atomic NUMERIC(30, 0) NOT NULL CHECK (expected_output_atomic > 0),
  actual_output_atomic NUMERIC(30, 0),
  jupiter_request_id TEXT NOT NULL,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  router TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);
CREATE INDEX proving_ground_funded_trade_queue_idx
  ON proving_ground_funded_trades (created_at)
  WHERE state IN ('prepared', 'submitted');

ALTER TABLE proving_ground_accounts
  ADD COLUMN funded_high_water_mark_atomic NUMERIC(30, 0)
    CHECK (funded_high_water_mark_atomic IS NULL OR funded_high_water_mark_atomic >= 0);

CREATE TABLE proving_ground_profit_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES proving_ground_accounts(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  high_water_mark_atomic NUMERIC(30, 0) NOT NULL CHECK (high_water_mark_atomic > 0),
  profit_atomic NUMERIC(30, 0) NOT NULL CHECK (profit_atomic > 0),
  trader_amount_atomic NUMERIC(30, 0) NOT NULL CHECK (trader_amount_atomic >= 0),
  pool_amount_atomic NUMERIC(30, 0) NOT NULL CHECK (pool_amount_atomic >= 0),
  protocol_amount_atomic NUMERIC(30, 0) NOT NULL CHECK (protocol_amount_atomic >= 0),
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key),
  CHECK (trader_amount_atomic + pool_amount_atomic + protocol_amount_atomic = profit_atomic)
);
CREATE INDEX proving_ground_profit_settlement_queue_idx
  ON proving_ground_profit_settlements (created_at)
  WHERE state IN ('prepared', 'submitted');

CREATE TABLE charter_buyback_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyback_id UUID NOT NULL REFERENCES charter_buybacks(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('swap', 'burn')),
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  jupiter_request_id TEXT,
  expected_output_atomic NUMERIC(30, 0),
  router TEXT,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'swap') = (jupiter_request_id IS NOT NULL AND expected_output_atomic IS NOT NULL AND router IS NOT NULL))
);
CREATE INDEX charter_buyback_attempts_pending_idx
  ON charter_buyback_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');
