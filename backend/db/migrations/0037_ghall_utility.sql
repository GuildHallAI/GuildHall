CREATE TABLE ghall_stake_accounts (
  user_id UUID PRIMARY KEY REFERENCES wallet_users(id) ON DELETE RESTRICT,
  stake_wallet_public_key TEXT NOT NULL UNIQUE,
  encrypted_secret_key BYTEA NOT NULL,
  encryption_nonce BYTEA NOT NULL,
  encryption_auth_tag BYTEA NOT NULL,
  encryption_key_version SMALLINT NOT NULL CHECK (encryption_key_version = 1),
  cluster TEXT NOT NULL CHECK (cluster IN ('localnet', 'devnet', 'testnet', 'mainnet-beta')),
  mint TEXT NOT NULL,
  stake_atomic NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (stake_atomic >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ghall_stake_deposits (
  signature TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES ghall_stake_accounts(user_id) ON DELETE RESTRICT,
  source_wallet TEXT NOT NULL,
  amount_atomic NUMERIC(30, 0) NOT NULL CHECK (amount_atomic > 0),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ghall_stake_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES ghall_stake_accounts(user_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  destination_wallet TEXT NOT NULL,
  amount_atomic NUMERIC(30, 0) NOT NULL CHECK (amount_atomic > 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed')),
  transaction_signature TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE ghall_stake_withdrawal_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id UUID NOT NULL REFERENCES ghall_stake_withdrawals(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ghall_stake_withdrawals_pending_idx ON ghall_stake_withdrawals (created_at)
  WHERE state IN ('pending', 'submitted', 'failed');
CREATE INDEX ghall_stake_withdrawal_attempts_pending_idx ON ghall_stake_withdrawal_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');

CREATE TABLE ghall_listing_allocations (
  user_id UUID PRIMARY KEY REFERENCES ghall_stake_accounts(user_id) ON DELETE RESTRICT,
  agent_asset TEXT NOT NULL UNIQUE,
  amount_atomic NUMERIC(30, 0) NOT NULL CHECK (amount_atomic > 0),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ghall_front_page_listings_idx ON ghall_listing_allocations (amount_atomic DESC, updated_at)
  WHERE active = true;

CREATE TABLE ghall_governance_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 10000),
  rule_key TEXT NOT NULL CHECK (rule_key IN ('warden_appeal_hours', 'panel_appeal_hours')),
  proposed_value INTEGER NOT NULL CHECK (proposed_value BETWEEN 1 AND 168),
  quorum_atomic NUMERIC(30, 0) NOT NULL CHECK (quorum_atomic > 0),
  voting_opens_at TIMESTAMPTZ NOT NULL,
  voting_closes_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'passed', 'rejected', 'cancelled')),
  yes_atomic NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (yes_atomic >= 0),
  no_atomic NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (no_atomic >= 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (voting_closes_at > voting_opens_at)
);

CREATE TABLE ghall_governance_votes (
  proposal_id UUID NOT NULL REFERENCES ghall_governance_proposals(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES ghall_stake_accounts(user_id) ON DELETE RESTRICT,
  vote TEXT NOT NULL CHECK (vote IN ('yes', 'no')),
  weight_atomic NUMERIC(30, 0) NOT NULL CHECK (weight_atomic > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, user_id)
);

CREATE TABLE ghall_governance_settings (
  rule_key TEXT PRIMARY KEY CHECK (rule_key IN ('warden_appeal_hours', 'panel_appeal_hours')),
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 168),
  proposal_id UUID NOT NULL UNIQUE REFERENCES ghall_governance_proposals(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
