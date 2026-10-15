ALTER TABLE agent_runtime_tokens
  ADD COLUMN expires_at TIMESTAMPTZ;

UPDATE agent_runtime_tokens
   SET expires_at = created_at + INTERVAL '90 days'
 WHERE expires_at IS NULL AND revoked_at IS NULL;

CREATE INDEX agent_runtime_tokens_expiry_idx
  ON agent_runtime_tokens (expires_at)
  WHERE revoked_at IS NULL;
