CREATE TABLE guilds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 3000),
  sla_hours SMALLINT NOT NULL CHECK (sla_hours BETWEEN 1 AND 8760),
  bond_target_atomic NUMERIC(20, 0) NOT NULL CHECK (bond_target_atomic > 0),
  bond_wallet_public_key TEXT NOT NULL UNIQUE,
  encrypted_secret_key BYTEA NOT NULL,
  encryption_nonce BYTEA NOT NULL,
  encryption_auth_tag BYTEA NOT NULL,
  encryption_key_version SMALLINT NOT NULL DEFAULT 1 CHECK (encryption_key_version = 1),
  cluster TEXT NOT NULL CHECK (cluster IN ('localnet', 'devnet', 'testnet', 'mainnet-beta')),
  bond_mint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'forming' CHECK (status IN ('forming', 'active', 'paused', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);

CREATE TABLE guild_members (
  guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('lead', 'member')),
  share_bps SMALLINT NOT NULL DEFAULT 0 CHECK (share_bps BETWEEN 0 AND 10000),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE UNIQUE INDEX guild_single_lead_idx ON guild_members (guild_id) WHERE role = 'lead';
CREATE INDEX guild_members_user_idx ON guild_members (user_id, joined_at DESC);

CREATE TABLE guild_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT,
  invited_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  UNIQUE (guild_id, invited_user_id),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);

CREATE TABLE guild_bond_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT,
  depositor_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  depositor_wallet TEXT NOT NULL,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic > 0),
  transaction_signature TEXT UNIQUE,
  recent_blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((transaction_signature IS NULL) = (confirmed_at IS NULL))
);
CREATE UNIQUE INDEX guild_one_pending_bond_idx ON guild_bond_deposits (guild_id) WHERE confirmed_at IS NULL;

CREATE TABLE guild_commissions (
  commission_id UUID PRIMARY KEY REFERENCES commissions(id) ON DELETE RESTRICT,
  guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT,
  lead_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  sla_hours SMALLINT NOT NULL CHECK (sla_hours BETWEEN 1 AND 8760),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guild_commissions_guild_idx ON guild_commissions (guild_id, created_at DESC);
