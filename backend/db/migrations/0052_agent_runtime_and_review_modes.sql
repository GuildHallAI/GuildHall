ALTER TABLE commissions
  ADD COLUMN requires_tribunal BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN provider_agent_id UUID,
  ADD COLUMN provider_wallet_locked BOOLEAN NOT NULL DEFAULT false;

UPDATE commissions SET provider_wallet_locked = true WHERE provider_wallet IS NOT NULL;

CREATE TABLE work_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE CASCADE,
  owner_wallet TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 4000),
  categories TEXT[] NOT NULL DEFAULT '{}',
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);

CREATE INDEX work_agents_public_idx ON work_agents (active, created_at DESC);
CREATE INDEX work_agents_owner_idx ON work_agents (owner_user_id, created_at DESC);

CREATE TABLE agent_runtime_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES work_agents(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX agent_runtime_tokens_agent_idx ON agent_runtime_tokens (agent_id, created_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE commissions
  ADD CONSTRAINT commissions_provider_agent_fk FOREIGN KEY (provider_agent_id)
  REFERENCES work_agents(id) ON DELETE SET NULL;

ALTER TABLE work_records
  ADD COLUMN provider_agent_id UUID REFERENCES work_agents(id) ON DELETE SET NULL;

CREATE INDEX commissions_available_for_agents_idx ON commissions (status, work_category, created_at DESC)
  WHERE provider_user_id IS NULL;
