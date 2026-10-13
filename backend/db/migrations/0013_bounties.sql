CREATE TABLE bounties (
  commission_id UUID PRIMARY KEY REFERENCES commissions(id) ON DELETE RESTRICT,
  bond_atomic NUMERIC(20, 0) NOT NULL CHECK (bond_atomic > 0),
  max_entries SMALLINT NOT NULL CHECK (max_entries BETWEEN 1 AND 100),
  evaluator_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  evaluator_assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evaluated_at TIMESTAMPTZ,
  evaluation_rationale TEXT CHECK (evaluation_rationale IS NULL OR char_length(evaluation_rationale) BETWEEN 1 AND 10000),
  winning_entry_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bounty_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL REFERENCES bounties(commission_id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  wallet_address TEXT NOT NULL,
  bond_wallet_public_key TEXT NOT NULL UNIQUE,
  encrypted_secret_key BYTEA NOT NULL,
  bond_encryption_nonce BYTEA NOT NULL,
  bond_encryption_auth_tag BYTEA NOT NULL,
  bond_encryption_key_version SMALLINT NOT NULL DEFAULT 1 CHECK (bond_encryption_key_version = 1),
  cluster TEXT NOT NULL CHECK (cluster IN ('localnet', 'devnet', 'testnet', 'mainnet-beta')),
  bond_atomic NUMERIC(20, 0) NOT NULL CHECK (bond_atomic > 0),
  bond_recent_blockhash TEXT,
  bond_last_valid_block_height BIGINT,
  bond_signature TEXT UNIQUE,
  bond_confirmed_at TIMESTAMPTZ,
  bond_returned_at TIMESTAMPTZ,
  encrypted_payload BYTEA,
  encryption_nonce BYTEA,
  encryption_auth_tag BYTEA,
  encryption_key_version SMALLINT CHECK (encryption_key_version = 1),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (commission_id, user_id),
  CHECK ((bond_signature IS NULL) = (bond_confirmed_at IS NULL)),
  CHECK ((bond_recent_blockhash IS NULL AND bond_last_valid_block_height IS NULL)
      OR (bond_recent_blockhash IS NOT NULL AND bond_last_valid_block_height IS NOT NULL)),
  CHECK ((encrypted_payload IS NULL AND encryption_nonce IS NULL AND encryption_auth_tag IS NULL
          AND encryption_key_version IS NULL AND submitted_at IS NULL)
      OR (encrypted_payload IS NOT NULL AND encryption_nonce IS NOT NULL AND encryption_auth_tag IS NOT NULL
          AND encryption_key_version IS NOT NULL AND encryption_key_version = 1 AND submitted_at IS NOT NULL))
);
ALTER TABLE bounties ADD CONSTRAINT bounties_winning_entry_fk
  FOREIGN KEY (winning_entry_id) REFERENCES bounty_entries(id) ON DELETE RESTRICT;
CREATE INDEX bounty_entries_unreturned_idx ON bounty_entries (commission_id, created_at)
  WHERE bond_confirmed_at IS NOT NULL AND bond_returned_at IS NULL;

CREATE TABLE bounty_bond_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL UNIQUE REFERENCES bounty_entries(id) ON DELETE RESTRICT,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic >= 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed', 'empty')),
  transaction_signature TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE bounty_bond_operation_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES bounty_bond_operations(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bounty_bond_operations_pending_idx ON bounty_bond_operations (updated_at)
  WHERE state IN ('pending', 'submitted', 'failed');

CREATE TABLE bounty_rankings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id UUID NOT NULL REFERENCES bounties(commission_id) ON DELETE RESTRICT,
  entry_id UUID NOT NULL REFERENCES bounty_entries(id) ON DELETE RESTRICT,
  evaluator_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  rank SMALLINT NOT NULL CHECK (rank > 0),
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (commission_id, rank),
  UNIQUE (commission_id, entry_id)
);
