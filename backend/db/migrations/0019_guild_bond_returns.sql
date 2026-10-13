CREATE TABLE guild_bond_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id UUID NOT NULL UNIQUE REFERENCES guild_bond_deposits(id) ON DELETE RESTRICT,
  guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic > 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'submitted', 'confirmed', 'failed')),
  transaction_signature TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guild_bond_returns_pending_idx ON guild_bond_returns (created_at)
  WHERE state IN ('pending', 'submitted', 'failed');

CREATE TABLE guild_bond_return_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id UUID NOT NULL REFERENCES guild_bond_returns(id) ON DELETE RESTRICT,
  transaction_signature TEXT NOT NULL UNIQUE,
  signed_transaction BYTEA NOT NULL,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guild_bond_return_attempts_pending_idx ON guild_bond_return_attempts (updated_at)
  WHERE state IN ('prepared', 'submitted');
