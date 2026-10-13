CREATE TABLE wallet_registry_agents (
  user_id UUID PRIMARY KEY REFERENCES wallet_users(id) ON DELETE RESTRICT,
  agent_asset TEXT NOT NULL UNIQUE,
  ownership_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE registry_feedback_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id UUID NOT NULL UNIQUE REFERENCES work_record_feedback(id) ON DELETE RESTRICT,
  agent_asset TEXT NOT NULL,
  reviewer_user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'prepared', 'submitted', 'confirmed', 'failed')),
  prepared_transaction TEXT,
  recent_blockhash TEXT,
  last_valid_block_height BIGINT,
  transaction_signature TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (state NOT IN ('prepared', 'submitted') OR
    (prepared_transaction IS NOT NULL AND recent_blockhash IS NOT NULL AND last_valid_block_height IS NOT NULL)),
  CHECK ((state IN ('submitted', 'confirmed')) = (transaction_signature IS NOT NULL))
);
CREATE INDEX registry_feedback_pending_idx ON registry_feedback_operations (created_at)
  WHERE state IN ('pending', 'prepared', 'submitted', 'failed');
