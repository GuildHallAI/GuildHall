CREATE TABLE evaluator_profiles (
  user_id UUID PRIMARY KEY REFERENCES wallet_users(id) ON DELETE RESTRICT,
  stake_wallet_public_key TEXT NOT NULL UNIQUE,
  encrypted_secret_key BYTEA NOT NULL,
  encryption_nonce BYTEA NOT NULL,
  encryption_auth_tag BYTEA NOT NULL,
  encryption_key_version SMALLINT NOT NULL DEFAULT 1 CHECK (encryption_key_version = 1),
  cluster TEXT NOT NULL CHECK (cluster IN ('localnet', 'devnet', 'testnet', 'mainnet-beta')),
  stake_mint TEXT NOT NULL,
  stake_atomic NUMERIC(20, 0) NOT NULL DEFAULT 0 CHECK (stake_atomic >= 0),
  active BOOLEAN NOT NULL DEFAULT false,
  max_concurrent_cases SMALLINT NOT NULL DEFAULT 3 CHECK (max_concurrent_cases BETWEEN 1 AND 20),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX evaluator_profiles_active_stake_idx
  ON evaluator_profiles (stake_atomic DESC, registered_at)
  WHERE active = true;

CREATE TABLE evaluator_stake_deposits (
  signature TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  source_wallet TEXT NOT NULL,
  amount_atomic NUMERIC(20, 0) NOT NULL CHECK (amount_atomic > 0),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vetted_tribunal_jurors (
  user_id UUID PRIMARY KEY REFERENCES wallet_users(id) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT true,
  max_concurrent_cases SMALLINT NOT NULL DEFAULT 2 CHECK (max_concurrent_cases BETWEEN 1 AND 10),
  vetted_by TEXT NOT NULL,
  vetted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX vetted_tribunal_jurors_active_idx ON vetted_tribunal_jurors (user_id) WHERE active = true AND revoked_at IS NULL;

ALTER TABLE tribunal_cases
  DROP CONSTRAINT tribunal_cases_stage_check,
  ADD CONSTRAINT tribunal_cases_stage_check
    CHECK (stage IN ('unassigned', 'warden', 'panel', 'bench', 'decided', 'cancelled')),
  ALTER COLUMN stage SET DEFAULT 'unassigned',
  ADD COLUMN warden_user_id UUID REFERENCES wallet_users(id),
  ADD COLUMN appealed_by UUID REFERENCES wallet_users(id),
  ADD COLUMN appeal_deadline_at TIMESTAMPTZ,
  ADD COLUMN updated_by UUID REFERENCES wallet_users(id),
  ADD COLUMN warden_verdict TEXT CHECK (warden_verdict IN ('client', 'provider', 'split', 'dismissed')),
  ADD COLUMN panel_verdict TEXT CHECK (panel_verdict IN ('client', 'provider', 'split', 'dismissed')),
  ADD COLUMN panel_decided_at TIMESTAMPTZ,
  ADD COLUMN appeal_rationale TEXT;

ALTER TABLE tribunal_assignments
  ADD COLUMN assignment_reason TEXT NOT NULL DEFAULT 'stake_capacity',
  ADD COLUMN released_at TIMESTAMPTZ;

CREATE INDEX tribunal_assignments_active_user_idx
  ON tribunal_assignments (user_id, tier) WHERE released_at IS NULL;

CREATE TABLE tribunal_ai_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES tribunal_cases(id) ON DELETE RESTRICT,
  model_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('client', 'provider', 'split', 'dismissed')),
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 10000),
  response_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, model_id)
);
