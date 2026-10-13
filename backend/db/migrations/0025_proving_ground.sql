CREATE TABLE proving_ground_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'awaiting_fee'
    CHECK (state IN ('awaiting_fee', 'active', 'passed', 'failed', 'funding_pending', 'funded', 'closed')),
  cluster TEXT NOT NULL CHECK (cluster IN ('localnet', 'devnet', 'testnet', 'mainnet-beta')),
  asset_mint TEXT NOT NULL,
  funded_wallet_public_key TEXT UNIQUE,
  encrypted_funded_wallet_secret_key BYTEA,
  funded_wallet_encryption_nonce BYTEA,
  funded_wallet_encryption_auth_tag BYTEA,
  funded_wallet_encryption_key_version SMALLINT CHECK (funded_wallet_encryption_key_version IS NULL OR funded_wallet_encryption_key_version = 1),
  funded_at TIMESTAMPTZ,
  fee_atomic NUMERIC(30, 0) NOT NULL CHECK (fee_atomic > 0),
  fee_signature TEXT UNIQUE,
  fee_unsigned_transaction TEXT,
  fee_recent_blockhash TEXT,
  fee_last_valid_block_height BIGINT,
  initial_equity_atomic NUMERIC(30, 0) NOT NULL CHECK (initial_equity_atomic > 0),
  cash_balance_atomic NUMERIC(30, 0) NOT NULL CHECK (cash_balance_atomic >= 0),
  peak_equity_atomic NUMERIC(30, 0) NOT NULL CHECK (peak_equity_atomic >= 0),
  day_open_equity_atomic NUMERIC(30, 0) NOT NULL CHECK (day_open_equity_atomic >= 0),
  day_open_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failure_reason TEXT CHECK (failure_reason IN ('daily_drawdown', 'total_drawdown', 'challenge_timeout')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK ((state IN ('awaiting_fee') AND fee_signature IS NULL)
      OR state NOT IN ('awaiting_fee')),
  CHECK ((started_at IS NULL) = (ends_at IS NULL)),
  CHECK ((state IN ('active', 'passed', 'failed', 'funding_pending', 'funded', 'closed')) = (started_at IS NOT NULL)),
  CHECK ((state IN ('passed', 'failed', 'closed')) = (completed_at IS NOT NULL)),
  CHECK (state <> 'failed' OR failure_reason IS NOT NULL),
  CHECK ((funded_wallet_public_key IS NULL) = (encrypted_funded_wallet_secret_key IS NULL)),
  CHECK ((funded_wallet_public_key IS NULL) = (funded_wallet_encryption_nonce IS NULL)),
  CHECK ((funded_wallet_public_key IS NULL) = (funded_wallet_encryption_auth_tag IS NULL)),
  CHECK ((funded_wallet_public_key IS NULL) = (funded_wallet_encryption_key_version IS NULL)),
  CHECK ((state = 'funded') = (funded_at IS NOT NULL))
);
CREATE UNIQUE INDEX proving_ground_one_active_account_per_user_idx
  ON proving_ground_accounts (user_id)
  WHERE state IN ('awaiting_fee', 'active', 'passed', 'funding_pending', 'funded');
CREATE INDEX proving_ground_account_queue_idx ON proving_ground_accounts (created_at)
  WHERE state IN ('awaiting_fee', 'passed', 'funding_pending');

CREATE TABLE proving_ground_fee_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES proving_ground_accounts(id) ON DELETE RESTRICT,
  unsigned_transaction TEXT NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  transaction_signature TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'awaiting' CHECK (state IN ('awaiting', 'confirmed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state = 'confirmed') = (transaction_signature IS NOT NULL))
);
CREATE INDEX proving_ground_fee_attempts_pending_idx ON proving_ground_fee_attempts (account_id, created_at DESC)
  WHERE state = 'awaiting';

CREATE TABLE proving_ground_pool (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  wallet_public_key TEXT NOT NULL UNIQUE,
  encrypted_secret_key BYTEA NOT NULL,
  encryption_nonce BYTEA NOT NULL,
  encryption_auth_tag BYTEA NOT NULL,
  encryption_key_version SMALLINT NOT NULL CHECK (encryption_key_version = 1),
  cluster TEXT NOT NULL CHECK (cluster IN ('localnet', 'devnet', 'testnet', 'mainnet-beta')),
  asset_mint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE proving_ground_funding_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES proving_ground_accounts(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('allocation', 'return', 'profit_split')),
  amount_atomic NUMERIC(30, 0) NOT NULL CHECK (amount_atomic > 0),
  destination_wallet TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'submitted', 'confirmed', 'failed')),
  transaction_signature TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind)
);
CREATE INDEX proving_ground_funding_queue_idx ON proving_ground_funding_operations (created_at)
  WHERE state IN ('queued', 'submitted', 'failed');

CREATE TABLE proving_ground_funding_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES proving_ground_funding_operations(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX proving_ground_funding_attempts_pending_idx ON proving_ground_funding_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');

CREATE TABLE proving_ground_positions (
  account_id UUID NOT NULL REFERENCES proving_ground_accounts(id) ON DELETE RESTRICT,
  market TEXT NOT NULL,
  quantity_atomic NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (quantity_atomic >= 0),
  average_entry_price_atomic NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (average_entry_price_atomic >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, market)
);

CREATE TABLE proving_ground_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES proving_ground_accounts(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity_atomic NUMERIC(30, 0) NOT NULL CHECK (quantity_atomic > 0),
  price_atomic NUMERIC(30, 0) NOT NULL CHECK (price_atomic > 0),
  notional_atomic NUMERIC(30, 0) NOT NULL CHECK (notional_atomic > 0),
  oracle_feed_id TEXT NOT NULL,
  oracle_publish_time TIMESTAMPTZ NOT NULL,
  cash_balance_after_atomic NUMERIC(30, 0) NOT NULL CHECK (cash_balance_after_atomic >= 0),
  position_after_atomic NUMERIC(30, 0) NOT NULL CHECK (position_after_atomic >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);
CREATE INDEX proving_ground_trades_account_idx ON proving_ground_trades (account_id, created_at DESC);

CREATE TABLE proving_ground_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES proving_ground_accounts(id) ON DELETE RESTRICT,
  equity_atomic NUMERIC(30, 0) NOT NULL CHECK (equity_atomic >= 0),
  peak_equity_atomic NUMERIC(30, 0) NOT NULL CHECK (peak_equity_atomic >= equity_atomic),
  day_open_equity_atomic NUMERIC(30, 0) NOT NULL CHECK (day_open_equity_atomic >= 0),
  daily_drawdown_bps INTEGER NOT NULL CHECK (daily_drawdown_bps >= 0),
  total_drawdown_bps INTEGER NOT NULL CHECK (total_drawdown_bps >= 0),
  oracle_feed_id TEXT NOT NULL,
  oracle_publish_time TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX proving_ground_marks_account_idx ON proving_ground_marks (account_id, created_at DESC);
