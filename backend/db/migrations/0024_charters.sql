CREATE TABLE charters (
  user_id UUID PRIMARY KEY REFERENCES wallet_users(id) ON DELETE RESTRICT,
  token_mint TEXT NOT NULL UNIQUE,
  vault_wallet_public_key TEXT NOT NULL UNIQUE,
  encrypted_vault_secret_key BYTEA NOT NULL,
  vault_encryption_nonce BYTEA NOT NULL,
  vault_encryption_auth_tag BYTEA NOT NULL,
  vault_encryption_key_version SMALLINT NOT NULL CHECK (vault_encryption_key_version = 1),
  liquidity_wallet_public_key TEXT NOT NULL UNIQUE,
  encrypted_liquidity_secret_key BYTEA NOT NULL,
  liquidity_encryption_nonce BYTEA NOT NULL,
  liquidity_encryption_auth_tag BYTEA NOT NULL,
  liquidity_encryption_key_version SMALLINT NOT NULL CHECK (liquidity_encryption_key_version = 1),
  cluster TEXT NOT NULL CHECK (cluster IN ('localnet', 'devnet', 'testnet', 'mainnet-beta')),
  supply_atomic NUMERIC(30, 0) NOT NULL CHECK (supply_atomic > 0),
  creator_allocation_atomic NUMERIC(30, 0) NOT NULL CHECK (creator_allocation_atomic >= 0),
  liquidity_allocation_atomic NUMERIC(30, 0) NOT NULL CHECK (liquidity_allocation_atomic >= 0),
  creator_vesting_weeks SMALLINT NOT NULL CHECK (creator_vesting_weeks BETWEEN 1 AND 520),
  liquidity_unlock_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'active', 'failed')),
  launched_at TIMESTAMPTZ,
  creator_tokens_released_atomic NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (creator_tokens_released_atomic >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (creator_allocation_atomic + liquidity_allocation_atomic = supply_atomic),
  CHECK (creator_tokens_released_atomic <= creator_allocation_atomic),
  CHECK ((state = 'active') = (launched_at IS NOT NULL))
);

CREATE TABLE charter_launch_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES charters(user_id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE charter_launch_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES charter_launch_operations(id) ON DELETE RESTRICT,
  token_mint TEXT NOT NULL,
  signed_transaction BYTEA NOT NULL,
  transaction_signature TEXT NOT NULL UNIQUE,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX charter_launch_attempts_pending_idx ON charter_launch_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');

CREATE TABLE charter_vesting_weeks (
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  user_id UUID NOT NULL REFERENCES charters(user_id) ON DELETE RESTRICT,
  week_number SMALLINT NOT NULL CHECK (week_number > 0),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  sla_met BOOLEAN,
  funded_jobs_due INTEGER NOT NULL DEFAULT 0 CHECK (funded_jobs_due >= 0),
  jobs_completed_on_time INTEGER NOT NULL DEFAULT 0 CHECK (jobs_completed_on_time >= 0 AND jobs_completed_on_time <= funded_jobs_due),
  eligible_amount_atomic NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (eligible_amount_atomic >= 0),
  claimed_amount_atomic NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (claimed_amount_atomic >= 0),
  evaluated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week_number),
  CHECK (period_end > period_start),
  CHECK ((sla_met IS NULL AND evaluated_at IS NULL) OR (sla_met IS NOT NULL AND evaluated_at IS NOT NULL)),
  CHECK (claimed_amount_atomic <= eligible_amount_atomic)
);

CREATE TABLE charter_token_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES charters(user_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('creator_vesting', 'buyback_burn', 'liquidity_release')),
  reference_id UUID NOT NULL,
  input_mint TEXT,
  output_mint TEXT NOT NULL,
  amount_atomic NUMERIC(30, 0) NOT NULL CHECK (amount_atomic > 0),
  destination_wallet TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'submitted', 'confirmed', 'failed')),
  transaction_signature TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, reference_id)
);
CREATE INDEX charter_token_operations_queue_idx ON charter_token_operations (created_at)
  WHERE state IN ('queued', 'submitted', 'failed');

CREATE TABLE charter_token_operation_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES charter_token_operations(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX charter_token_attempts_pending_idx ON charter_token_operation_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');

CREATE TABLE charter_buybacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES charters(user_id) ON DELETE RESTRICT,
  work_record_id UUID NOT NULL REFERENCES work_records(id) ON DELETE RESTRICT,
  asset_mint TEXT NOT NULL,
  amount_atomic NUMERIC(30, 0) NOT NULL CHECK (amount_atomic > 0),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'swapped', 'burned', 'failed')),
  swap_signature TEXT UNIQUE,
  burn_signature TEXT UNIQUE,
  token_amount_atomic NUMERIC(30, 0) CHECK (token_amount_atomic IS NULL OR token_amount_atomic > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_record_id),
  CHECK ((state IN ('swapped', 'burned')) = (swap_signature IS NOT NULL AND token_amount_atomic IS NOT NULL)),
  CHECK ((state = 'burned') = (burn_signature IS NOT NULL))
);
CREATE INDEX charter_buybacks_queue_idx ON charter_buybacks (created_at)
  WHERE state IN ('queued', 'swapped', 'failed');
