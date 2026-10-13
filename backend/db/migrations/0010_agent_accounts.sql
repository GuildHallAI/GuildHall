CREATE TABLE agent_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL UNIQUE REFERENCES wallet_users(id) ON DELETE RESTRICT,
  public_key TEXT NOT NULL UNIQUE,
  encrypted_secret_key BYTEA NOT NULL,
  encryption_nonce BYTEA NOT NULL,
  encryption_auth_tag BYTEA NOT NULL,
  encryption_key_version SMALLINT NOT NULL DEFAULT 1 CHECK (encryption_key_version = 1),
  cluster TEXT NOT NULL CHECK (cluster IN ('localnet', 'devnet', 'testnet', 'mainnet-beta')),
  max_action_atomic NUMERIC(20, 0) NOT NULL CHECK (max_action_atomic > 0),
  daily_budget_atomic NUMERIC(20, 0) NOT NULL CHECK (daily_budget_atomic >= max_action_atomic),
  allowed_mints TEXT[] NOT NULL CHECK (cardinality(allowed_mints) BETWEEN 1 AND 2),
  allowed_programs TEXT[] NOT NULL CHECK (cardinality(allowed_programs) BETWEEN 1 AND 4),
  expires_at TIMESTAMPTZ NOT NULL,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_api_keys_active_idx ON agent_api_keys (account_id) WHERE revoked_at IS NULL;

CREATE TABLE agent_daily_spend (
  account_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  usage_date DATE NOT NULL,
  spent_atomic NUMERIC(20, 0) NOT NULL DEFAULT 0 CHECK (spent_atomic >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, usage_date)
);

CREATE TABLE agent_transfer_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES agent_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL DEFAULT 'transfer' CHECK (operation_kind IN ('transfer', 'recovery')),
  mint TEXT NOT NULL,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic > 0),
  destination_wallet TEXT NOT NULL,
  usage_date DATE NOT NULL,
  budget_reserved BOOLEAN NOT NULL DEFAULT true,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed')),
  transaction_signature TEXT UNIQUE,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);

CREATE TABLE agent_transfer_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES agent_transfer_operations(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_transfer_attempts_pending_idx ON agent_transfer_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');
CREATE INDEX agent_transfer_operations_pending_idx ON agent_transfer_operations (created_at)
  WHERE state IN ('pending', 'submitted');
