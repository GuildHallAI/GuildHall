CREATE TABLE bounty_evaluator_assignments (
  commission_id UUID NOT NULL REFERENCES bounties(commission_id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES wallet_users(id) ON DELETE RESTRICT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  PRIMARY KEY (commission_id, user_id)
);
CREATE INDEX bounty_evaluator_assignments_active_idx ON bounty_evaluator_assignments (user_id)
  WHERE released_at IS NULL;
